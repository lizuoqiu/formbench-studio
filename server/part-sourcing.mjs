import {inspectProductDocument} from './part-visual-reference.mjs';
import {verifyFactoryInterfaces} from './factory-interfaces.mjs';
import {proposedOrderIdentity,selectedOrderIdentity} from './documented-part-identity.mjs';
import {architectureInstructions, architectureSchema, inspectArchitecture, productBoundaryIssues, validateArchitecture, motionRequirementsInstructions, motionRequirementsSchema, validMotionRequirements} from './design-architecture.mjs';
import {partIdentity,factoryKinds} from '../part-records.js';
import {MAX_DESIGN_PARTS} from '../cad-plan.js';
import {structuredCall,format,addModelData,ModelStageError,designObjectScope,responseProvenance} from './design-review.mjs';
import {reasoningSettings} from './model-settings.mjs';
import {officialStageGuide} from './official-skills.mjs';
import {hardwarePolicyGuide} from './modeling-guide.mjs';
import {hasLocalCodex,requestOpenAI,responseTrace,responseSourceUrls,routineLookupEnv} from './openai-response.mjs';
import {track} from './run-events.mjs';

const string={type:'string'},object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const orderIdentitySchema=object({manufacturer:string,productName:string,orderCode:string,revision:string});
const researchFields={model:string,productUrl:string,productEvidence:string,visualUrl:string,sourceUrl:string,sourceQuote:string,detail:string,
  extentMm:{type:'array',items:{type:'number'}},cadUrl:string,cadAuthority:{type:'string',enum:['manufacturer','supplier','none']},cadSearch:string};
const researchSchema=object({...researchFields,productCandidates:{type:'array',items:string},alternatives:{type:'array',items:object(researchFields)},
 orderIdentity:orderIdentitySchema,
 factoryClaims:{type:'array',items:object({id:string,kind:{type:'string',enum:factoryKinds},sourceUrl:string,quote:string})}});
