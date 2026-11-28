import {factoryInterfaces,partIdentity} from '../part-records.js';

const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false
});
const string = {type: 'string'};
const kinds = ['purchase', 'custom', 'material', 'included', 'provided'];
const roles = ['internal', 'external', 'panel', 'enclosure'];
const placements = ['mounted', 'loose'];
const fields = {kind: kinds, role: roles, placement: placements};
const deviceUses = ['product-core','support','companion-interface','result-viewer','personal-device-core'];
const member = object({
  model: string,
  ...Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, {type: 'string', enum: values}])),
  deviceUse:{type:'string',enum:deviceUses}
});

export const deviceMotionTypes = ['stationary','powered-linear','powered-rotary','powered-mixed','other'];
const count = {type:'integer',minimum:0};
export const motionRequirementsSchema = object({minRotaryAxes:count,minLinearAxes:count,minSerialRotaryDepth:count});
export const motionRequirementsInstructions = 'motionRequirements 是在画 CAD 前从用户目标及最新反馈确定的整机最低主动运动约定。minRotaryAxes、minLinearAxes 分别数必须独立控制的设备旋转轴和直线轴；minSerialRotaryDepth 是同一条旋转父子链所需的最低层数，串联三旋转轴为 3/0/3，三个独立转台为 3/0/1。仅在需要对应运动时计数，手调旋钮、手压按键、被测物动作或三轴传感器不计，固定装置三项为 0。有 previousMotionRequirements 时保留无关功能，仅依用户改变后的需求更新。不得依据草稿碰巧画出了多少轴来定义目标。';
export function validMotionRequirements(value) {
  const fields=Object.keys(motionRequirementsSchema.properties);
  return Boolean(value && Object.keys(value).length===fields.length && fields.every(key=>Number.isSafeInteger(value[key]) && value[key]>=0)
    && value.minSerialRotaryDepth<=value.minRotaryAxes);
}

// Call only with a validated CAD plan: all parents precede their children.
export function inspectMotionRequirements(required,plan) {
  if(!required)return undefined; // Existing saved selections may predate motion contracts.
  if(!validMotionRequirements(required))throw Error('运动约定的轴数或串联层数无效。');
  const joints=plan.joints||[],depths=[];
  for(const joint of joints)depths.push(joint.parentIndex===null?1:depths[joint.parentIndex]+1);
  const observed={rotaryAxes:joints.length,linearAxes:plan.motions?.length||0,serialRotaryDepth:Math.max(0,...depths)};
  const issues=[];
  for(const [value,minimum,label] of [[observed.rotaryAxes,required.minRotaryAxes,'主动旋转轴数'],[observed.linearAxes,required.minLinearAxes,'主动直线轴数'],[observed.serialRotaryDepth,required.minSerialRotaryDepth,'单条旋转父子链层数']]){
    if(value<minimum)issues.push('运动约定：'+label+'最低要求 '+minimum+'，当前 CAD 为 '+value+'。');
  }
  return {required,observed,issues};
}

export const architectureSchema = {
  type: 'array',
  items: object({
    subsystem: string,
    rationale: string,
    interfaces: string,
    motion: {type: ['string','null']},
    members: {type: 'array', items: member}
  })
};
export const architectureRevisionSchema = {
  anyOf: [{type: 'null'}, object({reason: string, decisions: architectureSchema})]
};

export const deviceUseInstructions = 'deviceUse 按实际分工填写：product-core 是实现要求的实体感测、执行或其他物理作用的专用实物，support 是配套。已有手机等通用终端可作为 companion-interface，负责设置、校时、输入标定参考值或发送标定命令、操作控制、查看和转发专用硬件取得的结果；旧值 result-viewer 继续有效。手机自带传感器采集本设计的物理观测（即使只触发反馈、不记录），或手机代替专用硬件实现实体作用时，记 personal-device-core 并更换来源。所有参与的个人终端都列入约定；说明测量最初由哪件硬件取得。';
export const architectureInstructions = 'architecture 用简短的子系统约定说明核心方案。subsystem 写功能，rationale 写成品复用或必要定制的依据，interfaces 写与其他模块的供电、数据或安装接口，motion 在存在运动时写明哪一件固定、哪一件带动谁，否则填 null。每组 members 引用初始 BOM 中承担这项约定的关键件，逐字沿用 model、kind、role、placement；每个 custom 件都要列入并写明为何不能直接采购。'+deviceUseInstructions;

