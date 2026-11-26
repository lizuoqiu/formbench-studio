const efforts=new Set(['low','medium','high','xhigh','max']);
export function reasoningSettings(env={}){
  const effort=env.OPENAI_REASONING_EFFORT||'max';
  if(!efforts.has(effort))throw Error('OPENAI_REASONING_EFFORT 无效。');
  return {effort};
}
export function responseBudget(body){
  const name=body.text?.format?.name;
  // Output limits include hidden reasoning, not just the final JSON.
  return ['hardware_design','hardware_design_revision','hardware_design_review','hardware_repair_plan'].includes(name)?65536:32768;
}
