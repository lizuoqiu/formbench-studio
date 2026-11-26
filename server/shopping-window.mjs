// Local desktop handoff. The launch accepts a design, never a navigation URL or browser argument.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAX_DESIGN_PARTS} from '../cad-plan.js';
const home=join(homedir(),'.formbench');
const chrome=()=>process.env.FORMBENCH_SHOPPING_CHROMIUM||join(home,'browser','chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing');
const extension=fileURLToPath(new URL('../extension',import.meta.url));
const handoffs=new Map();
export async function shoppingWindowReady(){return access(chrome(),constants.X_OK).then(()=>true,()=>false);}
export async function shoppingWindow(req){
 const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}}),u=new URL(req.url);
 if(u.origin!=='http://127.0.0.1:4173'||req.method!=='POST'||req.headers.get('origin')!==u.origin)return reply({error:'仅限本机同源工作台。'},403);
 const data=await req.json().catch(()=>null);for(const [id,h] of handoffs)if(h.exp<Date.now())handoffs.delete(id);
 if(u.pathname==='/api/shopping-window/claim'){
   const h=handoffs.get(data?.token);if(!h)return reply({error:'这个采购窗口链接已使用或已过期，请从原设计重新打开。'},404);
   handoffs.delete(data.token);return reply({record:h.record});
 }
 const r=data?.record;if(!r?.design||!Array.isArray(r.design.parts)||!r.design.parts.length||r.design.parts.length>MAX_DESIGN_PARTS||!Array.isArray(r.selected)||r.selected.length!==r.design.parts.length)return reply({error:'没有收到完整设计和采购清单。'},400);
 if(!await shoppingWindowReady())return reply({error:'本机尚未配置专用 Chromium。'},503);
 const token=randomBytes(24).toString('hex');const profile=join(home,'shopping-profile');await mkdir(profile,{recursive:true,mode:0o700});
 handoffs.set(token,{exp:Date.now()+120000,record:{design:r.design,selected:r.selected}});
 try{const child=spawn(chrome(),[`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check', '--new-window',`http://127.0.0.1:4173/#shopping=${token}`],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve)});child.unref();}catch{handoffs.delete(token);return reply({error:'无法启动专用采购窗口。'},503);}
 return reply({state:'launched'});
}
