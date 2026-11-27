// Form controls only. The service supplies every project-specific question and choice.
const make=(tag,className,label)=>{
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(label!==undefined)el.textContent=label;
  return el;
};

export function mountQuestions(container,questions,onAnswer,onCancel){
  const form=make('form','intake-form'),fields=[];
  const submit=make('button','small-button intake-submit','提交回答');
  submit.type='submit';submit.id='send-answer';submit.disabled=true;
  const progress=make('span','intake-progress');progress.setAttribute('aria-live','polite');
  function update(){
    const count=fields.filter(f=>f.answer().length>0).length;
    submit.disabled=count!==questions.length;
    progress.textContent=questions.length>1?'已答 '+count+' / '+questions.length:'';
  }
  for(const [index,q] of questions.entries()){
    const field=make('fieldset','intake-field'),legend=make('legend','',q.question);
    if(index===0)legend.id='discussion-question';
    const choices=make('div','intake-choices'),name='intake-'+index;
    function choice(label,token){
      const item=make('label','intake-choice'),radio=make('input');
      radio.type='radio';radio.name=name;radio.value=token;
      item.append(radio,make('span','',label));choices.append(item);return radio;
    }
    q.options.forEach((label,i)=>choice(label,String(i)));
    const other=choice('自己填写','custom');
    choice('由 AI 决定','delegate');
    const custom=make('input','intake-custom');
    custom.type='text';custom.maxLength=1800;custom.autocomplete='off';
    custom.id='discussion-answer-'+index;custom.setAttribute('aria-label',q.question+' 自己填写');custom.placeholder='写下你的想法';custom.hidden=true;
    other.setAttribute('aria-controls',custom.id);
    field.append(legend,choices,custom);form.append(field);
    fields.push({question:q,delegated:()=>field.querySelector('input:checked')?.value==='delegate',answer(){
      const selected=field.querySelector('input:checked')?.value;
      if(selected==='custom')return custom.value.trim();
      if(selected==='delegate')return '这个选择由 AI 决定。';
      return selected===undefined?'':q.options[Number(selected)];
    }});
    field.addEventListener('change',event=>{
      if(event.target.type!=='radio')return;
      custom.hidden=!other.checked;
      if(other.checked)custom.focus();
      update();
    });
    custom.addEventListener('input',update);
  }
  const cancel=make('button','discussion-link','取消');cancel.type='button';cancel.id='cancel-discussion';
  cancel.addEventListener('click',onCancel);
  const actions=make('div','discussion-controls intake-actions');actions.append(submit,progress,cancel);form.append(actions);
  form.addEventListener('submit',event=>{
    event.preventDefault();if(submit.disabled)return;
    const replies=fields.map(f=>({question:f.question,answer:f.answer(),delegated:f.delegated()}));
    if(replies.some(r=>!r.answer))return;
    submit.disabled=true;onAnswer(replies);
  });
  container.append(form);
  form.scrollIntoView({block:'nearest'});
}
