import {partIdentity} from '../part-records.js';

const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false
});
const string = {type: 'string'};
const kinds = ['purchase', 'custom', 'material', 'included', 'provided'];
const roles = ['internal', 'external', 'panel', 'enclosure'];
const placements = ['mounted', 'loose'];
const fields = {kind: kinds, role: roles, placement: placements};
const deviceUses = ['product-core','support','result-viewer','personal-device-core'];
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

export const architectureInstructions = 'architecture 用简短的子系统约定说明核心方案。subsystem 写功能，rationale 写成品复用或必要定制的依据，interfaces 写与其他模块的供电、数据或安装接口，motion 在存在运动时写明哪一件固定、哪一件带动谁，否则填 null。每组 members 引用初始 BOM 中承担这项约定的关键件，逐字沿用 model、kind、role、placement；每个 custom 件都要列入并写明为何不能直接采购。成员的 deviceUse 按实际分工填写：product-core 是完成用户所要功能的专用实物，support 是配套，result-viewer 是查看结果的已有通用终端。若已有通用终端承担核心感测、运算或执行，其实际类别为 personal-device-core，需要重选独立硬件。将所有承担功能或用于查看的通用终端列入约定。';

// Old saved contracts predate deviceUse. Newly planned contracts must identify
// a physical deliverable; purchasing a part and using it as the core are separate facts.
export function productBoundaryIssues(decisions, parts, {required = false, interaction, cadPlan} = {}) {
  const members = (decisions || []).flatMap(decision => decision.members);
  if (!required && !members.some(member => member.deviceUse !== undefined)) return [];
  if (!members.length || members.some(member => !deviceUses.includes(member.deviceUse))) {
    return ['请标明各部件承担主体功能、配套或结果查看的实际用途。'];
  }
  const issues = [];
  const core = new Set(members.filter(member => member.deviceUse === 'product-core').map(partIdentity));
  const viewers = new Set(members.filter(member => member.deviceUse === 'result-viewer').map(partIdentity));
  if (!core.size || (parts && !parts.some(part => core.has(partIdentity(part))))) {
    issues.push('方案缺少实际承担核心功能的独立硬件。');
  }
  const hosts = new Set();
  for (const member of members) {
    if (member.deviceUse === 'personal-device-core' || (member.deviceUse === 'result-viewer' && core.has(partIdentity(member)))) {
      hosts.add(member.model);
    }
  }
  if (parts && viewers.size) {
    const sampleEvents = new Set(interaction?.recorder?.sampleEvents || []);
    const sampleSources = (interaction?.systemEvents || []).filter(event => sampleEvents.has(event.id)).map(event => event.partIndex);
    const axes = [...(cadPlan?.motions || []), ...(cadPlan?.joints || [])];
    const actuators = axes.map(axis => axis.actuatorPartIndex);
    for (const index of [interaction?.controllerPartIndex, ...sampleSources, ...actuators]) {
      const part = parts[index];
      if (part && viewers.has(partIdentity(part))) hosts.add(part.model);
    }
  }
  for (const model of hosts) {
    issues.push('已有通用终端 '+model+' 承担了核心功能。请将其移到专用硬件，查看结果可继续使用该终端。');
  }
  return issues;
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
  const issues = productBoundaryIssues(decisions,parts,design);
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
  return {subsystems, issues};
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
