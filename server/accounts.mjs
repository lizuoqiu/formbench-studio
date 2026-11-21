// Server-side TOP OAuth: https://developer.alibaba.com/docs/doc.htm?articleId=102635&docType=1
// Node callers pass sqliteAdapter(new DatabaseSync(path)); Workers bind D1 as FORM_DB.
const schema=[
 'CREATE TABLE IF NOT EXISTS fb_auth_pending (state TEXT PRIMARY KEY,browser TEXT NOT NULL,expires INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS fb_auth_sessions (session TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS fb_account_projects (id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)',
 'CREATE INDEX IF NOT EXISTS fb_project_owner ON fb_account_projects(owner,updated DESC)'];
export function sqliteAdapter(sqlite){return {prepare(sql){const s=sqlite.prepare(sql);return {bind(...args){return {first:()=>s.get(...args)??null,all:()=>({results:s.all(...args)}),run:()=>s.run(...args)}}}}};}
const ready=new WeakMap();function init(db){if(!ready.has(db))ready.set(db,(async()=>{for(const s of schema)await db.prepare(s).bind().run()})().catch(e=>{ready.delete(db);throw e}));return ready.get(db);}
const bytes=new TextEncoder();const hex=arr=>Array.from(arr,b=>b.toString(16).padStart(2,'0')).join('');const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));const digest=async s=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.encode(s))));
const SESSION='fb_session',STATE='fb_oauth_browser',TTL=7*24*60*60;
function cookie(req,name){const val=(req.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);return /^[0-9a-f]{64}$/.test(val||'')?val:null;}
function headers(){return new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});}
function addCookie(h,name,value,age,secure){h.append('Set-Cookie',`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`);}
const json=(obj,status=200,h=headers())=>Response.json(obj,{status,headers:h});
const fail=(error,status)=>json({error},status);
function configured(env,db,url){try{const cb=new URL(env.TAOBAO_REDIRECT_URI);return !!(db&&env.TAOBAO_APP_KEY&&env.TAOBAO_APP_SECRET&&cb.origin===url.origin&&cb.pathname==='/api/auth/callback'&&!cb.search&&!cb.hash&&!cb.username&&!cb.password&&(cb.protocol==='https:'||(cb.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(cb.hostname))));}catch{return false}}
export const isAccountRoute=p=>p.startsWith('/api/auth/')||p==='/api/projects'||p.startsWith('/api/projects/');
export async function accounts(request,env,db=env.FORM_DB,{exchange=fetch,now=()=>Math.floor(Date.now()/1000)}={}){
 const url=new URL(request.url),p=url.pathname,m=request.method,secure=url.protocol==='https:',configuredHere=configured(env,db,url);
 if(!isAccountRoute(p))return fail('接口不存在。',404);
 if(!configuredHere){if(p==='/api/auth/status'&&m==='GET')return json({configured:false,authenticated:false,user:null});return fail('尚未配置淘宝开放平台授权或账户数据库。',503);}
 if(!['GET','HEAD'].includes(m)&&request.headers.get('Origin')!==url.origin)return fail('请求来源无效。',403);
 const q=(sql,...args)=>db.prepare(sql).bind(...args),time=now();
 try{await init(db);const siteSession=cookie(request,SESSION),session=siteSession?await digest(siteSession):null;
 if(p==='/api/auth/taobao'&&m==='GET'){
  const state=random(),browser=random();await q('DELETE FROM fb_auth_pending WHERE expires<=?',time).run();await q('DELETE FROM fb_auth_sessions WHERE expires<=?',time).run();await q('INSERT INTO fb_auth_pending VALUES(?,?,?)',await digest(state),await digest(browser),time+600).run();
  const to=new URL('https://oauth.taobao.com/authorize');to.search=new URLSearchParams({response_type:'code',client_id:env.TAOBAO_APP_KEY,redirect_uri:env.TAOBAO_REDIRECT_URI,state,view:'web'});const h=headers();h.set('Location',to.href);addCookie(h,STATE,browser,600,secure);return new Response(null,{status:302,headers:h});
 }
 if(p==='/api/auth/callback'&&m==='GET'){
  const state=url.searchParams.get('state'),browser=cookie(request,STATE);if(!browser||!/^[a-f0-9]{64}$/.test(state||''))return fail('登录验证已失效，请重试。',400);
  const claimed=await q('DELETE FROM fb_auth_pending WHERE state=? AND browser=? AND expires>? RETURNING state',await digest(state),await digest(browser),time).first();if(!claimed)return fail('登录验证已失效，请重试。',400);
  const code=url.searchParams.get('code');if(!code||code.length>2048)return fail('淘宝授权已取消或未完成。',400);
  const body=new URLSearchParams({grant_type:'authorization_code',code,client_id:env.TAOBAO_APP_KEY,client_secret:env.TAOBAO_APP_SECRET,redirect_uri:env.TAOBAO_REDIRECT_URI});
  let token;try{const resp=await exchange('https://oauth.taobao.com/token',{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(15000)});if(!resp.ok)throw Error();token=await resp.json();}catch{return fail('淘宝未完成授权，请重试。',502);}
  const uid=token?.taobao_open_uid;if(typeof token?.access_token!=='string'||!token.access_token||typeof uid!=='string'||!uid.trim()||uid.length>512)return fail('淘宝未返回此应用可验证的账户标识。',403);
  const owner=await digest(JSON.stringify(['taobao',env.TAOBAO_APP_KEY,uid])),id=random();if(session)await q('DELETE FROM fb_auth_sessions WHERE session=?',session).run();await q('INSERT INTO fb_auth_sessions VALUES(?,?,?)',await digest(id),owner,time+TTL).run();
  const h=headers();addCookie(h,SESSION,id,TTL,secure);addCookie(h,STATE,'',0,secure);h.set('Location','/?account=linked');return new Response(null,{status:303,headers:h});
 }
 if(p==='/api/auth/logout'&&m==='POST'){if(session)await q('DELETE FROM fb_auth_sessions WHERE session=?',session).run();const h=headers();addCookie(h,SESSION,'',0,secure);addCookie(h,STATE,'',0,secure);return json({authenticated:false,user:null},200,h);}
 const auth=session?await q('SELECT owner FROM fb_auth_sessions WHERE session=? AND expires>?',session,time).first():null;
 if(p==='/api/auth/status'&&m==='GET')return json({configured:true,authenticated:!!auth,user:auth?{id:auth.owner,provider:'taobao',displayName:'淘宝用户',nickname:'淘宝用户'}:null});
 if(!auth)return fail('请先绑定淘宝账号。',401);const owner=auth.owner;
 if(p==='/api/projects'&&m==='GET'){const {results}=await q('SELECT id,name,created AS createdAt,updated AS updatedAt FROM fb_account_projects WHERE owner=? ORDER BY updated DESC,id',owner).all();return json({projects:results});}
 const id=/^\/api\/projects\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(p)?.[1];
 if(id&&m==='GET'){const row=await q('SELECT id,name,data,created AS createdAt,updated AS updatedAt FROM fb_account_projects WHERE id=? AND owner=?',id,owner).first();return row?json({project:projectRow(row,JSON.parse(row.data))}):fail('项目不存在。',404);}
 if((p==='/api/projects'&&m==='POST')||(id&&m==='PUT')){if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return fail('需要 JSON 项目。',415);const text=await request.text();if(bytes.encode(text).length>512000)return fail('项目超过保存上限。',413);
  let v;try{v=JSON.parse(text)}catch{return fail('无效的项目。',400)}const payload=v?.data??{prompt:v?.prompt,design:v?.design,selected:v?.selected};const name=String(v?.name??payload.design?.name??payload.prompt??'').trim().slice(0,200);if(!name||!payload||typeof payload!=='object'||Array.isArray(payload)||('prompt' in payload&&typeof payload.prompt!=='string')||(id&&v?.id&&v.id!==id))return fail('无效的项目名称或内容。',400);
  const t=new Date(time*1000).toISOString(),key=id??crypto.randomUUID(),d=JSON.stringify(payload);const row=await q(`INSERT INTO fb_account_projects(id,owner,name,data,created,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated=excluded.updated WHERE fb_account_projects.owner=excluded.owner RETURNING id,name,created AS createdAt,updated AS updatedAt`,key,owner,name,d,t,t).first();return row?json({project:projectRow(row,payload)},id?200:201):fail('项目不存在。',404);}

 return fail('不支持此操作。',405);
 }catch{return fail('账户存储暂时不可用。',503);}
}

function projectRow(row,data){return {...data,id:row.id,name:row.name,createdAt:row.createdAt,updatedAt:row.updatedAt,data};}
