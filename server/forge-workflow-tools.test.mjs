import test from 'node:test';
import assert from 'node:assert/strict';
import {bindJobForgeTools} from './forge-workflow-tools.mjs';
import {structuredCall,format} from './design-review.mjs';
import {designJobs} from './design-jobs.mjs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withForgeMcp} from './forge-mcp.mjs';

const baseEnv = {OPENAI_MODEL:'test',OPENAI_API_KEY:'fixture',FORGECAD_MCP_ACCESS_TOKEN:'private-fixture'};
const project='test-project';
const schema = {type:'object',properties:{project_id:{type:'string'}}};
const catalog=[{name:'inspect_version',annotations:{readOnlyHint:true},inputSchema:schema}, {name:'sandbox_edit',inputSchema:schema}];
const readGrant={project,readTools:{inspect_version:{project_id:project}}};
const signal = () => new AbortController().signal;
const makeJob = () => ({id:'id1',input:{forgeProject:project},state:{}});
const requestBody = {input:'fixture design',instructions:'fixture',text:format('hardware_design',{type:'object'})};
function provider(turn, args, name='forge_0') {
  const output=turn===0?[{type:'reasoning',id:'r',encrypted_content:'encrypted'}, {type:'function_call',name,call_id:'cad-call',arguments:JSON.stringify(args)}]:
    [{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}];
  return Response.json({status:'completed',model:'test',usage:{total_tokens:3},output});
}

test('configured design stage calls a real protocol-shaped tool and consumes its result as image and structured data',async()=>{
  const job=makeJob(), remote=[], requests=[];
  const env=bindJobForgeTools({...baseEnv,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify(readGrant)},job,async()=>{},async (_signal,fn)=>fn({
    tools:async()=>catalog,callTool:async(name,args)=>{remote.push({name,args});return {structuredContent:{clearance:2.5},content:[{type:'image',mimeType:'image/png',data:'aW1n'}]};}}));
  const result=await structuredCall(async (url,opts)=>{assert.equal(url,'https://api.openai.com/v1/responses');requests.push(JSON.parse(opts.body));return provider(requests.length-1,{project_id:project});},env,signal(),requestBody,'test');
  assert.deepEqual(remote,[{name:'inspect_version',args:{project_id:project}}]);assert.equal(requests.length,2);
  assert.equal(requests[0].tools.length,1);assert.equal(requests[0].model,baseEnv.OPENAI_MODEL);assert.deepEqual(requests[0].tools[0].parameters,schema);
  assert.equal(requests[1].input.at(-1).output[1].image_url,'data:image/png;base64,aW1n');assert.equal(requests[1].input[1].encrypted_content,'encrypted');
  assert.equal(result.forgeMcp.calls[0].status,'returned');assert.deepEqual(result.value,{ok:true});assert.equal(result.usage.total_tokens,6);
  assert.ok(!JSON.stringify(requests).includes(baseEnv.FORGECAD_MCP_ACCESS_TOKEN));
});

test('a project substitution cannot reach ForgeCAD; a private unrequested project does not activate tools',async()=>{
  const job=makeJob(), src={...baseEnv,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify(readGrant)};
  let calls=0;
  const env=bindJobForgeTools(src,job,async()=>{},async (_signal,fn)=>fn({tools:async()=>catalog,callTool:async()=>{calls++;}}));
  let turn=0;
  const rejected=await structuredCall(async()=>provider(turn++,{project_id:'other'}),env,signal(),requestBody,'test');
  assert.equal(rejected.forgeMcp.calls[0].status,'invalid-arguments');assert.equal(calls,0);
  assert.equal(bindJobForgeTools(src,{...job,input:{}},()=>{}),src);
  assert.throws(()=>bindJobForgeTools(src,{...job,input:{forgeProject:'other'}}),/匹配/);
});

test('a per-job exact write is durably reserved before dispatch and uncertain outcomes are not retried',async()=>{
  const job=makeJob(), grant={project,approvedCalls:[{name:'sandbox_edit',arguments:{project_id:project,target:'fixture'}}]};
  const src={...baseEnv,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify(grant)};
  assert.throws(()=>bindJobForgeTools(src,job,async()=>{}),/任务 ID/);
  let saves=0, mutations=0;
  const run=async()=>{
    const env=bindJobForgeTools({...src,FORMBENCH_FORGE_MCP_JOB_ID:job.id},job,async()=>{saves++;},async (_signal,fn)=>fn({tools:async()=>catalog,callTool:async (name,args)=>{
      assert.ok(saves>0);assert.equal(Object.values(job.state.forgeOperations)[0].status,'pending');assert.deepEqual(args,grant.approvedCalls[0].arguments);mutations++;throw Error('lost connection');}}));
    let turn=0;return structuredCall(async()=>provider(turn++,{}),env,signal(),requestBody,'test');
  };
  await assert.rejects(run(),/lost connection/);const resumed=await run();
  assert.equal(mutations,1);assert.equal(resumed.forgeMcp.calls[0].status,'pending-reused');
});

