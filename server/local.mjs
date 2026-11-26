import {randomUUID} from 'node:crypto';
import {debugSink} from './debug-log.mjs';
import {observeRun} from './run-events.mjs';
import {Readable} from 'node:stream';
import {designJobs,resumeRunningJobs} from './design-jobs.mjs';
import {designProviders,routedDiscussion} from './design-provider.mjs';
import {forgeLoginRequest} from './forge-mcp-auth.mjs';
import {forgeMcpRequest} from './forge-mcp.mjs';
import {modelAsset} from './source-files.mjs';
import {pipeline} from 'node:stream/promises';
import {shoppingWindow,shoppingWindowReady} from './shopping-window.mjs';
import {maxDesignRequestBytes} from './design-conversation.mjs';
import {forgePlan,forgePlanEngine} from './forge-plan.mjs';
import http from 'node:http';import {forge} from './forge.mjs';import {readFile} from 'node:fs/promises';import {extname,resolve,sep} from 'node:path';import {fileURLToPath} from 'node:url';import {design} from './design.mjs';import {accounts,isAccountRoute,sqliteAdapter} from './accounts.mjs';import {buyerSearch,buyerCart} from './buyer-browser.mjs';import {capabilities,buyerAction} from './runtime.mjs';import {createRequire} from 'node:module';import {mkdirSync} from 'node:fs';import {homedir} from 'node:os';import {handleCart} from './cart.mjs';
if(process.env.FORMBENCH_LOAD_ENV!=='0')try { process.loadEnvFile?.(fileURLToPath(new URL('../.env.local',import.meta.url))) } catch(e) { if(e.code!=='ENOENT')throw e }
let db;function getDb(env){if(!env.TAOBAO_APP_KEY||!env.TAOBAO_APP_SECRET||!env.TAOBAO_REDIRECT_URI)return undefined;if(!db){const dir=resolve(homedir(),'.formbench');mkdirSync(dir,{recursive:true,mode:0o700});const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');db=sqliteAdapter(new DatabaseSync(resolve(dir,'accounts.sqlite')));}return db;}
const localCapabilities=async(r,env)=>{const c=capabilities(env),list=designProviders(env),first=list[0];return Response.json({...await c.json(),...(first?{ai:true,designImages:true,aiProvider:first.id,aiModel:first.model}:{}),designProviders:list,cadEngine:forgePlanEngine(env),designJobs:true,reasoningEffort:env.OPENAI_REASONING_EFFORT||'max',shoppingWindow:new URL(r.url).port==='4173'&&await shoppingWindowReady()},{headers:c.headers})};
async function localDesign(req,env){const sink=debugSink(env,randomUUID());sink?.('discussion.start');try{return await routedDiscussion(req,observeRun(env,sink),{run:design,sink});}catch(e){sink?.('discussion.stop',{reason:e.name});return Response.json({error:e.message},{status:e.status||500});}}
const port=Number(process.env.PORT||4173),root=fileURLToPath(new URL('../dist/',import.meta.url));
http.createServer(async(req,res)=>{try {const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
if(pathname.startsWith('/api/')){const base=`127.0.0.1:${port}`,origin=`http://${base}`;if(req.headers.host!==base||(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return}
if(pathname==='/api/cart-status'){return await handleCart(req,res)}
const account=isAccountRoute(pathname),caps=pathname==='/api/capabilities',job=pathname.startsWith('/api/design-jobs'),asset=pathname.startsWith('/api/model-assets/');
const handler=job?designJobs:asset?modelAsset:account?(r,e)=>accounts(r,e,getDb(e)):caps?localCapabilities:({'/api/design':localDesign,'/api/shopping-window':shoppingWindow,'/api/shopping-window/claim':shoppingWindow,'/api/catalog':(r,e)=>buyerAction(r,e,'catalog',buyerSearch),'/api/cart':(r,e)=>buyerAction(r,e,'cart',buyerCart),'/api/forge/mcp/login':forgeLoginRequest,'/api/forge/mcp':forgeMcpRequest,'/api/forge':forge,'/api/forge/plan':forgePlan})[pathname];if(!handler){res.writeHead(404).end();return}
if(!account&&!job&&!asset&&(req.method!==(caps?'GET':'POST'))){res.writeHead(405).end();return}if(req.method==='POST'&&!account&&req.headers['content-type']?.split(';')[0]!=='application/json'){res.writeHead(415).end();return}
const byteLimit=pathname==='/api/design'||job?maxDesignRequestBytes:account||pathname==='/api/shopping-window'?512000:512000;
let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>byteLimit){res.writeHead(413).end();return}chunks.push(chunk)}const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);
const cancel=new AbortController();res.once('close',()=>{if(!res.writableEnded)cancel.abort()});const out=await handler(new Request(origin+req.url,{method:req.method,headers,signal:cancel.signal,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}),process.env);const responseHeaders=Object.fromEntries(out.headers);if(out.headers.has('set-cookie'))responseHeaders['set-cookie']=out.headers.getSetCookie();if(out.headers.get('content-type')?.startsWith('application/x-ndjson')){
 res.writeHead(out.status,responseHeaders);res.flushHeaders();
 try{await pipeline(Readable.fromWeb(out.body),res)}catch(error){if(!res.destroyed)res.destroy(error)}return
}
res.writeHead(out.status,responseHeaders).end(Buffer.from(await out.arrayBuffer()));return}
const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!path.startsWith(resolve(root)+sep)||!['HEAD','GET'].includes(req.method)){res.writeHead(404).end();return}const buf=await readFile(path);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.wasm':'application/wasm','.txt':'text/plain; charset=utf-8'})[extname(path)]||'application/octet-stream'}).end(req.method==='HEAD'?undefined:buf)}catch(e){res.writeHead(e.code==='ENOENT'?404:500).end()}}).listen(port,'127.0.0.1',()=>{console.log(`http://127.0.0.1:${port}`);debugSink(process.env,'server')?.('server.start');resumeRunningJobs(process.env).then(ids=>{if(ids.length)console.info('Resumed saved jobs:',ids.join(', '))}).catch(e=>console.error('Could not restore saved jobs:',e.code||e.name));})
