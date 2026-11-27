import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// A normal local server resumes persisted jobs on startup. Give each test its own storage.
export async function isolatedLocalServer(port,settings={}){
 const dir=await mkdtemp(join(tmpdir(),'formbench-http-test-'));
 const env={PATH:process.env.PATH, ...settings,PORT:String(port),FORMBENCH_LOAD_ENV:'0',
   FORMBENCH_JOB_DIR:join(dir,'jobs'),FORMBENCH_ASSET_DIR:join(dir,'models'),
   FORMBENCH_DEBUG_DIR:join(dir,'debug'),FORMBENCH_FORGE_OAUTH_DIR:join(dir,'forge-auth')};
 const child=spawn(process.execPath,['server/local.mjs'],{cwd:new URL('../../',import.meta.url),env,stdio:['ignore','pipe','pipe']});
 const closed=once(child,'close');
 async function close(){
   if(child.exitCode===null&&child.signalCode===null)child.kill();
   try{await closed;}finally{await rm(dir,{recursive:true,force:true});}
 }
 try{
   await Promise.race([once(child.stdout,'data'),closed.then(()=>{throw Error('Test server exited before listening');})]);
 }catch(error){await close();throw error;}
 return {origin:'http://127.0.0.1:'+port,jobDirectory:env.FORMBENCH_JOB_DIR,close};
}
