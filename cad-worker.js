// One plan per browser module worker; no user-provided code or paths.
import {compileCadPlan} from './cad-plan-compiler.js';
self.addEventListener('message', async ({data})=>{
  try{
    if(!data||typeof data!=='object'||Object.keys(data).length!==1||!Object.hasOwn(data,'cadPlan'))throw Error('请提供 cadPlan。');
    self.postMessage({result:await compileCadPlan(data.cadPlan)});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'实体编译失败。'})}
  finally{self.close()}
},{once:true});
