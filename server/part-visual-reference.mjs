import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceFetch} from './source-files.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const compact=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const attr=(tag,key)=>(tag.match(new RegExp('\\b'+key+'=["\\\']([^"\\\']*)["\\\']','i'))||[])[1]||'';
const has=(text,key)=>!!key&&(' '+compact(text)+' ').includes(' '+compact(key)+' ');
function productBlocks(value){if(!value||typeof value!=='object')return [];return [...([value['@type']].flat().some(t=>String(t).toLowerCase()==='product')?[value]:[]),...Object.values(value).filter(x=>x&&typeof x==='object').flatMap(productBlocks)];}
function picture(x){return typeof x==='string'?x:Array.isArray(x)?picture(x[0]):x?.contentUrl||x?.url||'';}
function urlAt(value,base){try{const u=new URL(value,base);return value&&['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}}
// Match the selected product, not a code found in navigation, a related-product list or a variant table.
export function inspectProductDocument(resource={},model){
 const {bytes,url}=resource;if(!bytes?.length)return {status:'unverified',reason:'empty'};
 const html=Buffer.from(bytes).toString('utf8');const sourceSha256=sha(bytes),meta=[...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>m[0]);
 const tag=key=>attr(meta.find(m=>[attr(m,'property'),attr(m,'name')].includes(key))||'','content');
 const headings=[...html.matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m=>m[2].replace(/<[^>]+>/g,' ')).concat(tag('og:title')).filter(Boolean);
 const products=[];for(const [,data] of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{products.push(...productBlocks(JSON.parse(data)));}catch{}}
 const identity=p=>{
  const brand=typeof p.brand==='string'?p.brand:p.brand?.name;
  const codes=[p.mpn,p.sku].filter(x=>typeof x==='string'||Number.isInteger(x));
  // A distributor SKU can be different from the manufacturer's number. A complete model name
  // in the product's own title is also evidence; a numeric fragment on its own isn't.
  return has(p.name,model)||codes.some(c=>compact(model)===compact(c)||has(model,c)&&(/\d/.test(c)&&/[a-z]/i.test(c)||brand&&has(model,brand)));
 };
 const family=/\b(?:series|choose (?:a |your )?(?:model|variant)|product family|product group)\b|选择(?:具体)?型号|产品系列/i;
 const familyPage=products.length>1||headings.some(h=>family.test(h))||/"@type"\s*:\s*"ProductGroup"/i.test(html);
 const samePage=v=>{try{return !!v&&new URL(v,url).href===new URL(url).href;}catch{return false;}};
 const ownsPage=p=>[p.url,...[p.offers||[]].flat().map(o=>o?.url)].some(samePage);
 const selected=familyPage?products.filter(ownsPage):products;
 const sole=selected.length===1&&identity(selected[0])?selected[0]:null;
 const heading=!products.length&&!familyPage&&headings.find(h=>has(h,model));
 const matched=Boolean(sole||heading);
 return {status:matched?'matched':familyPage?'family':'unverified',reason:matched?sole?'product-identity':'product-heading':'no-single-variant',sourceSha256,url,evidence:matched?String(sole?.name||sole?.mpn||heading).slice(0,200):'',imageUrl:matched?urlAt(picture(sole?.image)||(!familyPage&&tag('og:image')),url):''};
}
function imageType(b){if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(b.length>10&&b[0]===255&&b[1]===216&&b[2]===255)return'image/jpeg';if(b.length>16&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return'image/webp';return '';}
async function pdfCover(bytes,signal){
 const dir=await mkdtemp(join(tmpdir(),'formbench-drawing-'));
 try{await writeFile(join(dir,'drawing.pdf'),bytes);await promisify(execFile)('pdftoppm',['-f','1','-l','1','-singlefile','-scale-to','1200','-png',join(dir,'drawing.pdf'),join(dir,'page')],{timeout:12000,signal,maxBuffer:100000});return await readFile(join(dir,'page.png'));}
 finally{await rm(dir,{recursive:true,force:true});}
}
export async function loadPartVisual(record,signal,fetchSource=sourceFetch){
 const refs=[record.visualUrl,record.productIdentityCheck?.status==='matched'&&record.productIdentityCheck.imageUrl,record.sourceUrl&&/\.pdf(?:$|[?#])/i.test(record.sourceUrl)&&record.sourceUrl].filter(Boolean);
 for(const url of new Set(refs)){try{const r=await fetchSource(url,{signal,limit:5*1024*1024});let b=Buffer.from(r.bytes);let extra={};if(b.subarray(0,5).toString()==='%PDF-'){extra={sourceSha256:sha(b),page:1};b=await pdfCover(b,signal);}const type=imageType(b);if(type)return {meta:{url:r.url||url,mime:type,sha256:sha(b),...extra},content:`data:${type};base64,${b.toString('base64')}`};}catch(e){if(signal?.aborted)throw e;}}
 return null;
}
export function withVisualInput(text,visual){return visual?[{role:'user',content:[{type:'input_text',text},{type:'input_image',image_url:visual.content,detail:'auto'}]}]:text;}
