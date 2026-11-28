const key='formbench.design.pending.v1';
export function pendingDesignJob(){
  try{const saved=JSON.parse(localStorage.getItem(key));return /^[a-f0-9-]{36}$/.test(saved?.id)&&typeof saved?.input?.prompt==='string'?saved:null;}catch{return null;}
}
function remember(value){try{value?localStorage.setItem(key,JSON.stringify(value)):localStorage.removeItem(key);}catch{}}
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
  const end=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(end,ms),abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});
// Retrying a read reconnects to the existing durable job. Creation and other
// writes are deliberately kept outside this retry loop.
export async function readDesignJob(id,{call,signal,onReconnect}){
  let failures=0;
  for(;;){
    signal?.throwIfAborted();
    try{return await call('design-jobs/'+id,undefined,signal);}
    catch(error){
      signal?.throwIfAborted();
      if(error.name!=='TypeError'&&![408,429].includes(error.status)&&!(error.status>=500))throw error;
      onReconnect?.({stage:'reconnecting',message:'正在重新连接设计任务…'});
      await wait(Math.min(1500*2**Math.min(failures++,3),8000),signal);
    }
  }
}
export async function runDesignJob(input,{call,signal,onProgress}){
  const pending=pendingDesignJob();
  const read=id=>readDesignJob(id,{call,signal,onReconnect:onProgress});
  let job=pending&&JSON.stringify(pending.input)===JSON.stringify(input)?await read(pending.id):await call('design-jobs',input,signal);
  remember({id:job.id,input});
  const cancel=()=>{call('design-jobs/'+job.id+'/cancel',{}).catch(()=>{});remember(null);};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    while(job.status==='running'){
      onProgress?.(job.provider&&job.progress&&typeof job.progress==='object'?{...job.progress,provider:job.provider,policy:job.policy??input.provider}:job.progress);
      await wait(1200,signal);
      job=await read(job.id);
    }
    remember(null);
    if(job.status!=='complete')throw Object.assign(Error(job.error||'这一版仍有问题需要修订。'),{repairCandidate:job.repairCandidate,jobId:job.id,actionRequired:job.actionRequired});
    return job;
  }finally{signal?.removeEventListener('abort',cancel);}
}