const isCompanion = member => ['companion-interface','result-viewer'].includes(member.deviceUse);
const pinKey = pin => typeof pin==='string'?pin.trim().toUpperCase():'';
// Explicit measurement channels can identify an unrecorded observation. A
// generic GPIO, serial bus or feedback label alone does not identify its origin.
const sensorChannel = /^(?:SENSOR[:._-])?(?:(?:ACCEL(?:EROMETER)?|GYRO(?:SCOPE)?|MAGNETOMETER)(?:[._:-]?[XYZ])?|GPS[._:-](?:LATITUDE|LONGITUDE|LAT|LON|ALTITUDE)|(?:TEMPERATURE|PRESSURE|HUMIDITY|LUX|CAMERA[._:-]FRAME|MICROPHONE[._:-]SAMPLE))$/;

function companionFeedback(interaction,parts,companions) {
  const samples=new Set(interaction?.recorder?.sampleEvents||[]);
  const measured=new Set(),unresolved=[];
  for(const event of interaction?.systemEvents||[]){
    const item=parts?.[event.partIndex];
    if(!item||!companions.has(partIdentity(item))||(!samples.has(event.id)&&event.kind!=='feedback'))continue;
    const pins=(event.sourcePins||[]).map(pinKey);
    // A phone may consume or forward samples taken elsewhere. A declared
    // inbound signal needs its upstream origin checked before assigning it.
    const incoming=pins.filter(pin=>(interaction.connections||[]).some(wire=>wire.kind==='signal'&&
      ((wire.toPartIndex===event.partIndex&&pinKey(wire.toPin)===pin)||
       (wire.bidirectional&&wire.fromPartIndex===event.partIndex&&pinKey(wire.fromPin)===pin))));
    const factory=factoryInterfaces(item);
    const wirelessPins=pins.filter(pin=>factory.some(f=>f.kind==='wifi'&&pin==='BUILTIN:'+pinKey(f.id)));
    if((samples.has(event.id)&&!incoming.length&&!wirelessPins.length)||pins.some(pin=>sensorChannel.test(pin)&&!incoming.includes(pin))){
      measured.add(item.model);
      continue;
    }
    if(!samples.has(event.id)&&pins.length&&pins.every(pin=>factory.some(f=>
      ['button','touch','clock'].includes(f.kind)&&pin==='BUILTIN:'+pinKey(f.id))))continue;
    // Command and measurement events may share a bus. Include the control
    // mapping as evidence for semantic review without attributing its payload.
    const sharedControls=(interaction.controls||[]).filter(c=>c.partIndex===event.partIndex&&
      c.signalPins?.some(pin=>pins.includes(pinKey(pin)))).map(c=>c.id);
    unresolved.push({eventId:event.id,partIndex:event.partIndex,sourcePins:event.sourcePins||[],
      ...(sharedControls.length?{sharedControls}:{}),...(incoming.length?{inboundPins:incoming}:{}),
      ...(wirelessPins.length?{wirelessPins}:{})});
  }
  return {measured,unresolved};
}

// A saved contract may predate deviceUse. New plans must identify the physical
// product, irrespective of whether it is bought, supplied or designed here.
function productBoundary(decisions, parts, {required = false, interaction, cadPlan} = {}) {
  const members = (decisions || []).flatMap(decision => decision.members);
  if (!required && !members.some(member => member.deviceUse !== undefined)) return {issues:[]};
  if (!members.length || members.some(member => !deviceUses.includes(member.deviceUse))) {
    return {issues:['请标明各部件承担实体功能、配套或辅助交互的实际用途。']};
  }
  const issues = [];
  const core = new Set(members.filter(member => member.deviceUse === 'product-core').map(partIdentity));
  const companions = new Set(members.filter(isCompanion).map(partIdentity));
  if (!core.size || (parts && !parts.some(part => core.has(partIdentity(part))))) {
    issues.push('方案缺少实际承担核心功能的独立硬件。');
  }
  const {measured,unresolved}=companionFeedback(interaction,parts,companions);
  const hosts=new Set(members.filter(m=>m.deviceUse==='personal-device-core'||(isCompanion(m)&&core.has(partIdentity(m)))).map(m=>m.model));
  const axes=[...(cadPlan?.motions||[]),...(cadPlan?.joints||[])];
  for(const axis of axes){
    const actuator=parts?.[axis.actuatorPartIndex];
    if(actuator&&companions.has(partIdentity(actuator)))hosts.add(actuator.model);
  }
  for (const model of hosts) issues.push('已有通用终端 '+model+' 承担了核心功能。请选专用硬件实现实体作用，保留终端的辅助交互。');
  for (const model of measured) issues.push('物理测量来自已有通用终端 '+model+'。请由专用硬件取得原始观测，终端可发命令、同步时间或查看结果。');
  return {issues,...(unresolved.length?{companionFeedbackToReview:unresolved}:{})};
}

