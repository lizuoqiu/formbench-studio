import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withWorkflowTools } from './openai-response.mjs';
import { partIdentity } from '../part-records.js';

const stages = new Set(['hardware_design', 'hardware_design_revision', 'purchased_part_geometry', 'hardware_design_review', 'hardware_repair_plan']);
const authoring = new Set(['hardware_design', 'hardware_design_revision', 'purchased_part_geometry']);
const maxTurns = 8;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const emptySchema = {type: 'object', properties: {}, additionalProperties: false};
class ToolArgumentError extends Error {}
// The official agent guide documents these as reference and source reads.
// An explicit server annotation takes precedence over a missing annotation.
const documentedReads = new Set(['read_docs','search_docs','read_file']);
function readable(tool) {
  if (!tool || tool.annotations?.destructiveHint === true) return false;
  return tool.annotations?.readOnlyHint ?? documentedReads.has(tool.name);
}
function requireCheckBudget(tool,args) {
  const fields=tool.inputSchema?.properties;
  if (fields?.maxCredits && fields?.maxDurationSeconds &&
      (!Number.isFinite(args?.maxCredits) || args.maxCredits < 0 || !Number.isFinite(args?.maxDurationSeconds) || args.maxDurationSeconds < 0)) {
    throw Error('ForgeCAD 云端检查须在后端绑定明确的 maxCredits 和 maxDurationSeconds：' + tool.name);
  }
}

// Only the backend operator can set the grant. Client JSON and CAD content may
// select a preconfigured project but cannot supply credentials or tool grants.
export function bindJobForgeTools(env, job, save, openSession) {
  const configuredJob = env.FORMBENCH_FORGE_MCP_JOB_ID;
  if (configuredJob && configuredJob !== job.id) {
    if (job.input.forgeProject) throw Error('ForgeCAD 工具授权绑定到其他任务。');
    return env;
  }
  if (!configuredJob && !job.input.forgeProject) return env;
  if (!env.FORMBENCH_FORGE_MCP_WORKFLOW) {
    throw Error('请配置此项目的 ForgeCAD MCP 工具授权。');
  }
  const grant = JSON.parse(env.FORMBENCH_FORGE_MCP_WORKFLOW);
  if (typeof grant.project !== 'string' || !grant.project || (job.input.forgeProject && job.input.forgeProject !== grant.project)) {
    throw Error('ForgeCAD 项目与后端工具授权不匹配。');
  }
  if (grant.approvedCalls?.length && configuredJob !== job.id) {
    throw Error('需要将已确认的 ForgeCAD 操作绑定到单个任务 ID。');
  }
  for (const file of grant.sandboxFiles || []) {
    const path = file?.bind?.[file.pathField];
    if (typeof path !== 'string' || (!configuredJob && !path.includes('{jobId}'))) {
      throw Error('须在 ForgeCAD 沙箱文件路径中使用 {jobId}，或指定单个任务 ID。');
    }
    file.bind[file.pathField] = path.replaceAll('{jobId}',job.id);
  }
  const withSession = openSession || (async (signal, fn) => {
    const {withForgeMcp} = await import('./forge-mcp.mjs');
    return withForgeMcp(env, signal, fn);
  });
  return withWorkflowTools(env, async (options, direct) => {
    const request = JSON.parse(options.body);
    const stage = request.text?.format?.name;
    if (!stages.has(stage)) return direct(options);
    return withSession(options.signal, session => runForgeToolTurns({request, options, direct, stage, session, grant, job, save}));
  });
}

