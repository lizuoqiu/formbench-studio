import {createRemoteJWKSet,jwtVerify} from 'jose';
import {design} from './design.mjs';
import {catalog} from './catalog.mjs';
const keySets=new Map();
function signingKeys(issuer){if(!keySets.has(issuer))keySets.set(issuer,createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer)));return keySets.get(issuer);}
const error=(message,status)=>Response.json({error:message},{status,headers:{'Cache-Control':'no-store'}});
export function makeWorker({keys=signingKeys,generate=design,search=catalog}={}){return {async fetch(request,env){
 const url=new URL(request.url);
 if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
 const handler=url.pathname==='/api/design'?generate:url.pathname==='/api/catalog'?search:null;
 if(!handler)return error('此接口仅在本机可用，或不存在。',404);
 if(request.method!=='POST')return error('只支持 POST。',405);
 const issuer=env.ACCESS_ISSUER,audience=env.ACCESS_AUD;
 if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer||'')||!audience)return error('尚未配置团队访问控制。',503);
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 if(!token)return error('请先通过团队登录。',403);
 try{const {payload}=await jwtVerify(token,keys(issuer),{issuer,audience,algorithms:['RS256'],requiredClaims:['exp','iss','aud']});if(payload.type!=='app')throw Error();}catch{return error('团队访问凭证无效。',403);}
 if(request.headers.get('Origin')!==url.origin)return error('请从本站发起设计请求。',403);
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return error('需要 JSON 格式的设计说明。',415);
 return handler(request,{...env,PUBLIC_WORKER:'1',ACCESS_PROTECTED:'1'});
}};}
export default makeWorker();
