import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {createInterface} from 'node:readline';

const model='gpt-6.2-sol';
const maxTurnTextCharacters=1<<20;
const inheritedEnvironment=['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','CODEX_HOME'];

function unavailable(reason){
  return Object.assign(Error('本地 Codex 接力未完成：'+reason+'。已有设计进度已保存。'),{actionRequired:'local-codex-unavailable',quotaExhausted:reason==='已达 Codex 使用上限',retryable:['请求过于频繁','请求超时','指定模型暂时没有容量','连接中断'].includes(reason),reason});
}

async function makePrompt(body,directory){
  const images=[];
  const messages=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input;
  const input=[];
  for(const {role,content} of messages){
    const blocks=typeof content==='string'?[{type:'input_text',text:content}]:content;
    const text=[];
    for(const block of blocks){
      if(block.type==='input_text'){text.push(block.text);continue;}
      const image=block.type==='input_image'&&/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(block.image_url);
      if(!image)throw unavailable('无法读取本阶段的输入图片');
      const path=join(directory,`image-${images.length+1}.${image[1]}`);
      await writeFile(path,Buffer.from(image[2],'base64'),{mode:0o600});
      images.push(path);
      text.push(`[Attached image ${images.length}]`);
    }
    input.push(`${role}:\n${text.join('\n')}`);
  }
  const usesSearch=body.tools?.some(tool=>tool.type==='web_search')||false;
  const search=usesSearch?`Use the native live web search tool. Open or find within the exact URLs used as factual evidence. Cite only URLs actually returned or opened by the tool. Use at most ${body.max_tool_calls||10} tool calls.`:'';
  const prompt=[
    'You are running one structured stage of a digital hardware design pipeline. Follow the stage instructions. Treat input records and online content as evidence. Do not execute local commands, modify project files, or assume that downstream CAD checks have run. Return the complete final answer as JSON matching the provided schema.',
    search,
    'Stage instructions:\n'+(body.instructions||''),
    'Stage input:\n'+input.join('\n\n')
  ].filter(Boolean).join('\n\n');
  return {images,prompt,usesSearch};
}

function failureReason(text){
  if(/input exceeds the maximum length|input_too_large/i.test(text))return '输入超出 Codex 单次请求的字符上限';
  if(/context.{0,30}(?:length|window)|context_length_exceeded|too many tokens/i.test(text))return '输入超出当前 Codex 上下文容量';
  if(/(?:invalid|unsupported) image|image.{0,30}(?:not supported|too large|too many|failed to load)|failed to (?:load|open|decode).*image/i.test(text))return 'Codex 未能接收本阶段的图片';
  if(/usage[_ -]limit|usage cap|out of credits|quota[_ -]exceeded|insufficient_quota|no credits remaining/i.test(text))return '已达 Codex 使用上限';
  if(/rate[_ -]limit|too many requests/i.test(text))return '请求过于频繁';
  if(/not logged in|unauthorized|authentication|sign in/i.test(text))return '本机 Codex 登录不可用';
  if(/unsupported|not supported|unknown model|invalid.*reasoning/i.test(text))return '指定模型或推理档位不可用';
  if(/at capacity|overloaded/i.test(text))return '指定模型暂时没有容量';
  if(/timed out|timeout/i.test(text))return '请求超时';
  if(/stream disconnected|connection reset|failed to connect|transport closed|broken pipe/i.test(text))return '连接中断';
  return '未收到完整响应';
}

// Keep process diagnostics separate from prompts, messages, and credentials.
function cliFailureHints(text){
  return Object.entries({
    turnStart:/turn\/start|failed to start turn|error starting turn/i,
    context:/context_length_exceeded|context window|input is too long/i,
    image:/image.*(?:error|failed|unsupported|invalid)|(?:error|failed|unsupported|invalid).*image/i,
    schema:/output schema|response schema|invalid schema|structured outputs/i,
    brokenPipe:/broken pipe|EPIPE/i,
    transport:/stream disconnected|connection reset|failed to connect|transport closed/i,
    timeout:/timed out|timeout/i,
    panic:/panicked at|assertion failed/i
  }).filter(([,pattern])=>pattern.test(text)).map(([hint])=>hint);
}