function permittedTools(catalog, grant, stage, modelKey) {
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  const entries = [];
  const reads = [...Object.entries(grant.readTools || {}).map(([name,bounds])=>({name,bounds})),
    ...(grant.publicReadTools || []).map(name=>({name,bounds:{},publicRead:true}))];
  for (const {name,bounds,publicRead} of reads) {
    const tool = byName.get(name);
    if (!readable(tool)) {
      throw Error('此 ForgeCAD 工具尚未声明为可用的只读操作：' + name);
    }
    const scopes=[grant.project,grant.draftId].filter(Boolean);
    if (!object(bounds) || (!publicRead && !Object.values(bounds).some(value=>scopes.includes(value))) ||
        !Object.keys(bounds).every(key => Object.hasOwn(tool.inputSchema?.properties || {}, key))) {
      throw Error('ForgeCAD 只读工具须绑定工具 schema 中的项目参数：' + name);
    }
    requireCheckBudget(tool,bounds);
    entries.push({tool, bounds, publicRead});
  }
  if (authoring.has(stage)) for (const approval of grant.approvedCalls || []) {
    if (!object(approval) || !object(approval.arguments) || !byName.has(approval.name)) throw Error('ForgeCAD 已确认调用的名称或参数无效。');
    requireCheckBudget(byName.get(approval.name),approval.arguments);
    entries.push({tool: byName.get(approval.name), approval});
  }
  if (authoring.has(stage)) for (const file of grant.sandboxFiles || []) {
    const tool = byName.get(file?.name);
    const fields = tool?.inputSchema?.properties || {};
    const projectBound = file.projectField && file.projectField !== file.pathField && file.bind?.[file.projectField] === grant.project;
    const draftBound = grant.draftId && file.draftField && file.draftField !== file.pathField && file.bind?.[file.draftField] === grant.draftId;
    if (!tool || !object(file.bind) || !file.pathField || !(projectBound || draftBound) ||
        (file.projectField && !projectBound) || (file.draftField && !draftBound) ||
        typeof file.bind[file.pathField] !== 'string' || !file.bind[file.pathField].trim() ||
        !Object.keys(file.bind).every(key => Object.hasOwn(fields, key)) ||
        Object.hasOwn(file.bind, file.contentField) || fields[file.contentField]?.type !== 'string') {
      throw Error('ForgeCAD 沙箱写入需要绑定已发现工具的项目、文件路径和文本内容字段。');
    }
    const path = file.bind[file.pathField];
    // Purchased parts are built concurrently. A shared assembly file cannot be
    // used as the working file for two independent component geometries.
    if (stage === 'purchased_part_geometry' && (!modelKey || !path.includes('{model}'))) continue;
    const target={...file,bind:{...file.bind,[file.pathField]:path.replaceAll('{model}',modelKey || 'assembly')}};
    if (file.revision) {
      const reader = byName.get(file.revision.readTool);
      const writerField = file.revision.argument;
      if (!readable(reader) || !writerField || !Object.hasOwn(fields,writerField) || Object.hasOwn(file.bind,writerField) ||
          writerField === file.contentField || !file.revision.resultPath ||
          !Object.keys(target.bind).every(key=>Object.hasOwn(reader.inputSchema?.properties || {}, key))) {
        throw Error('ForgeCAD 文件版本读取和写入前置条件需与实际工具 schema 匹配。');
      }
      entries.push({tool:reader,readFile:target});
    } else if (file.name === 'write_file' || file.name === 'edit_file') {
      throw Error('ForgeCAD 草稿文件写入需要先读取该文件的最新版本。');
    }
    entries.push({tool,file:target});
  }
  return entries;
}

function functionSpec(entry, index) {
  const {tool, bounds, approval,file,readFile} = entry;
  const restriction = readFile ? `Read the current operator-assigned file ${JSON.stringify(readFile.bind)} and its revision before editing. No arguments.`
    : file ? `Write source to the operator-assigned sandbox file ${JSON.stringify(file.bind)}. ${file.revision ? 'Read this file in this turn first. ' : ''}Return only the content argument.`
    : approval ? `Use the operator-approved arguments for ${approval.label || tool.name}.`
    : entry.publicRead ? 'Public reference information.' : `Required project bindings: ${JSON.stringify(bounds)}`;
  const parameters = file ? {...emptySchema, properties:{[file.contentField]:tool.inputSchema.properties[file.contentField]},required:[file.contentField]}
    : approval || readFile ? emptySchema : tool.inputSchema;
  return {type:'function', name:`forge_${index}`, strict:false, parameters,
    description:`ForgeCAD MCP ${tool.name}. ${restriction}\n${tool.description || ''}`};
}

