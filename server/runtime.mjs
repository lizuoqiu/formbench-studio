const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export function capabilities(env){const ai=!!(env.OPENAI_API_KEY&&env.OPENAI_MODEL),official=!!(env.TAOBAO_APP_KEY&&env.TAOBAO_APP_SECRET);return json({ai,catalog:ai,cart:official?'official':'manual'});}
export async function buyerAction(request,env,kind,action){if(request.method!=='POST')return json({error:'仅支持 POST。'},405);const body=await request.json().catch(()=>null);if(!body||typeof body!=='object')return json({error:'无效的请求。'},400);
 if(kind==='catalog'&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>200||typeof body.spec!=='string'||body.spec.length>800))return json({error:'无效的零件名称或规格。'},400);
 try{const result=await action(kind==='cart'?body.items:body,env);return json(result,result.error&&!result.searchUrl?502:200);}catch{return json({error:'请核对商品链接、规格和数量。'},400);}}
