import {modelInput,photoInstructions} from './design-conversation.mjs';
import {format,ModelStageError,structuredCall} from './design-review.mjs';
import {intakeGuide} from './modeling-guide.mjs';
import {track} from './run-events.mjs';

const string={type:'string'};
const enumOf=(...values)=>({type:'string',enum:values});
const record=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const schema=record({
  outcome:record({status:enumOf('open','stated','inherited','delegated'),description:string,quote:string}),
  questions:{type:'array',items:record({topic:enumOf('outcome','use'),question:string,
    options:{type:'array',items:string},impact:string})}
});
const nonempty=(value,limit)=>typeof value==='string'&&value.trim().length>0&&value.length<=limit;
const questionKey=text=>text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');

function readIntake(value,ctx){
  const {outcome,questions}=value??{};
  if(!outcome||!schema.properties.outcome.properties.status.enum.includes(outcome.status)||
     typeof outcome.quote!=='string'||outcome.quote.length>1000||!Array.isArray(questions))
    return {retry:'返回完整的用途状态、原话依据和待决问题。'};
  if(outcome.status!=='open'){
    const quotes=[ctx.prompt,...ctx.history.filter((turn,i)=>turn.role==='user'&&
      (!turn.delegated||(outcome.status==='delegated'&&ctx.history[i-1]?.topic==='outcome'))).map(t=>t.text)];
    if(outcome.status==='inherited'){
      if(!ctx.baseDesign)return {retry:'新设计没有可继承的旧版用途。'};
      quotes.push(ctx.baseDesign.name,ctx.baseDesign.summary);
    }
    const source=outcome.quote.trim();
    if(!nonempty(outcome.description,800)||!source||!quotes.some(text=>text?.includes(source)))
      return {retry:'请核对预期结果的原话依据。用途没有得到说明时提出用途问题。'};
  }
  const used=new Set();
  const history=ctx.history.slice(ctx.discussionStart);
  for(let i=0;i<history.length-1;i++){
    if(history[i].role!=='assistant'||history[i+1].role!=='user')continue;
    used.add(questionKey(history[i].text));
    used.add(questionKey(history[i].text.replace(/（[^（）]*）$/u,'')));
  }
  const fresh=[];
  for(const q of questions){
    if(!q||!['outcome','use'].includes(q.topic)||!nonempty(q.question,600)||!nonempty(q.impact,700)||
       !Array.isArray(q.options)||q.options.length>3||!q.options.every(s=>nonempty(s,160)))
      return {retry:'每个问题需要有效的题目、选项以及不同答案对设计的具体影响。'};
    const key=questionKey(q.question);
    if(!key||used.has(key))continue;
    const options=q.options.map(s=>s.trim());
    if(options.length===1||new Set(options.map(questionKey)).size!==options.length)
      return {retry:'给这道题提供至少两个不同的答案；如有意义的选项不够，请保留自由输入。'};
    used.add(key);
    fresh.push({topic:q.topic,question:q.question.trim(),options});
  }
  if(outcome.status==='open'){
    const primary=fresh.findIndex(q=>q.topic==='outcome');
    if(primary<0)return {retry:'用途仍然不清楚。请换一个尚未得到回答的用途问题，让用户说明希望得到的实际结果。'};
    if(primary>0)fresh.unshift(...fresh.splice(primary,1));
  }
  if(!fresh.length&&questions.length)
    return {retry:'提议的问题已回答。阅读这些答案，给出其他真正影响选型或体验的问题；如已足够，给出有用户原话依据的用途并清空 questions。'};
  const batch=fresh.slice(0,4);
  // Keep the first question readable by clients cached before grouped intake.
  return {reason:outcome.status,reply:batch.length?{decision:'ask',question:batch[0].question,options:batch[0].options,questions:batch}:{decision:'ready',question:'',options:[]}};
}

export async function discussRequirements(ctx,env,send,signal){
  const guide=await intakeGuide(env),input=modelInput(ctx),hasImages=ctx.images.length>0;
  const instructions=guide.text+(hasImages?'\n'+photoInstructions:'');
  let correction='';
  for(let attempt=0;attempt<2;attempt++){
    const result=await structuredCall(send,env,signal,{
      instructions:correction?instructions+'\n'+correction:instructions,input,text:format('hardware_clarification',schema)
    },'设计讨论',{hasImages});
    const assessment=readIntake(result.value,ctx);
    if(assessment.reply){
      track(env,'discussion.decision',{decision:assessment.reply.decision,count:assessment.reply.questions?.length??0,reason:assessment.reason});
      return assessment.reply;
    }
    correction=assessment.retry;
    track(env,'discussion.recheck',{attempt:attempt+1});
  }
  throw new ModelStageError('暂时没能厘清需求，可以重试这次讨论。');
}
