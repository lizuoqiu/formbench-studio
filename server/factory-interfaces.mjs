import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {factoryKinds} from '../part-records.js';
import {inspectProductDocument,matchesListedPartNumber} from './part-visual-reference.mjs';

const urlKey=v=>{try{const u=new URL(v);u.hash='';return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const plain=x=>String(x||'').normalize('NFKC').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;|&#34;/gi,'"').replace(/&apos;|&#39;/gi,"'").replace(/\s+/g,' ').trim();
const words=x=>' '+plain(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
const cues={touch:/touch|触摸|触控|タッチ/i,button:/button|push.?switch|按键|按钮|ボタン/i,display:/screen|display|lcd|oled|tft|e.ink|屏|显示|ディスプレイ/i,
clock:/real[ -]?time clock|\brtc\b|实时时钟|リアルタイムクロック/i,light:/\bled\b|indicator|指示灯|发光二极管/i,sound:/speaker|buzzer|扬声器|蜂鸣器|喇叭|スピーカー/i};
const unsupported=/\b(?:not included|not equipped|optional|sold separately|external accessory|without|no (?:built.in |onboard )?(?:touch|button|lcd|display|screen|rtc|speaker|buzzer|light))\b|选配|另购|未配备|不含|不带|无触控|不支持/i;
const listedCode=/(?:\b(?:SKU|MPN|manufacturer(?:['’]s)? part (?:number|no\.?)|order(?:ing)? (?:code|no\.?))\b|订货号|货号|品番|型番)\s*[:：#]?\s*([a-z0-9][a-z0-9._/+–-]*\d[a-z0-9._/+–-]*|\d+)/gi;
function matchesTechnicalModel(model,identity,issuer){
 const codes=[...new Set([...plain(identity).matchAll(listedCode)].map(m=>m[1].replace(/[.,]+$/,'')))];
 if(codes.length)return codes.length===1&&matchesListedPartNumber(model,codes[0],issuer);
 return words(identity).includes(words(model));
}
const installed=/(?:\bbuilt[- ]in\b|\bon[- ]?board\b|\bintegrated\b|\bequipped with\b|内置|板载|搭载|標準搭載)/i;
const peripheral=/\b(?:external|optional|connector|socket|header|accessory|no|not|without|supports?|compatible|can connect)\b|外接|外部|接口|插座|可选|选配|不支持/i;
const specific={...cues,touch:/touch[\s-]*(screen|panel|sensor)|触控屏|触摸屏|タッチパネル/i,display:/display|touch[\s-]*screen|lcd|oled|tft|液晶屏|显示屏|触摸屏|ディスプレイ/i,
 clock:/real[ -]?time clock|\bRTC\s+(?:chip|module|circuit|with)|实时时钟|リアルタイムクロック/i};
function installedQuote(passages,kind){
 for(const passage of passages){
  if(passage.length<8||passage.length>240||peripheral.test(passage)||unsupported.test(passage))continue;
  const marker=passage.search(installed),feature=passage.search(specific[kind]);
  if(marker>=0&&feature>=marker&&feature-marker<75)return passage;
 }
 return '';
}
function containsFeatureQuote(doc,quote){
 const key=plain(quote).toLowerCase();
 return doc.passages.some(s=>s.toLowerCase().includes(key)&&!unsupported.test(s)&&!/\b(?:no|not|without|optional|external accessory|connector for)\b/i.test(s));
}
function pdfText(bytes,signal){
 return new Promise((resolve,reject)=>{const p=execFile('pdftotext',['-layout','-','-'],{signal,timeout:12000,maxBuffer:3*1024*1024},(err,out)=>err?reject(err):resolve(out));p.stdin.on('error',()=>{});p.stdin.end(bytes);});
}
async function documentFor(doc,model,signal){
 const {bytes}=doc;if(!bytes?.length)return null;
 let body='',identity='',product=false;
 const issuer=[];
 try{issuer.push(...new URL(doc.url).hostname.split('.'));}catch{}
 if(bytes.subarray(0,5).toString()==='%PDF-'){body=await pdfText(bytes,signal);identity=body.slice(0,2400);issuer.push(plain(body.slice(0,260)));}
 else {
  const html=bytes.toString('utf8');const p=inspectProductDocument(doc,model,{withDescription:true});
  if(p.hasProduct){if(p.status!=='matched')return null;body=p.description;product=true;}
  else{
   const clean=html.replace(/<(script|style|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
   body=/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i.exec(clean)?.[1]||clean;
   const headings=[...body.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)].map(m=>m[1]);
   identity=[...headings,plain(body).slice(0,1900)].join(' ');
   issuer.push(plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1]),...headings.map(plain));
  }
 }
 const namedMakers=plain(identity).match(/(?:manufacturer|brand|制造商|品牌)\s*[:：]\s*[^.;。]{1,55}/gi)||[];
 if(!product&&!matchesTechnicalModel(model,identity,[...issuer,...namedMakers]))return null;
 const passages=body.replace(/<\/(?:p|li|tr|h[1-6])>|<br\s*\/?>/gi,'\n').split(/\n/).flatMap(p=>plain(p).split(/(?<=[。！？!?])|(?<=\.)\s+(?=[A-Z])/u)).filter(Boolean);
 return {passages,sha:createHash('sha256').update(bytes).digest('hex')};
}
// A search hit is a candidate. The exact model and quoted feature must appear
// in a document we can actually read. All endpoints of the installed product
// remain separate from these factory functions.
export async function verifyFactoryInterfaces(claims,record,fetchSource,signal,onCheck=()=>{}){
 if(!Array.isArray(claims)||!claims.length||record.identityStatus==='mismatch')return [];
 const seen=new Set(),pending=[];
 const urls=new Set((record.observedUrls||[]).map(urlKey).filter(Boolean));
 for(const c of claims.slice(0,12)){
  const u=urlKey(c?.sourceUrl),quote=typeof c?.quote==='string'?c.quote.trim():'';
  if(!u||!urls.has(u)||!factoryKinds.includes(c.kind)||typeof c.id!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(c.id)||seen.has(c.id)||quote.length<8||quote.length>240||!cues[c.kind].test(quote)||unsupported.test(quote))continue;
  seen.add(c.id);pending.push({id:c.id,kind:c.kind,quote,url:u,reason:'unreadable'});
 }
 if(!pending.length)return [];
 const tech=[...urls].filter(u=>/\b(?:docs|manual|datasheet|wiki)\b/i.test(new URL(u).hostname+' '+new URL(u).pathname)&&!/\.(?:zip|step|stp|stl)$/i.test(new URL(u).pathname));
 const candidates=[...new Set([...pending.map(p=>p.url),urlKey(record.sourceUrl),...tech,urlKey(record.productUrl)])].filter(u=>urls.has(u));
 for(const u of candidates.slice(0,6)){
  let doc;
  try{doc=await documentFor(await fetchSource(u,{signal,limit:6*1024*1024}),record.model,signal);}
  catch{signal?.throwIfAborted();continue;}
  for(const p of pending){
   if(p.result)continue;
   if(!doc){if(p.reason==='unreadable')p.reason='model-unconfirmed';continue;}
   const literal=containsFeatureQuote(doc,p.quote);
   const quote=literal?p.quote:installedQuote(doc.passages,p.kind);
   if(!quote){p.reason='quote-unconfirmed';continue;}
   p.result={id:p.id,kind:p.kind,model:record.model,quote,sourceUrl:u,sourceSha256:doc.sha};
   p.reason=literal?'literal':'document-statement';
  }
  if(pending.every(p=>p.result))break;
 }
 for(const p of pending)onCheck({id:p.id,kind:p.kind,status:p.result?'verified':'unverified',reason:p.reason});
 return pending.flatMap(p=>p.result?[p.result]:[]);
}
