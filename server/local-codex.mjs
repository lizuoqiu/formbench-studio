import {modelingGuide,generation} from './modeling-guide.mjs';
// Optional, single-user, loopback-only transport. This file is never imported by the Worker.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,writeFile,readFile,realpath,stat,rm,mkdtemp} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute,delimiter} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {schema,normalizeDesign,instructions} from './design.mjs';
const exec=promisify(execFile), limit=512*1024, deadline=240000;
const disabled=['shell_tool','unified_exec','plugins','apps','multi_agent','multi_agent_v2','hooks','computer_use','image_generation','memories','skill_search','shell_snapshot','code_mode','code_mode_host','remote_plugin'];
const reply=(v,s=200)=>Response.json(v,{status:s,headers:{'Cache-Control':'no-store'}});
const isLocal=req=>{try{const u=new URL(req.url);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&req.headers.get('Origin')===u.origin;}catch{return false}};
function cliEnv(){return {PATH:'/usr/bin:/bin',HOME:homedir(),LANG:'en_US.UTF-8',TMPDIR:tmpdir()};}
async function locate(env){const dirs=(env.PATH||'').split(delimiter).filter(isAbsolute);for(const d of dirs){try{const f=await realpath(join(d,'codex'));await access(f,constants.X_OK);return f;}catch{}}throw Error('CLI unavailable');}
function profile(bin){const path=p=>JSON.stringify(p),home=homedir();
 // CLI authenticates through its own account. Never read, export or copy its credentials.
 // The CLI can reach its inference endpoint; no model-requested process can be executed.
 return '(version 1)(allow default)(deny process-fork)(deny process-exec)(allow process-exec (literal '+path(bin)+'))(deny file-read-data file-write* '+['Documents','Downloads','Desktop','Pictures','Movies','Music','.ssh','.aws','.gnupg','.config/gcloud'].map(x=>'(subpath '+path(join(home,x))+')').join(' ')+')';
}
const memo={until:0,run:null};
export async function localCodexReady(env){if(process.platform!=='darwin'||env.FORM_BENCH_LOCAL_CODEX!=='1'||env.OPENAI_API_KEY)return false;
 if(Date.now()>=memo.until){memo.until=Date.now()+20000;memo.run=(async()=>{const bin=await locate(env);const {stdout,stderr}=await exec('/usr/bin/sandbox-exec',['-p',profile(bin),bin,'login','status'],{cwd:tmpdir(),env:cliEnv(),timeout:3500,maxBuffer:20000});return /logged in using chatgpt/i.test(stdout+' '+stderr)?bin:false;})().catch(()=>false);}return memo.run;
}
export function args(dir,model,guideText=''){const why='你仅为硬件方案生成 JSON。使用下列 JSON 中的 prompt 作为硬件需求，不执行任何工具、命令、文件或网络操作。'+instructions+'\n'+guideText;
 const a=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--color','never','-s','read-only','-c','approval_policy="never"','-c','web_search="disabled"','-c','mcp_servers={}','-c','project_doc_max_bytes=0','-c','suppress_unstable_features_warning=true','-c','developer_instructions='+JSON.stringify(why),'--enable','skip_host_skill_discovery',...disabled.flatMap(k=>['--disable',k]),'--cd',dir,'--json','--output-schema',join(dir,'design-schema.json'),'-o',join(dir,'final.json')];if(model)a.push('-m',model);return [...a,'-'];}
function matches(v,s){if(s.enum&&!s.enum.includes(v))return false;if(s.type==='object')return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===s.required.length&&s.required.every(k=>Object.hasOwn(v,k)&&matches(v[k],s.properties[k]));if(s.type==='array')return Array.isArray(v)&&v.every(x=>matches(x,s.items));if(s.type==='integer')return Number.isInteger(v);if(s.type==='number')return Number.isFinite(v);return typeof v===s.type;}
export function acceptEvent(e){if(['thread.started','turn.started','turn.completed','warning'].includes(e?.type))return;
 if(e?.type==='error'||(e?.type==='item.completed'&&e.item?.type==='error'))return; // transient transport reconnects can precede a completed turn
 if(['item.started','item.updated','item.completed'].includes(e?.type)&&['agent_message','reasoning'].includes(e.item?.type))return;
 throw Error('unexpected action or failed turn');}
function run(bin,dir,model,prompt,signal,guideText){return new Promise((resolveRun,reject)=>{const proc=spawn('/usr/bin/sandbox-exec',['-p',profile(bin),bin,...args(dir,model,guideText)],{cwd:dir,env:cliEnv(),detached:true,stdio:['pipe','pipe','pipe']});let failed=false,done=false,line='',bytes=0,reason='CLI ended before valid final message',diagnostic='';const stop=()=>{failed=true;try{process.kill(-proc.pid,'SIGKILL');}catch{}};const timer=setTimeout(stop,deadline);const abort=()=>stop();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)stop();
 const event=s=>{if(!s.trim())return;const e=JSON.parse(s);acceptEvent(e);if(e.type==='turn.completed')done=true;};proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>{if(failed)return;if((bytes+=Buffer.byteLength(chunk))>4*limit)return stop();line+=chunk;let at;try{while((at=line.indexOf('\n'))>=0){event(line.slice(0,at));line=line.slice(at+1);}}catch{reason='unexpected CLI event';stop();}});proc.stderr.setEncoding('utf8');proc.stderr.on('data',c=>{diagnostic=(diagnostic+c).slice(-4000);});proc.stdin.on('error',()=>{});proc.stdin.end(JSON.stringify({prompt}));const close=(code)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);try{event(line);if(failed||code!==0||!done)throw Error();resolveRun();}catch{const category=['unknown feature','Unknown feature','unexpected argument','not permitted','Permission denied','Failed to load','failed to start','not supported','No such file or directory','sandbox','Broken pipe','failed to resolve','model is not','stream disconnected','not found','not available','could not initialize'].find(x=>diagnostic.includes(x));console.warn('[local-codex]',reason,'exit:',code??'killed',category??'');reject(Error('inference incomplete'));}};proc.once('error',()=>close(-1));proc.once('close',close);});}
let busy=false;
export async function codexDesign(request,env){if(!isLocal(request))return reply({error:'仅限本机工作台。'},403);const bin=await localCodexReady(env);if(!bin)return reply({error:'本机设计服务未连接。'},503);
 const body=await request.json().catch(()=>null),prompt=body?.prompt;if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)return reply({error:'设计说明须在 1–10000 字之间。'},400);
 const model=env.FORM_BENCH_CODEX_MODEL;if(model&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(model))return reply({error:'本机模型设置无效。'},503);if(busy)return reply({error:'已有设计正在生成，请稍后再试。'},429);busy=true;let dir;
 try{const guide=await modelingGuide(env);dir=await mkdtemp(join(tmpdir(),'formbench-local-'));await writeFile(join(dir,'design-schema.json'),JSON.stringify(schema),{mode:0o600});await run(bin,dir,model,prompt,request.signal,guide.text);const file=join(dir,'final.json');if((await stat(file)).size>limit)throw Error();const raw=JSON.parse(await readFile(file,'utf8'));if(!matches(raw,schema))throw Error();return reply({design:{...normalizeDesign(raw,prompt),generation:generation('local-codex',model,'configured',guide.skill)},provider:'local-codex'});
 }catch{return reply({error:'本机设计未完成，请重试或检查本机登录状态。'},502);}finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{busy=false;}}}
