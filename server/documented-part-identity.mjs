// Keep a revision or a decimal measurement in one token (v1.3 differs
// from v1.30). Only printed product fields take part in comparisons.
const words=value=>String(value??'').normalize('NFKC').toLowerCase()
  .replace(/&amp;/g,'&').replace(/(\d)[_](?=\d)/g,'$1.')
  .match(/[\p{L}\p{N}]+(?:\.[\p{N}]+[\p{L}]*)*/gu)||[];
const same=(left,right)=>left.length===right.length&&left.every((v,i)=>v===right[i]);
const hasSequence=(field,sequence)=>sequence.length>0&&field.some((_,i)=>same(field.slice(i,i+sequence.length),sequence));
function inOrder(sequence,field){
 let i=0;
 for(const word of field)if(sequence[i]===word)i++;
 return i===sequence.length;
}
const clean=value=>typeof value==='string'?value.trim().slice(0,240):'';
export function proposedOrderIdentity(value){
 if(!value||typeof value!=='object')return undefined;
 const parts=Object.fromEntries(['manufacturer','productName','orderCode','revision'].map(field=>[field,clean(value[field])]));
 return parts.orderCode||parts.productName?parts:undefined;
}
const named=values=>[...new Set(values.map(clean).filter(Boolean))].map(text=>({text,tokens:words(text)}));
function manufacturerMatch(phrase,makers){
 if(!phrase.length)return null;
 return makers.find(m=>same(m.tokens,phrase)||m.tokens.join('')===phrase.join(''))||null;
}
function wholeOrderCode(model,tokens){
 const escaped=tokens.map(t=>t.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&')).join('[\\s._/+–-]+');
 return new RegExp('(?<![\\p{L}\\p{N}._/+–-])'+escaped+'(?![\\p{L}\\p{N}]|[._/+–-][\\p{L}\\p{N}])','iu')
  .test(String(model).normalize('NFKC'));
}
export function selectedOrderIdentity(model,value){
 const spec=proposedOrderIdentity(value),selected=words(model);
 if(!spec?.manufacturer||!words(spec.orderCode).length||!wholeOrderCode(model,words(spec.orderCode))||
    !hasSequence(selected,words(spec.manufacturer)))return undefined;
 return spec;
}
function versionLabel(text){
 return String(text).match(/\b(?:v(?:er(?:sion)?)?|rev(?:ision)?)\.?\s*\d+(?:[._-]\d+)*[a-z]?\b/i)?.[0]||'';
}
function printedVersion(value,fields){
 const wanted=words(value);
 const key=t=>String(t).toLowerCase().replace(/^(?:v(?:er(?:sion)?)?|rev(?:ision)?)\.?\s*/,'').replaceAll('_','.');
 return !wanted.length||fields.some(t=>hasSequence(t.tokens,wanted)||versionLabel(t.text||t.tokens.join(' '))&&
    key(versionLabel(t.text||t.tokens.join(' ')))===key(value));
}
function sourceFields(extra,makers,titles){
 if(!extra.length)return {maker:null,title:titles[0]};
 const maker=manufacturerMatch(extra,makers);
 if(maker)return {maker,title:titles[0]};
 for(let i=1;i<extra.length;i++){
  const first=extra.slice(0,i),last=extra.slice(i);
  for(const [brand,product] of [[first,last],[last,first]]){
   const found=manufacturerMatch(brand,makers);
   if(!found)continue;
   const title=titles.find(t=>inOrder(product,t.tokens));
   if(title)return {maker:found,title};
  }
 }
 const title=titles.find(t=>inOrder(extra,t.tokens));
 return title?{maker:null,title}:null;
}
// A seller SKU, manufacturer code, product title and issuer may be separate.
// Every qualifier left in the selected BOM entry must be present in the
// issuer or in a single product title. Descriptive body text is never a title.
export function documentedPartIdentity(model,{codes=[],manufacturers=[],names=[],requireCode=false},proposal,selection){
 const selected=words(model),makers=named(manufacturers),titles=named(names);
 if(!selected.length)return null;
 const proposed=proposedOrderIdentity(proposal);
 const ordered=selectedOrderIdentity(model,selection);
 for(const entry of codes){
  const code=String(entry??'').trim(),tokens=words(code);
  if(!tokens.length||!wholeOrderCode(model,tokens))continue;
  const start=selected.findIndex((_,i)=>same(selected.slice(i,i+tokens.length),tokens));
  if(start<0)continue;
  const extra=[...selected.slice(0,start),...selected.slice(start+tokens.length)];
  let fields=sourceFields(extra,makers,titles);
  if(ordered){
   if(!same(words(ordered.orderCode),tokens))continue;
   const maker=manufacturerMatch(words(ordered.manufacturer),makers);
   const product=words(ordered.productName),brand=words(ordered.manufacturer);
   const productWords=same(product.slice(0,brand.length),brand)?product.slice(brand.length):product;
   const namedTitle=productWords.length&&titles.find(t=>inOrder(productWords,t.tokens));
   if(ordered.revision&&titles.some(t=>versionLabel(t.text))&&!printedVersion(ordered.revision,titles))continue;
   if(maker&&namedTitle){
    const versions=[ordered.revision,versionLabel(model)].filter(Boolean);
    if(!versions.every(v=>printedVersion(v,[namedTitle,{tokens}])))continue;
    const checkable=extra.filter(word=>/\d/u.test(word)||/^[\p{Script=Latin}.]+$/u.test(word));
    if(!sourceFields(checkable,makers,[namedTitle]))continue;
    // The design selected the brand and MPN before looking at this source.
    // Its marketing description may be translated; the printed identity,
    // complete product name and stated revision have independent evidence.
    fields={maker,title:namedTitle};
   }
  }
  if(!fields)continue;
  const maker=fields.maker||manufacturerMatch(words(proposed?.manufacturer),makers);
  if(/^\d+$/.test(code)&&!extra.length&&!maker)continue;
  const title=fields.title?.text||'';
  const version=versionLabel(title);
  const skuInfo={orderCode:code,manufacturer:maker?.text||'',productName:title,revision:version||''};
  if(proposed?.revision&&hasSequence(words(title+' '+code),words(proposed.revision)))skuInfo.revision=proposed.revision;
  return skuInfo;
 }
 // A part sold under its complete name can lack a public order code. If an
 // order code was requested and the document prints another, do not fall back.
 if(requireCode||proposed?.orderCode&&codes.length&&hasSequence(selected,words(proposed.orderCode)))return null;
 const title=titles.find(t=>hasSequence(t.tokens,selected));
 return title?{orderCode:'',manufacturer:'',productName:title.text,revision:''}:null;
}
