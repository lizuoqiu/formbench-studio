// Only the local job runner loads Playwright. The browser receives the current
// in-memory draft, its saved mesh, and public viewer assets on an isolated origin.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {modelAsset} from './source-files.mjs';
import {sampleDrawnVertices,inspectDrawnJoint,inspectDrawnHome,inspectDrawnTravel} from './draft-joint-evidence.mjs';

const requireTools=createRequire(new URL('../tools/package.json',import.meta.url));
const origin='http://draft-preview.invalid';
const meshPath='/samples/shared/current/cad.json';
const dist=new URL('../dist/',import.meta.url);
const types={'.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
const mountPage='<meta charset="utf-8"><link rel="stylesheet" href="/consumer-viewer.css"><link rel="stylesheet" href="/consumer-interaction.css"><main id="viewer"></main><aside id="parts"></aside>';

async function serve(route,candidate,compiled,env){
 const url=new URL(route.request().url()),path=url.pathname;
 if(url.origin!==origin||route.request().method()!=='GET')return route.abort();
 if(path==='/')return route.fulfill({contentType:'text/html',body:mountPage});
 if(path===meshPath)return route.fulfill({json:compiled});
 if(candidate.parts.some(p=>p.importedModel?.meshUrl===path)&&/^\/api\/model-assets\/[a-f0-9-]{36}\/mesh\.json$/.test(path)){
  const response=await modelAsset(new Request(url),env);
  return route.fulfill({status:response.status,contentType:'application/json',body:Buffer.from(await response.arrayBuffer())});
 }
 if(/^\/[\w-]+\.(js|css|json)$/.test(path)||/^\/assets\/(?:[\w-]+\/)*[\w.-]+$/.test(path)){
  try{return await route.fulfill({contentType:types[extname(path)]||'application/octet-stream',body:await readFile(new URL('.'+path,dist))});}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return route.fulfill({status:404,body:''});
}

// Interior and exterior views can each hide valid bodies. Keep a fixed view
// and a fixed set of real vertex indices for each body throughout the trial.
async function capturePose(page,views) {
 const points={};
 for(const view of views){
  const button=page.locator('[data-cc-mode="'+view.name+'"]');
  if(await button.getAttribute('aria-pressed')!=='true')await button.click();
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const drawing=await page.evaluate(sampleDrawnVertices,{references:view.refs,mode:view.name});
  if(!drawing)return null;
  const captured=drawing.vertices;view.angles=drawing.angles;
  if(!view.refs){
   view.refs=Object.fromEntries(Object.entries(captured).filter(([id])=>!Object.hasOwn(points,id)).map(([id,item])=>[id,item.refs]));
  }
  for(const id of Object.keys(view.refs))if(captured[id])points[id]=captured[id].points;
 }
 return points;
}

export async function checkJoints(page,joints){
 if(!joints.length)return {status:'not-applicable'};
 const sliders=page.locator('[data-cc-joint]'),count=await sliders.count();
 if(count!==joints.length)return {status:'failed',expected:joints.length,observed:count};
 const views=[{name:'inside'},{name:'closed'}];
 const originalView=await page.locator('[data-cc-mode][aria-pressed="true"]').getAttribute('data-cc-mode');
 const readAngles=()=>sliders.evaluateAll(nodes=>nodes.map(x=>Number(x.value)));
 const observations=[],changed=[],unchanged=[];
 const home=page.locator('[data-cc-motion-action="home"]');
 try{
  await home.click();
  const initial=await capturePose(page,views);
  if(!initial)return {status:'not-exercised',reason:'当前工作台构建没有提供实际绘制的实体顶点。'};
  let prior=initial;
  for(const [index,joint] of joints.entries()){
   const oldAngles=await readAngles(),before=oldAngles[index],delta=before<joint.maxDegrees?5:-5;
   const jog=page.locator('[data-cc-jog="'+index+'"][data-cc-delta="'+delta+'"]');
   if(!await jog.isVisible()){
    const preview=page.locator('[data-cc-mechanism="joint"][data-index="'+index+'"] [data-cc-preview-mechanism]');
    if(await preview.isVisible())await preview.click();
   }
   await jog.click();
   const newAngles=await readAngles(),after=newAngles[index],expected=Math.max(joint.minDegrees,Math.min(joint.maxDegrees,before+delta));
   const sliderPassed=before!==after&&Math.abs(after-expected)<0.51;
   (sliderPassed?changed:unchanged).push(index);
   const current=await capturePose(page,views);
   if(!current)return {status:'not-exercised',reason:'点动后未能读取已绘制网格。'};
   observations.push({...inspectDrawnJoint(joints,index,initial,prior,current,oldAngles,newAngles),sliderPassed,before,after});
   prior=current;
  }
  await home.click();
  const angles=await readAngles(),anglesHome=angles.every((v,i)=>Math.abs(v-Math.max(joints[i].minDegrees,Math.min(0,joints[i].maxDegrees)))<0.51);
  const reset=inspectDrawnHome(initial,await capturePose(page,views)||{},observations);
  const passed=anglesHome&&reset.status==='passed';
  const status=!anglesHome||unchanged.length||reset.status==='failed'||observations.some(o=>o.status==='failed')?'failed':
    passed&&observations.every(o=>o.status==='passed')?'passed':'not-exercised';
  return {status,changed,unchanged,observations,home:{passed,angles,pose:reset}};
 }finally{
  await home.click();
  if(originalView)await page.locator('[data-cc-mode="'+originalView+'"]').click();
 }
}

export async function checkTravel(page,candidate){
 const {motions=[],bodies}=candidate.cadPlan;
 if(!motions.length)return {status:'not-applicable'};
 const observations=[],views=[{name:'inside'},{name:'closed'}];
 const originalView=await page.locator('[data-cc-mode][aria-pressed="true"]').getAttribute('data-cc-mode');
 const home=page.locator('[data-cc-motion-action="home"]');
 try{
  await home.click();
  const initial=await capturePose(page,views);
  if(!initial)return {status:'not-exercised',reason:'缺少已绘制的行程起点。',observations};
  for(const [index,motion] of motions.entries()){
   const observation=await observe(async()=>{
    const moving=new Set(motion.movingBodyIndices);
    const fixed=bodies.flatMap((body,id)=>!moving.has(id)&&(body.partIndex===motion.guidePartIndex||candidate.parts[body.partIndex]?.role==='enclosure')?[id]:[]);
    const slider=page.locator('[data-cc-travel="'+index+'"]'),samples=[];
    for(const [key,phase] of [['PageUp','intermediate'],['End','extended'],['Home','retracted']]){
     if(!await slider.isVisible()){
      const show=page.locator('[data-cc-mechanism="travel"][data-index="'+index+'"] [data-cc-preview-mechanism]');
      if(await show.isVisible())await show.click();
     }
     await slider.press(key);
     const percent=Number(await slider.inputValue()),label=await slider.getAttribute('aria-valuetext');
     const sliderPassed=Boolean(label)&&(phase==='extended'?percent===100:phase==='retracted'?percent===0:percent>0&&percent<100);
     const pose=inspectDrawnTravel(motion,fixed,initial,await capturePose(page,views),percent/100);
     samples.push({phase,percent,label,sliderPassed,pose});
    }
    const status=samples.some(s=>!s.sliderPassed||s.pose.status==='failed')?'failed':samples.every(s=>s.pose.status==='passed')?'passed':'not-exercised';
    return {samples,status,extended:samples[1].label,retracted:samples[2].label,passed:status==='passed'};
   });
   observations.push({index,name:motion.name,travelMm:motion.travelMm,axis:motion.axis,...observation});
   if(observation.status!=='passed')await home.click();
  }
 }finally{
  await home.click();
  if(originalView)await page.locator('[data-cc-mode="'+originalView+'"]').click();
 }
 const status=observations.some(o=>o.status==='failed')?'failed':observations.every(o=>o.passed)?'passed':'not-exercised';
 return {scope:'初始关节姿态下逐一操作行程。比对中间位置、伸出端点和收回端点的实际绘制网格，以及固定导向件或外壳。',status,observations};
}

function eventButton(model,id){
 if(model.systemEvents?.some(e=>e.id===id))return {event:id,system:true,selector:'[data-ci-event='+JSON.stringify(id)+']'};
 for(const c of model.controls){
  if(c.kind==='turn'&&[c.id+'.increase',c.id+'.decrease'].includes(id)){
   const delta=Math.sign(c.step)*(id.endsWith('.increase')?1:-1);
   return {event:id,selector:'[data-ci-step='+JSON.stringify(c.id)+'][data-ci-delta="'+delta+'"]'};
  }
  if(c.id===id&&['press','command','touch'].includes(c.kind)&&!model.transitions.some(t=>t.event===id+'.down'))
   return {event:id,selector:'[data-ci-press='+JSON.stringify(id)+']'};
 }
 return null;
}

// Select one declared hold-to-move/release-to-stop interaction. Some projects
// require simulated connection/enable events before their control is usable.
function holdScenario(model){
 const declared=model?.transitions?.filter(t=>t.event.endsWith('.down'))||[];
 if(!declared.length)return {status:'not-applicable'};
 const queue=[{id:model.initialState,steps:[]}],seen=new Set([model.initialState]);
 for(let i=0;i<queue.length;i++){
  const {id,steps}=queue[i];
  for(const t of model.transitions.filter(t=>t.from===id)){
   if(t.event.endsWith('.down')){
    const control=t.event.slice(0,-5),release=model.transitions.find(r=>r.from===t.to&&r.event===control+'.up');
    const state=model.states.find(s=>s.id===t.to),released=model.states.find(s=>s.id===release?.to);
    const mode=state?.outputs.find(o=>['forward','reverse'].includes(o.mode)&&released?.outputs.some(r=>r.outputId===o.outputId&&r.mode==='off'));
    const motion=model.outputs.find(o=>o.id===mode?.outputId)?.motion;
    if(motion?.type==='joint')return {control,steps,moving:state.label,stopped:released.label,joint:motion.index};
   }
   const action=eventButton(model,t.event);
   if(!action||seen.has(t.to))continue;
   seen.add(t.to);queue.push({id:t.to,steps:[...steps,action]});
  }
 }
 return {status:'not-exercised',reason:'未找到可从初态通过离散页面操作到达的按住驱动关节、松开停止场景。'};
}

export async function checkHold(page,model,joints){
 const scenario=holdScenario(model);if(scenario.status)return scenario;
 const {control,steps,moving,stopped,joint}=scenario;
 const views=[{name:'inside'},{name:'closed'}];
 const initial=await capturePose(page,views);
 if(!initial||views.some(v=>v.angles?.some(n=>n!==0)))return {status:'not-exercised',reason:'缺少可用的已绘制初始姿态。'};
 const result={control,joint,preparation:steps.map(s=>s.event),simulatedEvents:steps.filter(s=>s.system).map(s=>s.event)};
 for(const step of steps){
  if(step.system&&!await page.locator('.ci-events').evaluate(el=>el.open))await page.locator('.ci-events summary').click();
  await page.locator(step.selector).click();
 }
 const button=page.locator('[data-ci-press='+JSON.stringify(control)+']'),selector='[data-cc-joint="'+joint+'"]';
 const angle=()=>page.locator(selector).evaluate(el=>parseFloat(el.nextElementSibling.textContent));
 const state=()=>page.locator('[data-ci-state]').textContent();
 const previous=await capturePose(page,views),oldAngles=views.find(v=>v.angles)?.angles;
 if(!previous||!oldAngles)return {status:'not-exercised',reason:'缺少按住前的已绘制姿态。'};
 const before=await angle();
 await button.focus();await page.keyboard.down('Space');
 let moved,movingState;
 try{
  movingState=await state();
  await page.waitForFunction(({selector,before})=>Math.abs(parseFloat(document.querySelector(selector).nextElementSibling.textContent)-before)>=0.1,{selector,before},{timeout:5000});
  moved=true;
 }catch{moved=false;}finally{await page.keyboard.up('Space');}
 const after=await angle(),releasedState=await state();
 const released=await capturePose(page,views),newAngles=views.find(v=>v.angles)?.angles;
 if(!released||!newAngles)return {status:'not-exercised',reason:'缺少释放时的已绘制姿态。'};
 const motion=inspectDrawnJoint(joints,joint,initial,previous,released,oldAngles,newAngles);
 // The viewer samples continuously held commands on a 100 ms interval.
 await page.waitForTimeout(350);
 const settled=await angle(),stable=settled===after;
 const limits=await page.locator(selector).evaluate(el=>[Number(el.min),Number(el.max)]);
 const stop=inspectDrawnHome(released,await capturePose(page,views)||{},[motion]);
 const observed={...result,before,after,settled,moved,stable,movingState,releasedState,motion,stop};
 if(moved&&limits.some(limit=>Math.abs(after-limit)<0.1))return {...observed,status:'not-exercised',reason:'松开时已处于行程边界，无法区分释放和限位造成的停止。'};
 const matches=(value,label)=>value===label||value?.startsWith(label+' · ');
 const controlsPassed=moved&&stable&&matches(movingState,moving)&&matches(releasedState,stopped);
 const status=!controlsPassed||motion.status==='failed'||stop.status==='failed'?'failed':
  motion.status==='passed'&&stop.status==='passed'?'passed':'not-exercised';
 return {...observed,status};
}

async function observe(action){
 try{return await action();}
 catch(error){return {status:'not-exercised',reason:String(error.message||error).split('\n')[0].slice(0,220)};}
}

export async function reviewDraftBrowser(candidate,compiled,env={},signal){
 const result={scope:'当前草稿、编译网格与已构建工作台 CAD 查看器。旋转关节点动、直线行程及归位同时核对页面读数和绘制网格的世界坐标探针；采样按声明的轴与随动关系比对。通信事件为模拟。'};
 let browser;
 const close=()=>{browser?.close().catch(()=>{});};
 const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(65_000)]):AbortSignal.timeout(65_000);
 try{
  deadline.throwIfAborted();
  const {chromium}=requireTools('playwright');
  browser=await chromium.launch({channel:env.BROWSER_CHANNEL||'chrome',timeout:12000});
  deadline.addEventListener('abort',close,{once:true});deadline.throwIfAborted();
  const page=await browser.newPage({viewport:{width:1200,height:900},serviceWorkers:'block'});
  page.setDefaultTimeout(5000);
  await page.route('**/*',route=>serve(route,candidate,compiled,env).catch(()=>route.abort().catch(()=>{})));
  await page.goto(origin);
  await page.evaluate(async({candidate,meshPath})=>{
   const {mountConsumerCad}=await import('/consumer-cad.js');
   mountConsumerCad(document.querySelector('#viewer'),candidate,{savedCadUrl:meshPath,partsPanel:document.querySelector('#parts'),onDrawScene:(scene,backdrop,mode,values)=>{window.draftDrawing={scene,backdrop,mode,angles:[...values]};},onStatus:s=>{window.draftStatus=s;}});
  },{candidate,meshPath});
  await page.waitForFunction(()=>['ready','error'].includes(window.draftStatus?.phase),null,{timeout:40000});
  const geometry=await page.evaluate(()=>window.draftStatus);
  if(!geometry.exact||geometry.phase!=='ready')return {...result,status:'unavailable',reason:geometry.message||'当前草稿网格未载入。'};
  const joints=await observe(()=>checkJoints(page,candidate.cadPlan.joints||[]));
  const travel=await observe(()=>checkTravel(page,candidate));
  const held=await observe(()=>checkHold(page,candidate.interaction,candidate.cadPlan.joints||[]));
  signal?.throwIfAborted();
  return {...result,status:'observed',geometry:{exact:true,engine:geometry.engine,instances:geometry.instances},joints,travel,held};
 }catch(error){
  signal?.throwIfAborted();
  return {...result,status:'unavailable',reason:String(error.message||error).split('\n')[0].slice(0,220)};
 }finally{deadline.removeEventListener('abort',close);if(browser)await browser.close().catch(()=>{});}
}
