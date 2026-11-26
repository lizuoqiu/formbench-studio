import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {factoryKinds} from '../part-records.js';
import {inspectProductDocument} from './part-visual-reference.mjs';

const urlKey=v=>{try{const u=new URL(v);u.hash='';return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const plain=x=>String(x||'').normalize('NFKC').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;|&#34;/gi,'"').replace(/&apos;|&#39;/gi,"'").replace(/\s+/g,' ').trim();
const words=x=>' '+plain(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
const cues={touch:/touch|触摸|触控|タッチ/i,button:/button|push.?switch|按键|按钮|ボタン/i,display:/screen|display|lcd|oled|tft|e.ink|屏|显示|ディスプレイ/i,
clock:/real[ -]?time clock|\brtc\b|实时时钟|リアルタイムクロック/i,light:/\bled\b|indicator|指示灯|发光二极管/i,sound:/speaker|buzzer|扬声器|蜂鸣器|喇叭|スピーカー/i};
const unsupported=/\b(?:not included|not equipped|optional|sold separately|external accessory|without|no (?:built.in |onboard )?(?:touch|button|lcd|display|screen|rtc|speaker|buzzer|light))\b|选配|另购|未配备|不含|不带|无触控|不支持/i;
function pdfText(bytes,signal){
 return new Promise((resolve,reject)=>{const p=execFile('pdftotext',['-layout','-','-'],{signal,timeout:12000,maxBuffer:3*1024*1024},(err,out)=>err?reject(err):resolve(out));p.stdin.on('error',()=>{});p.stdin.end(bytes);});
}
async function documentFor(doc,model,signal){
 const {bytes}=doc;if(!bytes?.length)return null;
 let body='',identity='',product=false;
 if(bytes.subarray(0,5).toString()==='%PDF-'){body=await pdfText(bytes,signal);identity=body.slice(0,2400);}
 else {
  const html=bytes.toString('utf8');const p=inspectProductDocument(doc,model,{withDescription:true});
  if(p.hasProduct){if(p.status!=='matched')return null;body=p.description;product=true;}
  else{
   const clean=html.replace(/<(script|style|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
   body=/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i.exec(clean)?.[1]||clean;
   const headings=[...body.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)].map(m=>m[1]);
   identity=[...headings,plain(body).slice(0,1200)].join(' ');
  }
 }
 if(!product&&!words(identity).includes(words(model)))return null;
 return {text:plain(body).toLowerCase(),sha:createHash('sha256').update(bytes).digest('hex')};
}
// A search hit is a candidate. The exact model and quoted feature must appear
// in a document we can actually read. All endpoints of the installed product
// remain separate from these factory functions.
export async function verifyFactoryInterfaces(claims,record,fetchSource,signal){
 if(!Array.isArray(claims)||!claims.length||record.identityStatus==='mismatch')return [];
 const seen=new Set(),docs=new Map(),out=[];
 const urls=new Set((record.observedUrls||[]).map(urlKey).filter(Boolean));
 for(const c of claims.slice(0,12)){
  const u=urlKey(c?.sourceUrl),quote=typeof c?.quote==='string'?c.quote.trim():'';
  if(!u||!urls.has(u)||!factoryKinds.includes(c.kind)||typeof c.id!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(c.id)||seen.has(c.id)||quote.length<8||quote.length>240||!cues[c.kind].test(quote)||unsupported.test(quote))continue;
  if(!docs.has(u)){
   if(docs.size>=4)continue;
   try{docs.set(u,await documentFor(await fetchSource(u,{signal,limit:6*1024*1024}),record.model,signal));}
   catch{signal?.throwIfAborted();docs.set(u,null);}
  }
  const d=docs.get(u);if(!d?.text.includes(plain(quote).toLowerCase()))continue;
  seen.add(c.id);out.push({id:c.id,kind:c.kind,model:record.model,quote,sourceUrl:u,sourceSha256:d.sha});
 }
 return out;
}