export function productBoundaryIssues(decisions,parts,design) {
  return productBoundary(decisions,parts,design).issues;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateArchitecture(decisions) {
  if (!Array.isArray(decisions) || !decisions.length) throw Error('架构约定缺少子系统。');
  const names = new Set();
  for (const decision of decisions) {
    if (!decision || ![decision.subsystem, decision.rationale, decision.interfaces].every(hasText) ||
        (decision.motion !== null && !hasText(decision.motion))) {
      throw Error('架构约定需要子系统、方案理由、接口和适用的运动关系。');
    }
    if (names.has(decision.subsystem.trim())) throw Error('架构约定子系统重名：' + decision.subsystem);
    names.add(decision.subsystem.trim());
    if (!Array.isArray(decision.members) || !decision.members.length) throw Error(decision.subsystem + ' 缺少关键 BOM 项。');
    for (const part of decision.members) {
      if (!part || !partIdentity(part) || !Object.entries(fields).every(([key, values]) => values.includes(part[key]))) {
        throw Error(decision.subsystem + ' 的关键 BOM 项需要有效型号、采购类别和安装边界。');
      }
    }
  }
}

// Check identity and product boundary mechanically. The reviewer gets the
// declared interfaces and motion plus the current CAD, wiring and run evidence.
export function inspectArchitecture(decisions, parts, design) {
  if (!decisions) return undefined; // pre-contract job
  const observation = productBoundary(decisions,parts,design);
  const issues = observation.issues;
  const subsystems = decisions.map(decision => {
    const members = decision.members.map(expected => {
      const matches = [];
      const modelKey = partIdentity(expected);
      parts.forEach((part, partIndex) => {
        if (part && partIdentity(part) === modelKey) {
          matches.push({partIndex, kind: part.kind, role: part.role, placement: part.placement});
        }
      });
      const matchesBoundary = matches.some(part => Object.keys(fields).every(key => part[key] === expected[key]));
      if (!matchesBoundary) {
        const detail = matches.length
          ? '当前为 ' + matches.map(p => [p.kind,p.role,p.placement].join('/')).join('、')
          : '当前 BOM 缺少该型号';
        issues.push('架构约定「' + decision.subsystem + '」的 ' + expected.model + ' 应为 ' +
          [expected.kind, expected.role, expected.placement].join('/') + '，' + detail + '。');
      }
      return {expected, matches};
    });
    return {...decision, members};
  });
  const contracted=new Set(decisions.flatMap(d=>d.members.map(partIdentity)));
  for(const p of parts)if(p?.kind==='custom'&&!contracted.has(partIdentity(p)))issues.push('新增定制件 '+p.model+' 未列入架构约定；应优先使用成品或记录必要功能与定制理由。');
  return {subsystems, ...observation};
}

export function validateArchitectureRevision(revision,requireDeviceUse=false) {
  if (!revision) return;
  if (!hasText(revision.reason)) throw Error('修改架构约定需要说明原因。');
  validateArchitecture(revision.decisions);
  const issues=productBoundaryIssues(revision.decisions,null,{required:requireDeviceUse});
  if(issues.length)throw Error(issues.join(' '));
}

export function applyArchitectureRevision(state, repair) {
  const revision = repair.architectureRevision;
  // Old jobs and retries retain the historical absence of this decision.
  if (!revision) return;
  const previous = state.selection.architecture || null;
  validateArchitectureRevision(revision,previous?.some(d=>d.members.some(m=>m.deviceUse!==undefined)));
  if (JSON.stringify(previous) === JSON.stringify(revision.decisions)) return;
  state.architectureRevisions ??= [];
  state.architectureRevisions.push({attempt: repair.attempt, reason: revision.reason, previous, next: revision.decisions});
  state.selection = {...state.selection, architecture: revision.decisions};
}