test('configured public reference tools can be called without a local token or a remote project parameter',async()=>{
  const remote=[];
  const env=bindJobForgeTools({...baseEnv,FORGECAD_MCP_ACCESS_TOKEN:'',FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify({project,publicReadTools:['reference']})},
    makeJob(),async()=>{},async (_signal,fn)=>fn({tools:async()=>[{name:'reference',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{topic:{type:'string'}}}}],
      callTool:async(name,args)=>{remote.push([name,args]);return {content:[{type:'text',text:'reference text'}]};}}));
  let turn=0;
  await structuredCall(async()=>provider(turn++,{topic:'assembly'}),env,signal(),requestBody,'test');
  assert.deepEqual(remote,[['reference',{topic:'assembly'}]]);
});

test('AI can revise and revert one authorized sandbox file, while the target and all other arguments stay fixed',async()=>{
  const job=makeJob(), calls=[];
  const sandbox={name:'write_source',projectField:'project_id',pathField:'path',contentField:'source',bind:{project_id:project,path:'main.forge.js'}};
  const env=bindJobForgeTools({...baseEnv,FORMBENCH_FORGE_MCP_JOB_ID:job.id,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify({project,sandboxFiles:[sandbox]})},
    job,async()=>{},async (_signal,fn)=>fn({tools:async()=>[{name:sandbox.name,inputSchema:{type:'object',properties:{project_id:{type:'string'},path:{type:'string'},source:{type:'string'}}}}],
      callTool:async(name,args)=>{calls.push([name,args]);return {content:[{type:'text',text:'updated'}]};}}));
  const run=async args=>{
    let turn=0;
    return structuredCall(async(_url,opts)=>{
      const [tool]=JSON.parse(opts.body).tools;
      assert.deepEqual(Object.keys(tool.parameters.properties),['source']);
      return provider(turn++,args);
    },env,signal(),requestBody,'test');
  };
  assert.equal((await run({source:'A',path:'other.forge.js'})).forgeMcp.calls[0].status,'invalid-arguments');
  for(const source of ['A','A','B','A'])await run({source});
  assert.deepEqual(calls,['A','B','A'].map(source=>[sandbox.name,{...sandbox.bind,source}]));
  let reviewCalls=0;
  await structuredCall(async(_url,opts)=>{reviewCalls++;assert.equal(JSON.parse(opts.body).tools,undefined);return provider(1,{})},
    env,signal(),{...requestBody,text:format('hardware_design_review',{type:'object'})},'test');
  assert.equal(reviewCalls,1);
});