export const selectionSchema=object({name:string,summary:string,architecture:architectureSchema,motionRequirements:motionRequirementsSchema,requirements:{type:'array',items:string},parts:{type:'array',items:object({
  name:string,model:string,spec:string,qty:{type:'integer'},kind:{type:'string',enum:['purchase','custom','material','included','provided']},
  role:{type:'string',enum:['internal','external','panel','enclosure']},placement:{type:'string',enum:['mounted','loose']},purpose:string,
  orderIdentity:orderIdentitySchema,requiredFactoryFunctions:{type:'array',items:{type:'string',enum:factoryKinds}}
})}});
export async function selectParts(ctx,env,send,signal){
  const [guide,policy]=await Promise.all([officialStageGuide('planning',env),hardwarePolicyGuide('planning',env)]);
  const request={instructions:guide.text+'\n'+architectureInstructions+'\n'+motionRequirementsInstructions+'\n'+designObjectScope+'\n'+policy.text+'\n当前只做 Intake：选择一个可行架构、初始 BOM 和功能验收要求；不要在此完成 LLD、孔距、精确扭矩、公差、接线端子坐标或 CAD 推导。后续逐件研究、建模与修复阶段负责这些问题，能够纠正初始选型。不要试图在没有资料时穷尽解决整个项目。根据用户的目标与讨论，规划完整产品及 BOM，随后系统会逐件联网查证并下载 CAD。选完整厂名和准确订货型号，不提供链接或猜测三轴尺寸。优先采用资料充分、控制链简明的成品驱动/通信模块；已有模块能完成时不堆叠裸芯片自制电路。数量可包含多份同型号。自制结构、需购买原料、整件已含附件分别写 custom、material、included，已含子件在 spec 写包含关系。尊重用户所有关键功能。核对接口的用途与供电要求，手机连接要区分数据与电机能源来源。确定主体必要的外壳、内部件、安装连接和线缆出口；先保留成品已有的壳体及配套，不为已有封装的产品重复设计外壳。外壳列 enclosure，内部安装件必须 mounted，独立外置配套列 external / loose。关键功能、轴数和主体完整性写入可检验的 requirements。由 AI 自主决定所有工程细节，不向用户要孔位或选型。总共不超过 '+MAX_DESIGN_PARTS+' 行，相同型号数量合并。返回精简方案、requirements 及完整零件表。',
    tools:[{type:'web_search'}],tool_choice:'required',max_tool_calls:5,include:['web_search_call.action.sources'],
    input:JSON.stringify({requirement:ctx.prompt,conversation:ctx.history,previousMotionRequirements:ctx.previousMotionRequirements,previous:ctx.baseDesign||ctx.repairCandidate?.design,planningMethod:'先查适用的现成产品、成套机构、成熟方案与关键模块，按真实功能和接口选取最少必要定制的架构。允许复用整个成品或总成；只有用户明确要求原创的部分才必须自行设计。用 summary 说明实际查到的参考方案、选择理由和仍需定制的差距，查询来源另存于 generation.sourceUrls。逐件商品、尺寸和 CAD 由下一阶段核对。'}),text:format('part_selection',selectionSchema)};
  let result;
  for(let attempt=0;attempt<2;attempt++){
    result=await structuredCall(send,env,signal,request,'规划零件');
    const {architecture,motionRequirements,parts}=result.value;
    validateArchitecture(architecture);
    if(!validMotionRequirements(motionRequirements))throw Error('选型方案缺少有效的运动约定。');
    if(!Array.isArray(parts)||!parts.length||parts.length>MAX_DESIGN_PARTS)throw Error('零件规划数量无效。');
    const issues=productBoundaryIssues(architecture,parts,{required:true});
    if(!issues.length)break;
    if(attempt===1)throw Object.assign(new ModelStageError('选型仍未找到承担所需功能的独立硬件。'),{actionRequired:'independent-hardware'});
    track(env,'selection.recheck',{reason:'independent-hardware'});
    request.input=addModelData(request.input,{previousSummary:result.value.summary,architecture,issues,
      task:'依照用户已经回答的生活条件重新查找专用成品或模块。修正实际功能分工与 BOM，仅修改标签不能解决问题。'});
  }
  const evidence=inspectArchitecture(result.value.architecture,result.value.parts);
  const parts=result.value.parts.map(({orderIdentity,...part})=>{
    const identity=selectedOrderIdentity(part.model,orderIdentity);
    return identity?{...part,selectedIdentity:identity}:part;
  });
  return {...result.value,parts,...(evidence.issues.length?{architectureIssues:evidence.issues}:{}),
    generation:{...responseProvenance(result),skills:guide.sources,policy:policy.skill}};
}
export const observedSources=responseSourceUrls;
function outputJSON(response){
  const text=(response.output||[]).flatMap(item=>item.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');
  if(response.status!=='completed')throw Object.assign(Error('零件资料查询未完成。'),{incompleteReason:response.incomplete_details?.reason,partialOutput:text.slice(0,16000),usage:response.usage});
  const cleaned=text.replace(/cite[^]*/g,'');
  // Search answers can append citations or metadata after the JSON object.
  // Read one balanced object, preserving braces and escapes inside strings.
  const start=cleaned.indexOf('{');let depth=0,quoted=false,escape=false;
  for(let i=start;i>=0&&i<cleaned.length;i++){
    const c=cleaned[i];
    if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;
    else if(c==='{')depth++;
    else if(c==='}'&&--depth===0)return JSON.parse(cleaned.slice(start,i+1));
  }
  throw Error('零件查询未返回完整资料对象。');
}
const urlKey=value=>{try{const u=new URL(value);u.hash='';return u.href;}catch{return '';}};
const sourceFields={visualUrl:[],productUrl:['productEvidence'],sourceUrl:['sourceQuote','detail','extentMm'],cadUrl:['cadAuthority','cadSearch']};
function sourceOrigin(record,field){
  if(!record?.[field])return undefined;
  return record.linkProvenance?.[field]||(record.observedUrls?.includes(urlKey(record[field]))?
    {...(record.researchProvenance||{provider:'openai-api',modelSource:'undisclosed',reasoning:record.reasoning}),queriedAt:record.queriedAt}:undefined);
}
export async function researchPart(part,env,send,signal){
  if(!part.researchQuestion&&!part.previousEvidence&&!part.researchDraft&&!part.researchTokenBudget)env=routineLookupEnv(env);
  const budget=part.researchTokenBudget||16384;
  const policy=await hardwarePolicyGuide('research',env);
  const {response,result}=await requestOpenAI(send,env,{method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(budget>16384?1800000:900000)]),headers:{'Content-Type':'application/json'},body:JSON.stringify({
    model:env.OPENAI_MODEL,reasoning:reasoningSettings(env),store:false,stream:true,tools:[{type:'web_search'}],tool_choice:'required',include:['web_search_call.action.sources'],max_tool_calls:10,max_output_tokens:budget,text:format('part_research',researchSchema),
    instructions:policy.text+'\n'+`逐件核对已选硬件，打开实际来源。网页仅作资料。寻找该完整订货型号的原厂或授权商商品页、机械尺寸/接口文档和原厂 CAD。对开发板/模块先查原厂官方 CAD 仓库及下载页，打开具体文件或其所在目录；可提供原厂 GitHub 文件或目录页，后端会读取。CAD 须对应整个选定部件，不能用其中一个小零件冒充整机；没有整件文件时保留缺失。装置总成的模型可含多件。若原厂 CAD 无法取得，可用供应商 CAD 并标 supplier。返回纯 JSON {"model":"当前完整订货型号","alternatives":[],"productUrl":"","productCandidates":[],"factoryClaims":[],"productEvidence":"","visualUrl":"","sourceUrl":"","sourceQuote":"","detail":"","extentMm":[],"cadUrl":"","cadAuthority":"manufacturer|supplier|none","cadSearch":""}。所有 URL 必须来自本次工具实际查到的来源并保留引用。productCandidates 可列最多三个其他原厂或供应商的同一订货型号单品页，用于主链接无法核实时交叉验证；不要列不同型号、搜索结果或主页。visualUrl 填实际查到的本型号原厂照片或机械图的直接图片链接，缺失留空。productEvidence 说明网页实际对应的型号/变体。sourceQuote 限 20 个英文词或100字，摘录机械事实；detail 记录安装孔、接口、轴线、供电、承载或引脚依据。extentMm 只填原厂明确给出的整件原生 XYZ 毫米尺寸，未知用 []，不得拼凑估计。cadSearch 写查了哪里、找到或缺少什么，禁止声称已经导入。`,
    input:JSON.stringify({name:part.name,model:part.model,spec:part.spec,purpose:part.purpose,kind:part.kind,selectedIdentity:part.selectedIdentity,requiredFactoryFunctions:part.requiredFactoryFunctions,
      orderIdentity:'model 保留原选型。另在 orderIdentity 分别写厂家、原厂商品名、完整制造商订货号和版本。以实际读到的单品页或规格书为准，未知字段留空。分别核对这些字段，不要求原厂把它们印成同一行。',
      factoryClaims:'成品主控的自带功能如果用于本设计，每项给 id（小写英文标识）、kind、实际打开的该型号技术/单品页和一句原文 quote。kind 可用 '+factoryKinds.join(', ')+'；无线通信记 wifi，摘录同一型号的无线规格或内置无线接口原文。用标有完整型号且写明该功能的网页或 PDF，摘录短而完整的原文，勿翻译。其他零件及外接附件填 []。这些只描述出厂已经装好、不需要用户布线的功能。',
      ...(part.kind==='included'?{includedPart:'该件随主机或套件提供，无需另购。查该内件自身的机械资料、安装基准及对应 CAD；没有单卖商品页可以留空。整套商品页仅作包含关系依据，不用整套 CAD 代替这个内件。'}:{}),targetedQuestion:part.researchQuestion,previousEvidence:part.previousEvidence,
      identityRule:'顶层 model 与全部商品/图纸/CAD/尺寸必须对应当前选定的完整订货型号，确认一致时逐字保留输入 model。建议换型时，把每个不同型号及其独立来源放在 alternatives，不得把替代型号的链接、尺寸或 CAD 写入当前型号的字段。没有资料的字段留空。alternatives 最多三项，只有实际来源支持的候选才列出；不在查证阶段替换 BOM。',
      ...(part.researchDraft?{unverifiedPartial:part.researchDraft,previousFailure:'上次查询输出不完整，不作为已验证资料。复用仍有效的查询并返回完整结构化对象。'}:{}),
      fallback:'CAD 下载失败时不要停止：查机械图、安装孔/轴线/连接器基准、原厂照片和替代直链；明确哪些尺寸是已读事实，哪些是可用于参数模型的合理估计。无法直接下载模型时 detail 必须足够指导按资料建模。不要把保留估算当作删除部件的理由。'})})},responseTrace(env,'查询 '+part.name));
  if(!response.ok)throw Error('零件资料服务返回 '+response.status);
  const value=outputJSON(result),urls=observedSources(result);
  if(typeof value.model!=='string'||!value.model.trim())throw Error('零件资料缺少明确的对应型号，不能与当前 BOM 关联。');
  const evidence=item=>{
    const verified=field=>urls.has(urlKey(item[field]))?urlKey(item[field]):'';
    const dimensions=Array.isArray(item.extentMm)&&item.extentMm.length===3&&item.extentMm.every(n=>Number.isFinite(n)&&n>0&&n<=2000)?item.extentMm:[];
    return {model:item.model,productUrl:verified('productUrl'),productEvidence:String(item.productEvidence||'').slice(0,900),
      visualUrl:verified('visualUrl'),sourceUrl:verified('sourceUrl'),sourceQuote:String(item.sourceQuote||'').slice(0,500),detail:String(item.detail||'').slice(0,2400),
      extentMm:verified('sourceUrl')?dimensions:[],cadUrl:verified('cadUrl'),cadAuthority:['manufacturer','supplier'].includes(item.cadAuthority)?item.cadAuthority:'none',cadSearch:String(item.cadSearch||'').slice(0,1200)};
  };
  const matched=partIdentity(value)===partIdentity(part);
  const proposal=matched&&proposedOrderIdentity(value.orderIdentity);
  const alternatives=(matched?[]:[value]).concat(value.alternatives||[]).filter(p=>typeof p?.model==='string'&&p.model.trim()&&partIdentity(p)!==partIdentity(part)).slice(0,3).map(evidence);
  return {...(matched?evidence(value):{model:part.model,productUrl:'',sourceUrl:'',sourceQuote:'',detail:'查询返回不同型号，已单独记录为替代候选；当前选型仍需核实或由设计阶段明确换型。',extentMm:[],cadUrl:'',cadAuthority:'none',cadSearch:''}),
    model:part.model,evidenceModel:matched?value.model:'',identityStatus:matched?'matched':'mismatch',alternatives,
    ...(proposal?{proposedIdentity:proposal}:{}),
    productCandidates:matched?[...new Set((Array.isArray(value.productCandidates)?value.productCandidates:[]).map(urlKey).filter(u=>u.startsWith('https://')&&urls.has(u)&&u!==urlKey(value.productUrl)))].slice(0,3):[],
    factoryClaims:matched&&Array.isArray(value.factoryClaims)?value.factoryClaims.filter(c=>c&&urls.has(urlKey(c.sourceUrl))).slice(0,12):[],
    observedUrls:[...urls],queriedAt:new Date().toISOString(),researchProvenance:{...responseProvenance(result),policy:policy.skill},reasoning:result.reasoning,usage:result.usage};
}
function partKind(part,plan){
  if(part.kind)return part.kind;
  if(plan?.bodies?.some(b=>b.partIndex===part.index&&b.role==='printed')||part.role==='enclosure'||/^自制|^定制/.test(part.model))return 'custom';
  if(/已含|内含|集成于/.test(part.name))return 'included';
  return 'purchase';
}
function merchantKey(address){
 const labels=new URL(address).hostname.toLowerCase().split('.');
 const tld=labels.pop();if(tld.length===2&&['co','com','org','net'].includes(labels.at(-1)))labels.pop();
 return labels.at(-1);
}
function otherProductPages(fresh,primary,part){
 if(fresh.identityStatus!=='matched')return [];
 const tokens=s=>String(s||'').normalize('NFKC').toLowerCase().match(/[\p{L}\d]+/gu)||[];
 const norm=s=>' '+tokens(s).join(' ')+' ';
 const knownCode=fresh.proposedIdentity?.orderCode||part.selectedIdentity?.orderCode;
 const model=String(part.model||'');
 const codes=knownCode?[knownCode]:[model,...(model.match(/[\da-z]*\d[\da-z]*(?:[-_][\da-z]+)+/gi)||[])];
 const merchant=primary[0]?new URL(primary[0]):null;
 const clues=new Set([...tokens(part.name),...tokens(part.model),...tokens(merchant?.pathname.split('/').at(-1))].filter(v=>v.length>=4));
 const used=new Set(primary.map(merchantKey)),ranked=[];
 for(const observed of new Set(fresh.observedUrls||[])){
  const key=urlKey(observed);if(!key.startsWith('https://'))continue;
  const u=new URL(key);if(used.has(merchantKey(key)))continue;
  let path=u.pathname;try{path=decodeURIComponent(path);}catch{}
  if(/\.(?:pdf|stp|step|stl|zip|png|jpe?g|mp4)$/i.test(path)||/\/(?:search|filter|categories|brands|repos|datasheet|manual|gallery)(?:\/|$)/i.test(path))continue;
  if(/^(?:docs|wiki|media|api|static|github)\./i.test(u.hostname)||key===fresh.sourceUrl||key===fresh.cadUrl)continue;
  const item=/\/(?:products?|product[-_]?detail|goods|items?|itm|dp|p)\/[^/]+/i.test(path);
  const pathWords=norm(path),leaf=new Set(tokens(path.split('/').filter(Boolean).at(-1)));
  const codeMatch=codes.some(c=>String(c).length>=3&&/\d/.test(c)&&pathWords.includes(norm(c)));
  const overlap=[...clues].filter(v=>leaf.has(v)).length;
  if(item||codeMatch||overlap>=2)ranked.push({key,score:(codeMatch?8:0)+(item?2:0)+Math.min(4,overlap)});
 }
 const extra=[];for(const {key} of ranked.sort((a,b)=>b.score-a.score)){
  const store=merchantKey(key);if(used.has(store))continue;
  extra.push(key);used.add(store);if(extra.length===6)break;
 }
 return extra;
}
async function checkProductSources(record,fresh,previous,kind,part,fetchSource,signal){
 const model=part.model;
  const known=previous?.identityStatus==='matched'&&previous.productIdentityCheck?.status==='matched'&&previous.productUrl?previous:null;
  const candidates=fresh.identityStatus==='mismatch'?[]:(fresh.productCandidates||[]).filter(url=>url.startsWith('https://')&&fresh.observedUrls?.includes(urlKey(url)));
 const primary=[...new Set([record.productUrl,...candidates.slice(0,3)].map(urlKey).filter(Boolean))];
 const additional=otherProductPages(fresh,primary,part);
 record.productChecks=[];let preferred;
 for(const url of [...primary,...additional]){
    let check,status,note;
   try{const doc=await fetchSource(url,{signal,limit:3*1024*1024});check=inspectProductDocument(doc,model,{orderIdentity:fresh.proposedIdentity,selection:record.selectedIdentity});status='retrieved';}
    catch(error){signal.throwIfAborted();check={status:'unverified',reason:'unreadable'};status='search-supported';note=error.message;}
   const discovered=additional.includes(url);
   if(discovered&&check.status==='matched'&&check.reason!=='product-identity')check={status:'unverified',reason:'no-product-record'};
    record.productChecks.push({url,status:check.status,reason:check.reason,...(note?{note}:{})});
   if((!preferred&&!discovered)||check.status==='matched')preferred={url,check,status,note};
    if(check.status==='matched')break;
  }
  if(known&&preferred?.check.status!=='matched'&&!record.productChecks.some(p=>p.url===known.productUrl&&p.reason!=='unreadable')){
    record.productUrl=known.productUrl;record.productIdentityCheck=known.productIdentityCheck;record.productStatus=known.productStatus;
    record.productEvidence=known.productEvidence;record.productNote='保留上次已核对的页面；本次没有取得新证据。';
    const origin=sourceOrigin(known,'productUrl');if(origin)record.linkProvenance={...record.linkProvenance,productUrl:origin};return;
  }
  if(!preferred){delete record.productIdentityCheck;record.productStatus=kind==='included'?'included':'missing';return;}
  if(preferred.url!==record.productUrl){
    record.productEvidence=preferred.check.evidence||'';record.productUrl=preferred.url;
    const origin=sourceOrigin({...fresh,productUrl:preferred.url},'productUrl');if(origin)record.linkProvenance={...record.linkProvenance,productUrl:origin};
  }
  record.productIdentityCheck=preferred.check;record.productStatus=preferred.status;
  if(preferred.note)record.productNote=preferred.note;else delete record.productNote;
}
export async function sourceParts(parts,cache,env,send,signal,onProgress=()=>{},plan,dependencies={}){
  const {importSourceCad,sourceFetch,inspectImportedCad,wholePartExtentConflict,dimensionConflictMessage}=await import('./source-files.mjs');
  const research=dependencies.research||researchPart,importCad=dependencies.importCad||importSourceCad,fetchSource=dependencies.fetchSource||sourceFetch;
  // Resume jobs saved before cosmetic manufacturer-name normalization.
  for(const [key,record]of Object.entries(cache)){
    const identity=partIdentity(record);
    if(identity&&key!==identity){cache[identity]??=record;delete cache[key];}
  }
  let next=0,completed=0,actionError=null;
  const records=new Array(parts.length);
  async function run(){
    while(next<parts.length&&!actionError){
      const index=next++,part={...parts[index],index},key=partIdentity(part),kind=part.kind||cache[key]?.kind||partKind(part,plan);
      signal.throwIfAborted();
      await onProgress({stage:'sourcing',message:'正在核对 '+part.name,partIndex:index,partName:part.name,total:parts.length,completed});
      let record=cache[key];
      if(record?.kind!==kind)record=null;
      // Old jobs could retain their first network error after a successful
      // retry. A sourced product must not display that obsolete failure.
      if(record?.productUrl)delete record.error;
      const legacyFocused=Boolean(record?.lastResearchQuestion&&!record.evidenceModel);
      const researchQuestion=part.researchQuestion||(legacyFocused?record.lastResearchQuestion:'');
      const focused=legacyFocused||part.researchQuestion&&part.researchQuestion!==record?.lastResearchQuestion;
      const mountedIncluded=kind==='included'&&part.placement==='mounted';
      const unresearchedIncluded=mountedIncluded&&!record?.researchAttempted&&!record?.queriedAt;
      const staleIdentity=record?.productUrl&&(!record.productIdentityCheck||record.productIdentityCheck.status!=='matched'&&record.attempts<2);
      const lookups=dependencies.ordinaryLookups;
      const inputs=lookups&&JSON.stringify([kind,part.name,part.spec,part.purpose,part.placement,
        proposedOrderIdentity(part.selectedIdentity),[...new Set(part.requiredFactoryFunctions||[])].sort()]);
      const reused=Boolean(lookups&&Object.hasOwn(lookups,key)&&lookups[key]===inputs&&record?.researchAttempted);
      const missing=staleIdentity||(record?.productStatus==='missing'&&record.attempts<2);
      const failed=(record?.error||record?.researchError)&&record.attempts<2;
      if(reused&&missing&&!failed&&!focused)track(env,'part.lookup-reused',{partIndex:index});
      if(!record||focused||unresearchedIncluded||failed||(missing&&!reused)){
        const attempts=(unresearchedIncluded?0:record?.attempts||0)+1;
        if(['custom','provided'].includes(kind)||kind==='included'&&!mountedIncluded)record={model:part.model,kind,attempts,detail:part.spec};
        else try{
          const previous=record;
          const fresh=await research({...part,kind,researchQuestion,researchTokenBudget:previous?.researchTokenBudget||(/零件资料查询未完成/.test(previous?.researchError||'')?32768:undefined),researchDraft:previous?.researchDraft,
            previousEvidence:previous?{sourceUrl:previous.sourceUrl,detail:previous.detail,cadError:previous.cadError,cadUrl:previous.cadUrl,
              productChecks:previous.productChecks?.map(({url,status,reason})=>({url,status,reason})),identityUnconfirmed:legacyFocused}:undefined},env,send,signal);
          // Alternative-model evidence is never merged into the selected SKU.
          // Retain old evidence only if its identity was explicitly confirmed.
          const retained=fresh.identityStatus==='mismatch'&&previous?.identityStatus!=='matched'?null:previous;
          record={...retained,...fresh,kind,attempts,researchAttempted:true,lastResearchQuestion:researchQuestion};
          if(part.selectedIdentity)record.selectedIdentity=selectedOrderIdentity(part.model,part.selectedIdentity);
          const required=[...new Set((part.requiredFactoryFunctions||record.requiredFactoryFunctions||[]).filter(k=>factoryKinds.includes(k)))];
          if(required.length)record.requiredFactoryFunctions=required;
          if(fresh.identityStatus==='mismatch'&&retained){
            for(const key of ['productUrl','productEvidence','visualUrl','sourceUrl','sourceQuote','detail','extentMm','cadUrl','cadAuthority','cadSearch','evidenceModel','identityStatus'])record[key]=retained[key];
          }
          if(fresh.identityStatus!=='mismatch'){record.evidenceModel=fresh.evidenceModel||part.model;record.identityStatus='matched';}
          const sameEvidence=fresh.identityStatus!=='mismatch'&&fresh.sourceUrl&&urlKey(fresh.sourceUrl)===urlKey(previous?.sourceUrl);
          if(legacyFocused&&!sameEvidence){delete record.reconstruction;delete record.importedModel;delete record.cadAttempts;delete record.cadDimensionConflict;}
          // A cached included-part placeholder may predate mechanical research.
          // Rebuild it using the newly acquired evidence before assembly.
          if(mountedIncluded&&!previous?.sourceUrl&&fresh.sourceUrl)delete record.reconstruction;
          delete record.error;delete record.researchError;delete record.researchDraft;
          const linkProvenance={};
          for(const [field,related] of Object.entries(sourceFields)){
            const retainLink=!legacyFocused&&previous?.[field]&&!record[field]&&fresh.identityStatus!=='mismatch';
            if(retainLink)for(const key of [field,...related])record[key]=previous[key];
            const from=retainLink||fresh.identityStatus==='mismatch'?retained:fresh;
            const origin=sourceOrigin(from,field);
            if(record[field]&&origin)linkProvenance[field]=origin;
          }
          if(Object.keys(linkProvenance).length)record.linkProvenance=linkProvenance;
          else delete record.linkProvenance;
          if(record.cadUrl!==previous?.cadUrl){delete record.cadAttempts;delete record.cadError;delete record.cadDimensionConflict;delete record.importedModel;}
          const claims=fresh.identityStatus!=='mismatch'&&['purchase','included'].includes(kind)?fresh.factoryClaims||[]:[];
          const checkBuiltIns=fresh.identityStatus!=='mismatch'&&['purchase','included'].includes(kind)&&(claims.length||required.length);
          const documents=new Map();
          const read=checkBuiltIns?(url,opts)=>{if(!documents.has(url))documents.set(url,fetchSource(url,opts));return documents.get(url);}:fetchSource;
          await checkProductSources(record,fresh,legacyFocused?null:retained,kind,part,read,signal);
          if(checkBuiltIns){
            record.factoryChecks=[];
            const verified=await verifyFactoryInterfaces(claims,record,read,signal,check=>record.factoryChecks.push(check));
            const checks=Math.max(record.factoryChecks.length,claims.length);
            track(env,'part.factory-checked',{partIndex:dependencies.parentIndex??index,count:verified.length,checks,
              status:verified.length===checks?'verified':verified.length?'partial':'unverified',
              reason:record.factoryChecks.find(c=>c.status==='unverified')?.reason||(!record.factoryChecks.length?'invalid-claim':undefined)});
            const ids=new Set(verified.map(c=>c.id));
            const prior=legacyFocused?[]:(retained?.factoryInterfaces||[]).filter(c=>partIdentity(c)===partIdentity(part)&&!ids.has(c.id)&&!claims.some(n=>n.id===c.id&&(n.sourceUrl!==c.sourceUrl||n.quote!==c.quote||n.kind!==c.kind)));
            record.factoryInterfaces=[...verified,...prior];
          }
          delete record.factoryClaims;
          delete record.proposedIdentity;
          record.cadStatus=record.importedModel?'imported':record.cadUrl&&record.cadAuthority!=='none'?'pending':'not-found';
          if(lookups&&!researchQuestion)lookups[key]=inputs;
        }catch(error){signal.throwIfAborted();if(error.actionRequired==='local-codex-unavailable'){actionError=error;return;}if(error.actionRequired==='api-billing')actionError=error;record=record?{...record,attempts,researchAttempted:true,researchError:error.message,lastResearchQuestion:researchQuestion}:{model:part.model,kind,attempts,researchAttempted:true,error:error.message,productStatus:kind==='included'?'included':'missing',cadStatus:'unavailable'};
          if(legacyFocused){
            const fields=['productUrl','productEvidence','visualUrl','sourceUrl','sourceQuote','detail','extentMm','cadUrl','cadSearch','linkProvenance','importedModel','reconstruction','reconstructionPrior','factoryInterfaces','factoryChecks'];
            record.unverifiedEvidence=Object.fromEntries(fields.filter(k=>record[k]!==undefined).map(k=>[k,record[k]]));
            for(const key of fields)delete record[key];
            record.identityStatus='mismatch';record.productStatus='missing';record.cadStatus='unavailable';
          }
          if(error.incompleteReason==='max_output_tokens'){record.researchTokenBudget=Math.min(65536,(record.researchTokenBudget||16384)*2);record.researchDraft=error.partialOutput;}
        }
        cache[key]=record;
      }
      // Try a focused, evidence-only repair here once, before spending time
      // building geometry for an interface the selected module cannot prove.
      const needed=(record.requiredFactoryFunctions||[]).filter(k=>!record.factoryInterfaces?.some(v=>v.kind===k));
      if(needed.length&&!focused&&!dependencies.builtinFollowup&&!record.builtinResearchAttempted&&!actionError){
        const question='核实同一订货型号承担的出厂功能 '+needed.join('、')+'。分开核对厂家、商品名、版本和订货号，查可读取的原厂说明并摘录原文。若仍无证据，提出有资料的兼容成品替代，不伪造内部接线。';
        const forward=event=>event.completed===1?undefined:onProgress({...event,partIndex:index,total:parts.length,completed});
        const [updated]=await sourceParts([{...part,researchQuestion:question}],cache,env,send,signal,forward,plan,{...dependencies,builtinFollowup:true,parentIndex:index});
        record=updated;
        record.builtinResearchAttempted=true;
      }
      const prior=record.cadDimensionConflict;
      if(prior&&(prior.cadUrl!==record.cadUrl||prior.sourceDocument!==record.sourceUrl||[...(prior.extentMm||[])].sort().join()!==[...(record.extentMm||[])].sort().join())){
        delete record.cadDimensionConflict;delete record.cadAttempts;delete record.cadError;
      }
      const cachedConflict=wholePartExtentConflict(record,record.importedModel);
      if(cachedConflict){record.cadDimensionConflict=cachedConflict;delete record.importedModel;}
      if(record.cadDimensionConflict){record.cadStatus='dimension-conflict';record.cadError=dimensionConflictMessage(record.cadDimensionConflict);}
      const cadAttempts=record.cadAttempts??(record.cadStatus==='unavailable'?1:0);
      if(record.cadUrl&&record.cadAuthority!=='none'&&!record.importedModel&&!record.cadDimensionConflict&&cadAttempts<2){
        await onProgress({stage:'importing',message:'正在导入 '+part.name+' 的 CAD',partIndex:index,partName:part.name,total:parts.length,completed});
        record.cadAttempts=cadAttempts+1;
        try{
          const asset=await importCad(record,env,{signal}),conflict=wholePartExtentConflict(record,asset);
          if(conflict)throw Object.assign(Error(dimensionConflictMessage(conflict)),{cadDimensionConflict:conflict});
          record.importedModel=asset;record.cadStatus='imported';delete record.cadError;
        }catch(error){signal.throwIfAborted();record.cadStatus=error.cadDimensionConflict?'dimension-conflict':'unavailable';record.cadError=error.message;
          if(error.cadDimensionConflict)record.cadDimensionConflict=error.cadDimensionConflict;
        }
      }
      if(record.importedModel?.meshUrl&&!Array.isArray(record.importedModel.geometrySummary?.meshes)){
        try{record.importedModel=await inspectImportedCad(record.importedModel,env);delete record.cadInspectionError;}
        catch(error){signal.throwIfAborted();record.cadInspectionError=error.message;}
      }
      records[index]=record;completed++;
      await onProgress({stage:'sourcing',message:'已处理 '+part.name,partIndex:index,partName:part.name,total:parts.length,completed,record});
    }
  }
  await Promise.all(Array.from({length:Math.min(hasLocalCodex(env)?1:3,parts.length)},run));
  if(actionError)throw actionError;
  return records;
}
export function sourcesForModel(parts,records){
  return parts.map((part,i)=>{
    const r=records[i];let inputPart=part;
    // attachPartSources creates these display copies from the cached record.
    // A revision needs the current record once, not its previous UI copies too.
    // Keep unassociated/client references when no matching snapshot is present.
    if(r&&part.sourcing?.model&&partIdentity(part)===partIdentity(r)&&partIdentity(part.sourcing)===partIdentity(r)){
      const {hardwareReference,geometryReference,sourcing,importedModel,...designPart}=part;
      inputPart=designPart;
    }else if(r?.cadDimensionConflict&&part.importedModel){const {importedModel,...rest}=part;inputPart=rest;}
    return {...inputPart,...(r?{research:{...r,productChecks:undefined,productCandidates:undefined,observedUrls:undefined,researchProvenance:undefined,linkProvenance:undefined,usage:undefined,researchDraft:undefined,unverifiedEvidence:undefined,reconstructionDraft:undefined,reconstructionPrior:undefined,reconstruction:r.reconstruction?{sizeMm:r.reconstruction.sizeMm,description:r.reconstruction.description,datums:r.reconstruction.datums,assumptions:r.reconstruction.assumptions,engine:r.reconstruction.engine,coordinateSystem:'局部毫米坐标，完整模型包络中心为零点；datums 与模型使用同一坐标'}:null,importedModel:r.importedModel?{sizeMm:r.importedModel.sizeMm,sourceUrl:r.importedModel.sourceUrl,filename:r.importedModel.filename,sourceType:r.importedModel.sourceType,geometrySummary:r.importedModel.geometrySummary}:null}}:{})};
  });
}
export function attachPartSources(design,cache){
  return {...design,parts:design.parts.map(part=>{
    const r=cache[partIdentity(part)];if(!r)return part;
    const imported=r.importedModel;
    const {importedModel:priorDisplay,...display}=part;
    if(!imported&&part.dimensionSource==='cad'&&r.cadDimensionConflict){display.dimensionSource='estimated';delete display.dimensionSourceUrl;delete display.dimensionNote;}
    const items=[];
    if(r.productUrl)items.push({name:part.model,url:r.productUrl,label:r.productIdentityCheck?.status==='matched'?'单品页 · 型号已核对':'商品候选 · 规格待核对'});
    if(r.sourceUrl&&r.sourceUrl!==r.productUrl)items.push({name:part.model+' 尺寸与接口资料',url:r.sourceUrl,label:'型号资料'});
    if(imported)items.push({name:part.model+' '+imported.format.toUpperCase(),url:imported.sourceUrl,label:imported.sourceType==='manufacturer'?'原厂 CAD · 已导入':'供应商 CAD · 已导入'});
    else if(r.cadUrl)items.push({name:part.model+' CAD 资源',url:r.cadUrl,label:'模型来源 · 当前按尺寸建模'});
    const note=[r.detail,r.error,r.cadError,r.cadSearch,r.kind==='included'?'此件包含在主机中。':r.kind==='provided'?'用户已有设备，无需另购；接口与实机型号仍需核对。':''].filter(Boolean).join(' ').slice(0,1800);
    const matched=r.extentMm?.length===3&&r.extentMm.every((n,i)=>Math.abs(n-part.sizeMm[i])<.02);
    const measured=imported?.sizeMm?.every((n,i)=>Math.abs(n-part.sizeMm[i])<.02);
    return {...display,kind:r.kind,hardwareReference:{kind:['custom','material','included','provided'].includes(r.kind)?r.kind:r.productUrl?'specified':'candidate',items,note,searchTerms:part.model},
      sourcing:{productIdentity:r.productIdentityCheck?.status||'unverified',productStatus:r.productStatus||r.kind,cadStatus:imported?'imported':r.reconstruction?'reconstructed':r.cadStatus||r.kind,queriedAt:r.queriedAt||'',model:part.model,
        ...(r.productIdentityCheck?.documentIdentity?{documentIdentity:r.productIdentityCheck.documentIdentity}:{}),
        ...(r.identityStatus==='matched'&&r.factoryInterfaces?.length?{factoryInterfaces:r.factoryInterfaces.filter(x=>partIdentity(x)===partIdentity(part))}:{})},
      ...(imported?{importedModel:imported}:{}),
      ...(r.sourceUrl?{geometryReference:{kind:'datasheet-approximation',sourceUrl:r.sourceUrl,sourceQuote:r.sourceQuote,detail:r.detail,...(r.cadUrl?{cadUrl:r.cadUrl}:{})},
        dimensionSource:matched?'datasheet':display.dimensionSource,dimensionSourceUrl:r.sourceUrl,dimensionNote:matched?'整件外廓采用型号资料。':display.dimensionNote}:{}),
      ...(measured?{dimensionSource:'cad',dimensionSourceUrl:imported.documentationUrl||r.cadUrl||imported.sourceUrl,dimensionNote:'整件外廓取自已导入的'+(imported.sourceType==='manufacturer'?'原厂':'供应商')+' CAD，保留原生 XYZ 轴向。'}:{})};
  })};
}
export function sourcingIssues(design,cache){
  return design.parts.flatMap(part=>{
    const r=cache[partIdentity(part)];
    if(!r)return ['尚未核实 '+part.name+' 的型号和来源。'];
    if(r.identityStatus==='mismatch')return ['部件资料的对应型号未确认：'+part.name+'（'+part.model+'）。替代候选不可混入原型号；由设计阶段明确选型后重新核对其商品、尺寸和 CAD。'];
    if(['custom','included','provided'].includes(r.kind))return [];
    if(!r.productUrl)return ['未找到 '+part.name+'（'+part.model+'）的实际商品页。请选择资料和商品可查的替代型号，或在本轮补查。'];
    if(r.productIdentityCheck?.status!=='matched')return ['商品型号待核对：'+part.name+'（'+part.model+'）缺少对应单品页面的订货号证据；系列、搜索结果和只有链接的记录不算确认。'];
    return [];
  });
}
