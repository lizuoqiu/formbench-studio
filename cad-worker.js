// One plan per browser module worker; no user-provided code or paths.
import {compileCadPlan} from './cad-plan-compiler.js';
self.addEventListener('message', async ({data})=>{
  try{
    if(!data||typeof data!=='object'||Object.keys(data).some(key=>!['cadPlan','progress'].includes(key))||!Object.hasOwn(data,'cadPlan'))throw Error('请提供 cadPlan。');
    const emit=data.progress===true ? progress=>self.postMessage({progress}) : undefined;
    self.postMessage({result:await compileCadPlan(data.cadPlan,emit)});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'实体编译失败。'})}
  finally{self.close()}
},{once:true});