test('ordinary new jobs persist the configured remote sandbox, with a separate writable path for each job',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'forge-workflow-'));
  const sandbox={name:'write_source',projectField:'p',pathField:'file',contentField:'source',bind:{p:project,file:'draft-{jobId}.forge.js'}};
  const src={...baseEnv,FORMBENCH_JOB_DIR:dir,FORMBENCH_FORGE_MCP_DEFAULT_PROJECT:project,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify({project,sandboxFiles:[sandbox]})};
  try {
    const create=async()=>{
      const url='http://localhost/api/design-jobs';
      const newJob=await(await designJobs(new Request(url,{method:'POST',body:JSON.stringify({prompt:'Fixture design with ordinary webpage payload'})}),src,{run:async()=>Response.json({design:{}})})).json();
      let completed=false;
      for (let i=0;i<100;i++){
        if ((await(await designJobs(new Request(url+'/'+newJob.id),src)).json()).status==='complete') { completed=true;break; }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(completed);
      return JSON.parse(await readFile(join(dir,newJob.id,'job.json'),'utf8'));
    };
    const paths=[];
    for (const job of [await create(),await create()]) {
      assert.equal(job.input.forgeProject,project);
      const env=bindJobForgeTools(src,job,async()=>{},async (_signal,fn)=>fn({
        tools:async()=>[{name:sandbox.name,inputSchema:{type:'object',properties:{p:{type:'string'},file:{type:'string'},source:{type:'string'}}}}],
        callTool:async(_name,args)=>{paths.push(args.file);assert.equal(args.file,'draft-'+job.id+'.forge.js');return {content:[]};}}));
      let turn=0;
      await structuredCall(async()=>provider(turn++,{source:'geometry'}),env,signal(),requestBody,'test');
    }
    assert.notEqual(paths[0],paths[1]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('concurrent part reconstruction uses separate remote files and never writes to the main assembly path',async()=>{
  const job=makeJob(), paths=[];
  const sandbox={name:'write_source',projectField:'p',pathField:'path',contentField:'source',bind:{p:project,path:'{jobId}-{model}.forge.js'}};
  const env=bindJobForgeTools({...baseEnv,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify({project,sandboxFiles:[sandbox]})},job,async()=>{},async (_s,fn)=>fn({
    tools:async()=>[{name:sandbox.name,inputSchema:{type:'object',properties:{p:{type:'string'},path:{type:'string'},source:{type:'string'}}}}],
    callTool:async(_n,args)=>{paths.push(args.path);return {content:[]};}}));
  await Promise.all(['Stepper A','Board B'].map(async model=>{
    let turn=0;
    await structuredCall(async()=>provider(turn++,{source:model}),env,signal(),{...requestBody,text:format('purchased_part_geometry',{type:'object'}),input:JSON.stringify({part:{model}})},'part');
  }));
  assert.equal(new Set(paths).size,2);assert.ok(paths.every(path=>path.startsWith(job.id+'-part-')));
});

test('official draft protocol reads main.forge.js before writing, rereads on conflict, and pins the observed file revision',async()=>{
  const job=makeJob(),inputFields={draftId:{type:'string'},file:{type:'string'}};
  const tools=[
    {name:'read_file',inputSchema:{type:'object',properties:inputFields,required:Object.keys(inputFields)}},
    {name:'write_file',inputSchema:{type:'object',properties:{...inputFields,content:{type:'string'},expectedRevision:{type:'number'}},required:['draftId','file','content','expectedRevision']}}
  ];
  const file={name:'write_file',draftField:'draftId',pathField:'file',contentField:'content',bind:{draftId:'scratch-A',file:'main.forge.js'},
    revision:{readTool:'read_file',argument:'expectedRevision',resultPath:'revision'}};
  const src={...baseEnv,FORMBENCH_FORGE_MCP_JOB_ID:job.id,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify({project,draftId:'scratch-A',sandboxFiles:[file]})};
  let revision=2,source='return box(2,2,2);';
  const remoteCalls=[];
  const server=async(_url,opts)=>{
    if(!opts.body)return new Response(null,{status:opts.method==='DELETE'?204:405});
    const req=JSON.parse(opts.body);
    if(req.method==='notifications/initialized')return new Response(null,{status:202});
    let result;
    if(req.method==='initialize') result={protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
    if(req.method==='tools/list') result={tools};
    if(req.method==='tools/call'){
      const {name,arguments:args}=req.params;
      assert.equal(args.draftId,'scratch-A');assert.equal(args.file,'main.forge.js');
      remoteCalls.push([name,args.expectedRevision]);
      if(name==='read_file')result={content:[{type:'text',text:JSON.stringify({content:source,revision})}]};
      else if(revision===2){
        assert.equal(args.expectedRevision,2);
        source='return box(3,3,3);';revision++;
        result={isError:true,content:[{type:'text',text:'Revision conflict.'}]};
      } else {
        assert.equal(args.expectedRevision,3);
        source=args.content;revision++;result={content:[],structuredContent:{revision}};
      }
    }
    assert.ok(result,req.method);return Response.json({id:req.id,jsonrpc:'2.0',result},{headers:{'mcp-session-id':'session'}});
  };
  const env=bindJobForgeTools(src,job,async()=>{},(abort,fn)=>withForgeMcp(src,abort,fn,{fetch:server}));
  const turns=[['forge_1',{content:'ignored'}],['forge_0',{}],['forge_1',{content:'first'}],
    ['forge_0',{}],['forge_1',{content:'return box(3,3,4);'}]];
  let n=0;
  const result=await structuredCall(async(_url,opts)=>{
    const req=JSON.parse(opts.body);
    if (n===2) assert.match(req.input.at(-1).output[0].text,/box\(2,2,2\)/);
    if (n===4) assert.match(req.input.at(-1).output[0].text,/box\(3,3,3\)/);
    if(n===turns.length)return provider(1,{});
    const [name,args]=turns[n++];return provider(0,args,name);
  },env,signal(),requestBody,'test');
  assert.deepEqual(remoteCalls,[['read_file',undefined],['write_file',2],['read_file',undefined],['write_file',3]]);
  assert.equal(source,'return box(3,3,4);');
  assert.deepEqual(result.forgeMcp.calls.map(c=>c.status),['invalid-arguments','returned','tool-error','returned','returned']);
  assert.deepEqual(Object.values(job.state.forgeFileRevisions),[{file:file.bind,readRevision:3,writtenRevision:4}]);
  assert.equal(result.forgeMcp.calls.at(-1).expectedRevision,3);
});

test('a hosted check with budget fields requires operator-set limits and cannot increase them',async()=>{
  const job=makeJob(), sent=[];
  const descriptor={name:'check_fit',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{draftId:{type:'string'},maxCredits:{type:'number'},maxDurationSeconds:{type:'number'}}}};
  const run=async(bounds,args)=>{
    const src={...baseEnv,FORMBENCH_FORGE_MCP_WORKFLOW:JSON.stringify({project,draftId:'t',readTools:{check_fit:bounds}})};
    const env=bindJobForgeTools(src,job,async()=>{},async(_s,fn)=>fn({tools:async()=>[descriptor],callTool:async(_n,actual)=>{sent.push(actual);return {content:[]};}}));
    let n=0;return structuredCall(async()=>provider(n++,args),env,signal(),requestBody,'test');
  };
  await assert.rejects(run({draftId:'t'},{}),/maxCredits/);
  const bounds={draftId:'t',maxCredits:2,maxDurationSeconds:10};
  const rejected=await run(bounds,{...bounds,maxCredits:3});
  assert.equal(rejected.forgeMcp.calls[0].status,'invalid-arguments');
  await run(bounds,bounds);assert.deepEqual(sent,[bounds]);
});
