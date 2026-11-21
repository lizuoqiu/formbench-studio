import {validateCadPlan,cadPlanSchema} from './cad-plan.mjs';
import {modelingGuide,generation} from './modeling-guide.mjs';
import {catalog as models, matchHardware} from '../assembly-hardware.js';
import xiao from '../assets/hardware/xiao-esp32c3/metadata.json' with {type:'json'};
import pico from '../assets/hardware/pico/metadata.json' with {type:'json'};
import led from '../assets/hardware/led/metadata.json' with {type:'json'};
import button from '../assets/hardware/button/metadata.json' with {type:'json'};
import resistor from '../assets/hardware/resistor/metadata.json' with {type:'json'};
import screw from '../assets/hardware/screw/metadata.json' with {type:'json'};
import wire from '../assets/hardware/wire/metadata.json' with {type:'json'};
import cable from '../assets/hardware/usb-cable/metadata.json' with {type:'json'};
const refs={'xiao-esp32c3':xiao,pico,'red-led':led,'green-led':led,button,resistor,screw,wire,'usb-cable':cable};
const string={type:'string'},obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}),array=items=>({type:'array',items});
const role=['internal','external','panel','enclosure'];
export const schema=obj({name:string,summary:string,parts:array(obj({name:string,spec:string,qty:{type:'integer'},model:string,modelId:{type:'string',enum:['',...Object.keys(models)]},sizeMm:array({type:'number'}),dimensionSource:{type:'string',enum:['catalog','estimated','specified']},dimensionQuote:string,role:{type:'string',enum:role},purpose:string})),steps:array(string),cadPlan:cadPlanSchema});
export const instructions=`你是研究原型硬件设计师。根据用户当前需求，从零选择合适结构、器件、接口、供电与制造方式，并用中文说明具体步骤、装配和功能验证；不要把每个项目都做成 Pico 状态灯。列真实可识别的器件系列或可搜索的采购规格，不能确认型号时写待选型，自制外壳列入 BOM。每项包括数量、作用、安装位置（internal 内部、panel 面板、external 外部、enclosure 自制壳体）、三维外包络 sizeMm [长,宽,高] 毫米；不要用电路板尺寸代替含连接器的整个组件。估计写 estimated。确为用户给出的三维尺寸，可写 specified，并以 dimensionQuote 摘录含部件和毫米尺寸的用户原文；否则引用留空。目录ID仅在型号和封装符合时使用，没有匹配填空。目录只代表参考几何，不能声称验证购买 SKU、公差、库存、商家、价格或真实装配。可用几何参考：${Object.entries(models).map(([k,v])=>`${k}=${v.label}（${v.description}）`).join('；')}。未验证的供电、运动空间、安装孔位和功能在步骤中说明如何检查。`;
const str=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
const sizes=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&n>0&&n<=10000);
const triplet=/(\d+(?:\.\d+)?)\s*[x×*＊]\s*(\d+(?:\.\d+)?)\s*[x×*＊]\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)/ig;
function specified(p,prompt){const q=p.dimensionQuote;return str(q,500)&&prompt.includes(q)&&(q.toLowerCase().includes(p.name.toLowerCase())||q.toLowerCase().includes(p.model.toLowerCase()))&&Array.from(q.matchAll(triplet)).some(m=>p.sizeMm.every((v,k)=>v===Number(m[k+1])));}
export function normalizeDesign(raw,prompt){if(!str(raw?.name,200)||!str(raw.summary,5000)||!Array.isArray(raw.parts)||!raw.parts.length||raw.parts.length>60||!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>60||!raw.steps.every(s=>str(s,2000)))throw Error('invalid design');
 const parts=raw.parts.map(p=>{if(!str(p?.name,200)||!str(p.spec,800)||!str(p.model,240)||!Number.isInteger(p.qty)||p.qty<1||p.qty>999||!role.includes(p.role)||!sizes(p.sizeMm)||!str(p.purpose,500))throw Error('invalid part');
 const result={name:p.name.trim(),spec:p.spec.trim(),model:p.model.trim(),qty:p.qty,role:p.role,purpose:p.purpose.trim(),modelId:'',sizeMm:p.sizeMm,dimensionSource:'estimated',dimensionNote:'AI 估算的设计包络；采购和制作前须核对实物。',dimensionSourceUrl:''};
 if(p.dimensionSource==='specified'&&specified(p,prompt))return {...result,dimensionSource:'specified',dimensionNote:'需求原文：'+p.dimensionQuote};
 const id=matchHardware({...p,spec:p.spec+' '+p.model}),meta=id&&id===p.modelId&&refs[id];if(!meta)return result;
 const b=meta.boundsMm,dim=meta.sizeMm??(Array.isArray(b)?b[0].map((x,k)=>Number((b[1][k]-x).toFixed(3))):null);
 if(!sizes(dim))return result;return {...result,modelId:id,sizeMm:dim,dimensionSource:'catalog',dimensionNote:`目录参考模型外廓：${meta.label}；${meta.modelType==='dimensioned-approximation'?meta.description+' ':''}不代表已核对购买规格。`,dimensionSourceUrl:meta.measurementSourceUrl||meta.sourceUrl};});
 return {name:raw.name.trim(),summary:raw.summary.trim(),parts,steps:raw.steps.map(s=>s.trim()),cadPlan:validateCadPlan(raw.cadPlan,parts.length)};}
export async function design(request,env,send=fetch){const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply({error:'只支持 POST。'},405);
 if(!env.OPENAI_API_KEY||!env.OPENAI_MODEL)return reply({error:'设计服务尚未连接。'},503);
 const prompt=(await request.json().catch(()=>null))?.prompt;if(!str(prompt,10000))return reply({error:'设计说明须在 1–10000 字之间。'},400);
 try{const guide=await modelingGuide(env);const r=await send('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL,store:false,instructions:instructions+'\n'+guide.text,input:prompt,text:{format:{type:'json_schema',name:'hardware_design',strict:true,schema}}}),signal:AbortSignal.timeout(120000)});
 if(!r.ok)return reply({error:`模型服务返回 ${r.status}，未能生成方案。`},502);const data=await r.json();if(data.status!=='completed')throw Error();const txt=data.output.filter(i=>i.type==='message').flatMap(i=>i.content??[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');return reply({design:{...normalizeDesign(JSON.parse(txt),prompt),generation:generation('openai-api',data.model??env.OPENAI_MODEL,data.model?'response':'configured',guide.skill)}});
 }catch{return reply({error:'设计未完成或零件信息不完整，请重试。'},502);}}
