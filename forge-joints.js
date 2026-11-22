// Source for native ForgeCAD kinematics. Geometry builders stay in forge-source.js.
const origin=[0,0,0];
const quote=JSON.stringify;
const relative=(point,base)=>point.map((v,k)=>v-base[k]);
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);

function jointOperations(plan,interaction){
  const operations=[];
  // The web preview applies the input transformations successively in world
  // coordinates. Forge composes parent * child, so the last input is outermost.
  for(const control of [...(interaction?.controls||[])].reverse()){
    if(control.kind==='touch')continue;
    const turn=control.kind==='turn';
    if((!turn&&!['press','slide'].includes(control.kind))||
       !vector(control.axis)||!vector(control.pivotMm)||!Number.isFinite(control.step)||control.step<=0||
       !Array.isArray(control.movingBodyIndices)||!control.movingBodyIndices.length||
       control.movingBodyIndices.some(i=>!Number.isInteger(i)||!plan.bodies[i]||i===control.fixedBodyIndex)){
      throw Error('操作缺少有效的装配关节，无法导出。');
    }
    operations.push({label:control.label,turn,axis:control.axis,pivot:control.pivotMm,
      max:control.step,bodies:control.movingBodyIndices});
  }
  for(const m of plan.motions||[])operations.push({label:m.name,turn:false,axis:m.axis,
    pivot:origin,max:m.travelMm,bodies:m.movingBodyIndices});
  return operations;
}

function availableName(label,taken){
  let name=label,suffix=2;
  while(taken.has(name)){
    name=label+' ('+suffix+')';
    suffix++;
  }
  taken.add(name);
  return name;
}

// The route solver provides world-space endpoints and bends that the viewer
// already draws. Keep each wire as a separately named reference solid.
export function forgeWiring(plan,wiring){
  const usedNames=new Set(plan.bodies.map(body=>body.name)),wires=[];
  for(const route of wiring?.routes||[]){
    if(route.routing!=='illustrative'||!['modeled','estimated'].includes(route.quality)||
       !/^#[a-f0-9]{6}$/i.test(route.color)||!Array.isArray(route.points)||
       route.points.length<2||!route.points.every(vector))continue;
    if(![route.from,route.to].every(e=>e&&plan.bodies[e.bodyIndex]?.partIndex===e.partIndex&&vector(e.worldMm)))continue;
    if(!route.from.worldMm.every((v,k)=>v===route.points[0][k])||
       !route.to.worldMm.every((v,k)=>v===route.points.at(-1)[k]))continue;
    const points=route.points.filter((p,i,all)=>i===0||p.some((v,k)=>v!==all[i-1][k]));
    if(points.length<2)continue;
    const label=e=>e.partName+' '+e.pin;
    const name=availableName('参考线束 · '+label(route.from)+' → '+label(route.to)+
      (route.quality==='estimated'?'（端点估计）':''),usedNames);
    wires.push({name,color:route.color,points});
  }
  return wires;
}

export const referenceWireBuilder=[
  '// 参考线束：用于查看连接关系。线径和走向是示意值，不用于打印、裁线或干涉验证。',
  'function referenceWire(points, color) {',
  '  const radius = 0.38; // Illustrative insulation radius in mm.',
  '  const pieces = [];',
  '  for (let i = 1; i < points.length; i++) {',
  '    const a = points[i - 1], b = points[i];',
  '    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];',
  '    const length = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dy);',
  '    let leg = cylinder(length, radius, radius, 12);',
  '    if (horizontal > 0) leg = leg.rotate([-dy / horizontal, dx / horizontal, 0], Math.atan2(horizontal, dz) * 180 / Math.PI);',
  '    else if (dz < 0) leg = leg.rotate([1, 0, 0], 180);',
  '    pieces.push(leg.translate(...a));',
  '    if (i < points.length - 1) pieces.push(sphere(radius, 12).translate(...b));',
  '  }',
  '  return (pieces.length === 1 ? pieces[0] : union(...pieces)).color(color);',
  '}'
];

export const forgeWireShape=wire=>'referenceWire('+quote(wire.points)+', '+quote(wire.color)+')';

export function forgeJointAssembly(plan,interaction,wires=[]){
  const operations=jointOperations(plan,interaction);
  if(!operations.length)return null;
  const usedParts=new Set(),usedJoints=new Set(),names=plan.bodies.map(b=>availableName(b.name,usedParts));
  wires.forEach(w=>usedParts.add(w.name));
  const world=availableName('Assembly origin',usedParts);
  const lines=['const mechanism = assembly("Formwork");','mechanism.addFrame('+quote(world)+');'];
  const frames=new Map(),primary=new Map(),overrides={},animations=[];

  function frameFor(op,index,parent){
    const key=parent.key+'/'+index;
    if(frames.has(key))return frames.get(key);
    const frame=availableName('Motion frame '+(frames.size+1),usedParts);
    const joint=availableName((index+1)+'. '+op.label,usedJoints);
    const offset=relative(op.pivot,parent.pivot);
    const options='{axis:'+quote(op.axis)+', min:'+(op.turn?-op.max:0)+', max:'+op.max+
      ', default:0, unit:'+quote(op.turn?'deg':'mm')+', frame:Transform.identity().translate('+offset.join(', ')+')}';
    lines.push('mechanism.addFrame('+quote(frame)+');',
      'mechanism.'+(op.turn?'addRevolute':'addPrismatic')+'('+[joint,parent.name,frame].map(name=>quote(name)).join(', ')+', '+options+');');
    if(primary.has(index)){
      lines.push('mechanism.addJointCoupling('+quote(joint)+', {terms:[{joint:'+quote(primary.get(index))+', ratio:1}]});');
      overrides[joint]={hidden:true};
    }else{
      primary.set(index,joint);
      animations.push({name:joint,duration:2,keyframes:[0,op.max,0].map(v=>({values:{[joint]:v}}))});
    }
    const entry={name:frame,key,pivot:op.pivot};
    frames.set(key,entry);
    return entry;
  }
  plan.bodies.forEach((body,i)=>{
    let parent={name:world,key:'',pivot:origin};
    operations.forEach((op,index)=>{if(op.bodies.includes(i))parent=frameFor(op,index,parent)});
    // The fixed attachment is at the parent pivot. Convert the real part's
    // assembly-space geometry to that local frame without adding a visible proxy.
    const offset=relative(body.positionMm,parent.pivot);
    lines.push('mechanism.addPart('+quote(names[i])+', buildPart'+i+'().translate('+offset.join(', ')+'));');
    if(parent.key)lines.push('mechanism.addFixed('+quote(availableName('Attach '+names[i],usedJoints))+
      ', '+quote(parent.name)+', '+quote(names[i])+');');
  });
  for(const wire of wires)lines.push('mechanism.addPart('+quote(wire.name)+', '+forgeWireShape(wire)+');');
  lines.push('mechanism.toJointsView('+quote({overrides,animations})+');','return mechanism.solve();');
  return lines;
}