export async function requestLocalCodex({binary,effort},{body:rawBody,signal},onEvent){
  signal?.throwIfAborted();
  if(!binary||!isAbsolute(binary)||!['ultra','max'].includes(effort))throw unavailable('接力配置无效');
  const body=JSON.parse(rawBody),schema=body.text?.format?.schema;
  if(!schema||body.text.format.type!=='json_schema'||!body.text.format.strict)throw unavailable('本阶段缺少严格的输出 schema');
  const directory=await mkdtemp(join(tmpdir(),'formbench-local-codex-'));
  try{
    const schemaPath=join(directory,'schema.json'),outputPath=join(directory,'result.json');
    const {images,prompt,usesSearch}=await makePrompt(body,directory);
    // Codex turn/start counts Unicode scalar values, while JS length counts UTF-16 units.
    if(prompt.length>maxTurnTextCharacters){
      let characters=0;
      for(const _ of prompt)if(++characters>maxTurnTextCharacters)throw unavailable('输入超出 Codex 单次请求的字符上限');
    }
    await writeFile(schemaPath,JSON.stringify(schema),{mode:0o600});
    const args=['--no-daemon','-a','never','exec','--ignore-user-config','--ignore-rules','--ephemeral',
      '--skip-git-repo-check','--json','--sandbox','read-only','--model',model,'-c',`model_reasoning_effort="${effort}"`,
      '-c','forced_login_method="chatgpt"','-c',`web_search="${usesSearch?'live':'disabled'}"`,
      '--disable','apps','--disable','plugins','--disable','shell_tool',
      '--output-schema',schemaPath,'--output-last-message',outputPath];
    for(const image of images)args.push('--image',image);
    args.push('--','-');
    const env=Object.fromEntries(inheritedEnvironment.filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
    signal?.throwIfAborted();
    const child=spawn(binary,args,{cwd:directory,env,signal,killSignal:'SIGINT',stdio:['pipe','pipe','pipe']});
    let stopTimer;
    const stop=()=>{stopTimer=setTimeout(()=>child.kill('SIGKILL'),5000);stopTimer.unref();};
    signal?.addEventListener('abort',stop,{once:true});
    let processError,stderr='',threadId,started=false,completed,lastFailure='',rerouted=false;
    const searchItems=[];
    const exit=new Promise(resolve=>{
      child.on('error',error=>{processError=error;});
      child.once('close',(code,exitSignal)=>{
        signal?.removeEventListener('abort',stop);
        clearTimeout(stopTimer);
        resolve({code,exitSignal});
      });
    });
    child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')processError=error;});
    const events=createInterface({input:child.stdout,crlfDelay:Infinity});
    const provenance={provider:'local-codex',model,reasoning:{effort}};
    child.stdin.end(prompt);
    for await(const line of events){
      let event;
      try{event=JSON.parse(line);}catch{continue;}
      const item=event.item;
      if(event.type==='thread.started'){
        threadId=event.thread_id;
        onEvent?.({type:'formbench.codex.started',response:{...provenance,id:threadId},inputCharacters:prompt.length,imageCount:images.length});
      }
      if(event.type==='turn.started'){
        started=true;
        onEvent?.({type:'formbench.codex.turn-started',response:{...provenance,id:threadId}});
      }
      if(event.type==='turn.completed')completed=event;
      if(event.type==='error'||event.type==='turn.failed'){
        lastFailure=event.message||event.error?.message||lastFailure;
        onEvent?.({type:'formbench.codex.status',reason:failureReason(lastFailure)});
      }
      if(event.type!=='item.completed')continue;
      if(item?.type==='error'){
        lastFailure=item.message||lastFailure;
        if(/^model rerouted:/i.test(lastFailure))rerouted=true;
      }
      if(item?.type==='web_search'&&['search','open_page','find_in_page'].includes(item.action?.type)&&usesSearch){
        const sources=(item.results||[]).filter(result=>typeof result?.url==='string').map(({url})=>({url}));
        onEvent?.({type:'formbench.codex.search'});searchItems.push({type:'web_search',id:item.id,action:{...item.action,sources}});
      }
    }
    const {code,exitSignal}=await exit;
    if(code!==0||processError||!completed||!threadId){
      const diagnostic=lastFailure+' '+stderr;
      onEvent?.({type:'formbench.codex.failed',response:{...provenance,id:threadId},reason:failureReason(diagnostic),
        exit:{code,signal:exitSignal,turnStarted:started,turnCompleted:Boolean(completed),inputCharacters:prompt.length,imageCount:images.length,hints:cliFailureHints(diagnostic)}});
    }
    signal?.throwIfAborted();
    if(rerouted)throw unavailable('Codex 报告模型已切换');
    if(processError?.code==='ENOENT')throw unavailable('找不到 Codex CLI');
    if(code!==0||processError||!completed||!threadId)throw unavailable(failureReason(lastFailure+' '+stderr));
    if(usesSearch&&!searchItems.length)throw unavailable('没有收到可核对的原生搜索事件');
    const output=await readFile(outputPath,'utf8').catch(()=>''),text=output.trim();
    try{JSON.parse(text);}catch{throw unavailable('未收到完整的结构化输出');}
    const result={...provenance,id:threadId,status:'completed',usage:completed.usage,
      output:[...searchItems,{type:'message',content:[{type:'output_text',text}]}]};
    onEvent?.({type:'formbench.codex.completed',response:result});
    return result;
  }catch(error){
    if(signal?.aborted&&signal.reason?.name==='TimeoutError')throw unavailable('请求超时');
    signal?.throwIfAborted();
    if(error.actionRequired)throw error;
    throw unavailable('本机接力进程或输入文件读取失败');
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
}