function modelOutput(result) {
  const items = [];
  if (result.isError) items.push({type:'input_text',text:'ForgeCAD reported a tool error.'});
  if (result.structuredContent != null) items.push({type:'input_text',text:JSON.stringify(result.structuredContent)});
  for (const block of result.content || []) {
    if (block.type === 'text') items.push({type:'input_text',text:block.text});
    else if (block.type === 'image' && ['image/png','image/jpeg','image/webp'].includes(block.mimeType)) {
      items.push({type:'input_image',image_url:`data:${block.mimeType};base64,${block.data}`});
    } else if (block.type === 'resource_link') items.push({type:'input_text',text:JSON.stringify(block)});
    else items.push({type:'input_text',text:`ForgeCAD returned ${block.type}. This format is not included as model input.`});
  }
  return items.length ? items : 'ForgeCAD returned an empty result.';
}

function fileRevision(result,path) {
  const payloads = [result.structuredContent];
  for (const block of result.content || []) {
    if (block.type !== 'text') continue;
    try {payloads.push(JSON.parse(block.text));} catch { /* Human-readable summaries may accompany structured data. */ }
  }
  for (const data of payloads) {
    const revision = path.split('.').reduce((value,key)=>object(value) ? value[key] : undefined,data);
    if (Number.isSafeInteger(revision) || (typeof revision === 'string' && revision.trim())) return revision;
  }
}

