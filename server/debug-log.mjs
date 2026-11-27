import {appendFileSync,mkdirSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const swept=new Map();
export const debugDirectory=env=>env.FORMBENCH_DEBUG_DIR||join(homedir(),'.formbench','debug');
const numeric=new Set(['statusCode','attempt','partIndex','completed','total','durationMs','inputTokens','outputTokens','open','closed','added','regressed','keySlot','images','characters','retries','assets','checks','count']);
const labels=new Set(['stage','provider','from','to','status','reason','action','model','effort','decision','kind','phase','caseId']);
export function debugSink(env,id,{now=()=>new Date(),output=line=>console.info(line)}={}){
  if(env.FORMBENCH_DEBUG!=='1')return undefined;
  const dir=debugDirectory(env),context=/^[a-f0-9-]{36}$/i.test(id)?id:'server';
  return (event,details={})=>{
    if(!/^[a-z][a-z0-9_.-]{0,64}$/.test(event))return;
    const date=now(),at=date.toISOString(),day=at.slice(0,10),row={at,id:context,event};
    // Do not serialize requests, URLs, credential names/values, tool output, or model rationale.
    for(const [k,v] of Object.entries(details??{})){
      if(numeric.has(k)&&Number.isFinite(v))row[k]=v;
      if(labels.has(k)&&typeof v==='string'&&/^[A-Za-z][a-zA-Z0-9_.:-]{0,80}$/.test(v)&&!/^(?:sk-|Bearer|eyJ)/i.test(v))row[k]=v;
    }
    const line=JSON.stringify(row);output(line);
    try{mkdirSync(dir,{recursive:true,mode:0o700});
      if(swept.get(dir)!==day){for(const f of readdirSync(dir))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)&&Date.parse(f.slice(0,10)+'T00:00:00Z')<+date-14*86400000)unlinkSync(join(dir,f));swept.set(dir,day);}
      const path=join(dir,day+'.jsonl');appendFileSync(path,line+'\n',{mode:0o600});
    }catch(e){console.warn('Formbench debug log write failed:',e.code||e.name);}
  };
}
