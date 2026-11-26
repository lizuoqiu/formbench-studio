import {MAX_CAD_BODIES, MAX_CAD_FEATURES, MAX_DESIGN_PARTS, MAX_FEATURES_PER_BODY, MIN_CAD_FEATURE_MM, MAX_CAD_FEATURE_MM} from '../cad-plan.js';
import {MAX_INTERACTION_CONNECTIONS} from '../interaction-model.js';
import {cadPlanSchema} from './cad-plan.mjs';

// Describe the runtime that actually consumes the candidate. An advertised
// capability of a remote CAD product does not change this route.
const bodyProperties = cadPlanSchema.properties.bodies.items.properties;
const supportedShapes = bodyProperties.features.items.properties.shape.enum;

const actions = {
  'cad.bodyColor': ['design', '当前装配和查看器支持单个 body.color (#RRGGBB)。独立着色的标记可做成独立实体，来源网格按其实际颜色呈现。'],
  'cad.nativeSubmeshBinding': ['design', '可把同一原厂 CAD 的不同网格索引通过 sourceMeshes 分配给定件与随动件。先核实该型号的可分网格；合并成一个网格的部分须按资料重建或另选来源。'],
  'cad.bitmapTexture': ['platform', '本预览只接收三角形和颜色，尚无位图纹理通道。普通颜色要求仍可由 body.color 满足。'],
  'cad.freeformScript': ['platform', '当前生成端接受结构化 cadPlan。任意原生 ForgeCAD 脚本不是这个数字设计接口的输入。已有复杂几何可作为原厂 STEP/STL 导入。'],
  'cad.subminimumPrimitive': ['platform', `当前图元最小轴向尺寸为 ${MIN_CAD_FEATURE_MM} mm。先确认该局部厚度能否按资料合并到相邻实体，同时保留外部配合基准。仅必须独立表达更薄图元时才有此限制。`],
  'interaction.recordedSamples':['design','recorder 可绑定显示屏和有来源的反馈事件。工作台模拟记录经过时长、事件时间和回看，不能测量真实环境。'],
  'interaction.factoryInterfaces':['design','已查证的成品主控自带触控、按键、显示、时钟、灯或发声可通过 builtin 引用，不是外部针脚。外部传感、供电、驱动和 USB 数据仍需实际接线。'],
  'checks.sameGroupStaticOverlap': ['platform', '整机联动采样没有覆盖全部同运动组静态相交。增量修订会对变更打印件与同组其他打印件做有界的零位实体相交对比；查阅 revisionDependencies 的覆盖量。'],
  'checks.continuousCollision': ['platform', '内置运动检查使用有限的逐轴与联动姿态。连续全路径碰撞证明需要其他检查。'],
  'checks.dynamics': ['platform', '本地几何检查和页面回放均不执行载荷、惯性或制动力学求解。'],
};

const capacityFields = {
  'cad.addBody': 'bodies',
  'cad.addFeature': 'features',
  'bom.addPart': 'parts',
  'interaction.addConnection': 'connections',
  'interaction.addTerminal': 'terminals',
};

const listSize = list => Array.isArray(list) ? list.length : null;
function capacity(used, limit) {
  return {used, limit, remaining: used === null ? null : Math.max(0, limit - used)};
}

function draftCapacity(candidate) {
  const bodies = candidate?.cadPlan?.bodies;
  const featureCount = Array.isArray(bodies) && bodies.every(body => Array.isArray(body?.features))
    ? bodies.reduce((n, body) => n + body.features.length, 0) : null;
  return {
    bodies: capacity(listSize(bodies), MAX_CAD_BODIES),
    features: capacity(featureCount, MAX_CAD_FEATURES),
    parts: capacity(listSize(candidate?.parts), MAX_DESIGN_PARTS),
    connections: capacity(listSize(candidate?.interaction?.connections), MAX_INTERACTION_CONNECTIONS),
    terminals: capacity(listSize(candidate?.interaction?.terminals), MAX_INTERACTION_CONNECTIONS * 2),
  };
}

function classify(key, candidate, usage) {
  const field = Object.hasOwn(capacityFields, key) && capacityFields[key];
  if (field) {
    const {used, limit, remaining} = usage[field];
    if (remaining === null) return {route:'evidence', reason:'当前草稿缺少此列表，容量尚未核实。'};
    if (!remaining) return {route:'platform', reason:`${field} 已使用 ${used}/${limit}。按现状追加会超过上限。考虑等效替换、简化或扩展系统容量后再验证。`};
    return {route:'design', reason:`${field} 可追加 ${remaining} 项。新增项仍须满足单件约束和完整校验。`};
  }
  if (key === 'viewer.linearTravel') {
    return candidate?.cadPlan?.motions?.length
      ? {route:'review', reason:'草稿浏览器可按行程名验证伸缩件的实际网格位移，以及导向件或外壳的静止。'}
      : {route:'evidence', reason:'当前未声明直线行程，需核实适用性。'};
  }
  if (key === 'viewer.holdRelease') {
    const declared = candidate?.interaction?.transitions;
    return Array.isArray(declared) && declared.some(edge => typeof edge?.event==='string' && edge.event.endsWith('.down'))
      ? {route:'review', reason:'浏览器可检查一个可达的按住驱动关节、松开停止场景。subject 写 control id，判断时对照实测控件和关节。'}
      : {route:'evidence', reason:'当前草稿未声明按下事件，先核对此项交互是否适用。'};
  }
  if (key === 'viewer.jointHome' || key === 'viewer.jointJog') {
    return candidate?.cadPlan?.joints?.length
      ? {route:'review', reason:'有声明关节时，可在当前草稿浏览器实测逐轴点动和回到初始姿态。使用所需操作的观测证据。'}
      : {route:'evidence', reason:'未找到声明的旋转关节，先核对运动需求及查看器适用条件。'};
  }
  if (Object.hasOwn(actions, key)) {
    const [route, reason] = actions[key];
    return {route, reason};
  }
  return {route:'evidence', reason:'没有当前适配器对该操作的明确记录，需先确认支持情况。'};
}

export function capabilityPreflight(key, candidate) {
  return classify(key, candidate, draftCapacity(candidate));
}

export function runtimeCapabilityEvidence(candidate) {
  const usage = draftCapacity(candidate);
  const keys = [...Object.keys(actions), ...Object.keys(capacityFields), 'viewer.jointHome', 'viewer.jointJog', 'viewer.holdRelease', 'viewer.linearTravel'];
  return {
    scope:'本候选使用的 Formbench cadPlan、查看器与本地校验器。支持某操作不表示本草稿已正确使用或已实测。',
    featureShapes:supportedShapes,
    featureSizeMm:{min:MIN_CAD_FEATURE_MM,max:MAX_CAD_FEATURE_MM},
    maxFeaturesPerBody:MAX_FEATURES_PER_BODY,
    usage,
    operations:Object.fromEntries(keys.map(key => [key, classify(key, candidate, usage)])),
  };
}

export const capabilityInstructions = 'runtimeCapabilities 记录本次实际接入层及候选容量。只有未达成的必要目标确实依赖某个受限操作时才报告平台缺口，标出对应 operation key。已有等效受支持方案时指出如何修复设计；实际网页证据未取得时保留待验证。不得用工具能力说明代替草稿通过证据。geometry.revisionDependencies 如存在，复核所列关节、导向和基准；对新增的实体交叠判断是否影响安装或运动。包络接触只用于选择邻件。';