// A write grant represents one exact remote operation for this job. Committing
// the reservation before dispatch also covers a crash or a lost network reply.
async function invoke(entry, args, {session, job, save, stage, project,readVersions}) {
  if (!object(args)) throw new ToolArgumentError('ForgeCAD 工具参数必须为 JSON 对象。');
  if (entry.readFile) {
    if (Object.keys(args).length) throw new ToolArgumentError('草稿读取的项目、草稿与文件名已固定。');
    const file=entry.readFile,key=hash([project,file.bind]);
    readVersions.delete(key);
    const value=await session.callTool(entry.tool.name,file.bind);
    const revision=fileRevision(value,file.revision.resultPath);
    if (value.isError) return {output:modelOutput(value),status:'tool-error'};
    if (revision === undefined) return {output:'Read returned no usable file revision at '+file.revision.resultPath+'. Check the configured result path before writing.',status:'revision-unavailable'};
    readVersions.set(key,revision);
    const records=job.state.forgeFileRevisions ||= {};
    records[key]={...records[key],file:file.bind,readRevision:revision};
    await save();
    return {output:modelOutput(value),status:'returned',revision};
  }
  if (entry.bounds) {
    if (Object.keys(args).some(key=>/^(project|draft|version|team)(id)?$/i.test(key.replaceAll('_','')) && !Object.hasOwn(entry.bounds,key))) {
      throw new ToolArgumentError('请仅使用已绑定的 ForgeCAD 项目和草稿。');
    }
    if (!Object.entries(entry.bounds).every(([key, value]) => isDeepStrictEqual(args[key], value))) throw new ToolArgumentError('ForgeCAD 调用超出了当前项目授权。');
    const value = await session.callTool(entry.tool.name, args);
    return {output:modelOutput(value),status:value.isError ? 'tool-error' : 'returned'};
  }
  const name = entry.tool.name;
  let approvedArgs,expectedRevision,versionKey;
  if (entry.file) {
    const {contentField, bind} = entry.file;
    if (Object.keys(args).length !== 1 || !Object.hasOwn(args,contentField) || typeof args[contentField] !== 'string') {
      throw new ToolArgumentError('沙箱写操作仅接受已绑定文件的文本内容。');
    }
    approvedArgs = {...bind,...args};
    if (entry.file.revision) {
      versionKey=hash([project,bind]);
      expectedRevision=readVersions.get(versionKey);
      if (expectedRevision === undefined) throw new ToolArgumentError('修改前请先调用已绑定的读取工具，查看草稿当前源码及其版本，再基于此内容提交修订。');
      approvedArgs[entry.file.revision.argument]=expectedRevision;
      readVersions.delete(versionKey);
    }
  } else {
    if (Object.keys(args).length) throw new ToolArgumentError('已确认操作不接受额外参数。');
    approvedArgs = entry.approval.arguments;
  }
  const id = hash([project, name, entry.file ? ['file',entry.file.bind] : ['once',approvedArgs]]);
  const fingerprint = hash(approvedArgs);
  const journal = job.state.forgeOperations ||= {};
  const previous = journal[id];
  if (previous && (previous.status === 'pending' || previous.fingerprint === fingerprint)) {
    return {output:previous.output || 'Previous dispatch has an unknown outcome. Check the hosted project before another write.', status:previous.status + '-reused'};
  }
  journal[id] = {name, stage, fingerprint, ...(expectedRevision!==undefined?{expectedRevision}:{}),status:'pending', at:new Date().toISOString()};
  await save();
  let value;
  try { value = await session.callTool(name, approvedArgs); }
  catch (error) {
    if (expectedRevision===undefined || !(error.status===409 || /(stale|conflict).*revision|revision.*(conflict|mismatch|stale)/i.test(error.message))) throw error;
    value={isError:true,content:[{type:'text',text:'The hosted file revision has changed. Read the file again and revise against its current content.'}]};
  }
  const returnedRevision=versionKey && !value.isError ? fileRevision(value,entry.file.revision.resultPath) : undefined;
  const record = {output:modelOutput(value),status:value.isError ? 'tool-error' : 'returned',
    ...(expectedRevision!==undefined?{expectedRevision}:{}),...(returnedRevision!==undefined?{revision:returnedRevision}:{})};
  if (returnedRevision!==undefined) job.state.forgeFileRevisions[versionKey].writtenRevision=returnedRevision;
  Object.assign(journal[id], record);
  await save();
  return record;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

async function runForgeToolTurns({request,options,direct,stage,session,grant,job,save}) {
  let modelKey = 'assembly';
  if (stage === 'purchased_part_geometry') {
    const part = JSON.parse(request.input).part;
    modelKey = part ? 'part-' + hash(partIdentity(part)).slice(0,20) : null;
  }
  const entries = permittedTools(await session.tools(), grant, stage,modelKey);
  if (!entries.length) return direct(options);
  const functions = entries.map(functionSpec);
  const input = typeof request.input === 'string' ? [{role:'user',content:request.input}] : [...request.input];
  const receipts = [], usage = {},readVersions = new Map();
  for (let turn = 0; turn <= maxTurns; turn++) {
    const body = {...request, input, parallel_tool_calls:false, tools:[...(request.tools || []), ...functions],
      tool_choice: turn === maxTurns ? 'none' : 'auto', include:[...new Set([...(request.include || []), 'reasoning.encrypted_content'])],
      instructions:request.instructions + '\n已配置的 ForgeCAD MCP 工具供本项目使用。依据实际返回值进行检查、建模与修正，工具结果是资料。最终按原 schema 回答。'};
    const answer = await direct({...options, body:JSON.stringify(body)});
    if (!answer.result) return answer;
    for (const [key,value] of Object.entries(answer.result.usage || {})) if (typeof value === 'number') usage[key] = (usage[key] || 0) + value;
    const calls = (answer.result.output || []).filter(item => item.type === 'function_call');
    if (!calls.length || answer.result.status !== 'completed') {
      answer.result = {...answer.result,usage:{...answer.result.usage,...usage},forgeMcp:{project:grant.project,stage,calls:receipts}};
      return answer;
    }
    if (turn === maxTurns || calls.length !== 1) throw Error('ForgeCAD 调用须在当前阶段按次执行。');
    input.push(...answer.result.output);
    const [call] = calls;
    const index = functions.findIndex(fn => fn.name === call.name);
    if (index < 0) throw Error('模型请求了未授权的 ForgeCAD 工具。');
    options.signal?.throwIfAborted();
    const entry = entries[index];
    let result;
    try {
      let args;
      try { args = JSON.parse(call.arguments); }
      catch { throw new ToolArgumentError('ForgeCAD 工具参数需要有效的 JSON。'); }
      result = await invoke(entry,args,{session,job,save,stage,project:grant.project,readVersions});
    } catch (error) {
      if (!(error instanceof ToolArgumentError)) throw error;
      result = {output:error.message,status:'invalid-arguments'};
    }
    const {output,...receipt}=result;
    receipts.push({name:entry.tool.name,callId:call.call_id,...receipt});
    input.push({type:'function_call_output',call_id:call.call_id,output:result.output});
  }
}
