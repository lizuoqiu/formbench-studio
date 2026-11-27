import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {factoryKinds} from '../part-records.js';
import {inspectProductDocument} from './part-visual-reference.mjs';
import {documentedPartIdentity} from './documented-part-identity.mjs';

const urlKey=v=>{try{const u=new URL(v);u.hash='';return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const plain=x=>String(x||'').normalize('NFKC').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;|&#34;/gi,'"').replace(/&apos;|&#39;/gi,"'").replace(/\s+/g,' ').trim();
const cues={touch:/touch|触摸|触控|タッチ/i,button:/button|push.?switch|按键|按钮|ボタン/i,display:/screen|display|lcd|oled|tft|e.ink|屏|显示|ディスプレイ/i,
clock:/real[ -]?time clock|\brtc\b|实时时钟|リアルタイムクロック/i,light:/\bled\b|indicator|指示灯|发光二极管/i,sound:/speaker|buzzer|扬声器|蜂鸣器|喇叭|スピーカー/i,
wifi:/\bwi[\s‐‑–-]?fi\b|\bWLAN\b|802\.11[a-z0-9]|无线局域网/i};
const unsupported=/\b(?:not included|not equipped|optional|sold separately|external accessory|without|no (?:built.in |onboard )?(?:touch|button|lcd|display|screen|rtc|speaker|buzzer|light))\b|选配|另购|未配备|不含|不带|无触控|不支持/i;
const listedCode=/(?:\b(?:SKU|MPN|manufacturer(?:['’]s)? part (?:number|no\.?)|order(?:ing)? (?:code|no\.?))\b|订货号|货号|品番|型番)\s*[:：#]?\s*([a-z0-9][a-z0-9._/+–-]*\d[a-z0-9._/+–-]*|\d+)/gi;
const installed=/(?:\bbuilt[- ]in\b|\bon[- ]?board\b|\bintegrated\b|\bequipped with\b|\b(?:device|unit|board|controller|instrument|module)\s+(?:features|includes|is fitted with)\b|内置|板载|搭载|標準搭載)/i;
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
const specLabel={touch:/^(?:(?:capacitive|resistive|integrated)\s+)*(?:touch[\s-]*screen|touch panel|触摸屏|触控面板)$/i,
 display:/^(?:(?:color|ips|tft|lcd|oled|integrated)\s+)*(?:screen|display|液晶屏|显示屏)$/i,
 clock:/^(?:(?:built[- ]in|onboard)\s+)?(?:rtc|real[ -]?time clock|实时时钟)$/i,
 button:/^(?:onboard |built-in |板载)(?:buttons?|按键)$/i,light:/^(?:onboard |built-in |板载)(?:led|indicator|指示灯)$/i,
 sound:/^(?:onboard |built-in |板载)?(?:speaker|buzzer|扬声器|蜂鸣器)$/i,
 wifi:/^(?:wi[\s‐‑–-]?fi(?:\s+(?:standard|protocol|radio))?|WLAN|无线局域网|wireless protocols?|无线协议)$/i};
const specHeading=/^(?:(?:(?:product|technical)\s+)?specifications?|specs|技术规格|规格参数|产品规格)$/i;
const modelLabel=/^(?:models?|model (?:numbers?|no\.?)|型号|产品型号)$/i;
// Many manufacturer sheets publish a model list and common properties as successive
// headings, then describe variant-specific bundle contents further down the page.
function headingModelSheet(html){
 const headings=[...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
 const sheets=[];
 for(let i=0;i<headings.length;i++){
  const header=headings[i],level=Number(header[1]);
  if(!specHeading.test(plain(header[2])))continue;
  const rows=[];
  for(let j=i+1;j<headings.length&&Number(headings[j][1])>level;j++){
   const field=headings[j];
   if(Number(field[1])!==level+1)continue;
   const value=plain(html.slice(field.index+field[0].length,headings[j+1]?.index??html.length));
   rows.push([plain(field[2]),value]);
  }
  if(rows.some(([label])=>modelLabel.test(label)))sheets.push(rows);
 }
 if(!sheets.length)return undefined;
 if(sheets.length!==1)return null;
 const rows=sheets[0],models=rows.filter(([k])=>modelLabel.test(k));
 if(models.length!==1)return null;
 const codes=models[0][1].split(/\s*[/,，、;；]\s*/u);
 if(codes.length>24||!codes.every(c=>c.length<=90&&/^(?=[\w.-]*\d)[\w.-]+$/u.test(c)))return null;
 return {codes,rows};
}
function technicalSpecifications(html,headingRows=[],sharedCodes=[]){
 const specs={};
 const rows=[...headingRows],conflicts=new Set();
 for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  rows.push([...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>plain(m[1])));
 }
 for(const cells of rows){
  if(cells.length!==2||!cells[1]||cells[1].length>130)continue;
  const [label,value]=cells;
  for(const [kind,pattern] of Object.entries(specLabel)){
   if(!pattern.test(label))continue;
   if(sharedCodes.length&&(sharedCodes.some(c=>value.toLowerCase().includes(c.toLowerCase()))||
      /\b(?:only|except|variant|optional|external|without|not|no)\b|仅限|除外|选配|不支持/i.test(value)))conflicts.add(kind);
   if(peripheral.test(value)||unsupported.test(value)||/^(?:0|n\/a|none|否|无|-+)$/i.test(value))continue;
   if(kind==='wifi'&&(!/802\.11|[2456](?:[.,]\d)?\s*GHz|built[- ]in|on[- ]?board|内置|板载/i.test(value)||
     /^(?:wireless|无线协议)/i.test(label)&&!cues.wifi.test(value)))continue;
   const quote=cells.join(' ');
   if(specs[kind]&&specs[kind]!==quote)conflicts.add(kind);
   else specs[kind]=quote;
  }
 }
 for(const kind of conflicts)delete specs[kind];
 return specs;
}
function pdfText(bytes,signal){
 return new Promise((resolve,reject)=>{const p=execFile('pdftotext',['-layout','-','-'],{signal,timeout:12000,maxBuffer:3*1024*1024},(err,out)=>err?reject(err):resolve(out));p.stdin.on('error',()=>{});p.stdin.end(bytes);});
}
async function documentFor(doc,model,proposal,selection,signal){
 const {bytes}=doc;if(!bytes?.length)return null;
 let body='',primary='',documentIdentity=null,specifications={},sheet;
 const makers=[],names=[];
 try{makers.push(...new URL(doc.url).hostname.split('.').filter(s=>s.length>2&&!['www','docs','shop','com','net','org','cdn'].includes(s)));}catch{}
 if(bytes.subarray(0,5).toString()==='%PDF-'){
  body=await pdfText(bytes,signal);
  primary=body.slice(0,2400);
  names.push(...primary.split(/\r?\n/).map(plain).filter(Boolean).slice(0,6));
 }
 else {
  const html=bytes.toString('utf8');const p=inspectProductDocument(doc,model,{withDescription:true,orderIdentity:proposal,selection});
  if(p.hasProduct){if(p.status!=='matched')return null;body=p.description;documentIdentity=p.documentIdentity;}
  else{
   const clean=html.replace(/<(script|style|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
   body=/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i.exec(clean)?.[1]||clean;
   const heading=/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
   const title=/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(clean);
   if(heading)names.push(plain(heading[1]));
   if(title)names.push(plain(title[1]));
   primary=plain(heading?body.slice(heading.index):body).slice(0,1900);
   sheet=headingModelSheet(body);
   if(sheet===null)return null;
   const shared=sheet?.codes.length>1;
   specifications=technicalSpecifications(shared?'':body,sheet?.rows,shared?sheet.codes:[]);
  }
 }
 if(!documentIdentity){
  const codes=[...new Set([...plain(primary).matchAll(listedCode)].map(m=>m[1].replace(/[.,]+$/,'')))];
  if(codes.length>1)return null;
  const byline=/(?:manufacturer|brand|制造商|品牌)\s*[:：]\s*([^<\n.;。]{1,90}?)(?=\s+(?:SKU|MPN|Model|Product|型号|订货号)\b|[<\n.;。]|$)/gi;
  makers.push(...[...primary.matchAll(byline)].map(m=>plain(m[1])));
  if(sheet&&codes.length&&!sheet.codes.includes(codes[0]))return null;
  const printedCodes=codes.length?codes:sheet?.codes||[];
  documentIdentity=documentedPartIdentity(model,{codes:printedCodes,names,manufacturers:makers,requireCode:printedCodes.length>0},proposal,selection);
  if(!documentIdentity)return null;
 }
 const passages=sheet?.codes.length>1?[]:body.replace(/<\/(?:p|li|tr|h[1-6])>|<br\s*\/?>/gi,'\n').split(/\n/).flatMap(p=>plain(p).split(/(?<=[。！？!?])|(?<=\.)\s+(?=[A-Z])/u)).filter(Boolean);
 return {passages,specifications,documentIdentity,sha:createHash('sha256').update(bytes).digest('hex')};
}
// A search hit is a candidate. The exact model and quoted feature must appear
// in a document we can actually read. All endpoints of the installed product
// remain separate from these factory functions.
export async function verifyFactoryInterfaces(claims,record,fetchSource,signal,onCheck=()=>{}){
 if(!Array.isArray(claims)||record.identityStatus==='mismatch')return [];
 const seen=new Set(),pending=[];
 const urls=new Set((record.observedUrls||[]).map(urlKey).filter(Boolean));
 for(const c of claims.slice(0,12)){
  const u=urlKey(c?.sourceUrl),quote=typeof c?.quote==='string'?c.quote.trim():'';
  if(!u||!urls.has(u)||!factoryKinds.includes(c.kind)||typeof c.id!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(c.id)||seen.has(c.id)||quote.length<8||quote.length>240||!cues[c.kind].test(quote)||unsupported.test(quote))continue;
  seen.add(c.id);pending.push({id:c.id,kind:c.kind,quote,url:u,reason:'unreadable'});
 }
 for(const kind of record.requiredFactoryFunctions||[]){
  if(!factoryKinds.includes(kind)||pending.some(p=>p.kind===kind))continue;
  let id=kind,suffix=1;
  while(seen.has(id))id=kind+'_'+(++suffix);
  seen.add(id);pending.push({id,kind,quote:'',url:'',reason:'unreadable'});
 }
 if(!pending.length)return [];
 const tech=[...urls].filter(u=>/\b(?:docs|manual|datasheet|wiki)\b/i.test(new URL(u).hostname+' '+new URL(u).pathname)&&!/\.(?:zip|step|stp|stl)$/i.test(new URL(u).pathname));
 const candidates=[...new Set([...pending.map(p=>p.url),urlKey(record.sourceUrl),...tech,urlKey(record.productUrl)])].filter(u=>urls.has(u));
 for(const u of candidates.slice(0,6)){
  let doc;
  try{doc=await documentFor(await fetchSource(u,{signal,limit:6*1024*1024}),record.model,record.proposedIdentity,record.selectedIdentity,signal);}
  catch{signal?.throwIfAborted();continue;}
  for(const p of pending){
   if(p.result)continue;
   if(!doc){if(p.reason==='unreadable')p.reason='model-unconfirmed';continue;}
   const literal=p.quote&&containsFeatureQuote(doc,p.quote)&&
     (p.kind!=='wifi'||doc.specifications.wifi?.includes(p.quote)||installedQuote([p.quote],'wifi'));
   const statement=literal?p.quote:installedQuote(doc.passages,p.kind);
   const quote=statement||doc.specifications[p.kind];
   if(!quote){p.reason='quote-unconfirmed';continue;}
   p.result={id:p.id,kind:p.kind,model:record.model,quote,sourceUrl:u,sourceSha256:doc.sha,documentIdentity:doc.documentIdentity};
   p.reason=literal?'literal':statement?'document-statement':'document-specification';
  }
  if(pending.every(p=>p.result))break;
 }
 for(const p of pending)onCheck({id:p.id,kind:p.kind,status:p.result?'verified':'unverified',reason:p.reason,
  ...(!p.result&&p.quote?{unverifiedQuote:p.quote,observedUrl:p.url}:{})});
 return pending.flatMap(p=>p.result?[p.result]:[]);
}
