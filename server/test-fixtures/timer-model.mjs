// Test wiring and control graph for the public V4 timer geometry.
export const wire=(kind,fromPartIndex,fromPin,toPartIndex,toPin)=>({kind,fromPartIndex,fromPin,toPartIndex,toPin});
export function timerModel() {
  const pair={partIndex:5,fixedBodyIndex:5,movingBodyIndices:[11],pivotMm:[32,-23.65,24]};
  const state=(id,label,clock,display,lamp)=>({id,label,clock,outputs:[
    {outputId:'screen',mode:display},{outputId:'lamp',mode:lamp}]});
  const t=(from,event,to,effect='none')=>({from,event,to,effect});
  return {version:1,controllerPartIndex:4,
    controls:[
      {...pair,id:'wheel',label:'旋转',kind:'turn',axis:[0,-1,0],step:15,signalPins:['A','B']},
      {...pair,id:'push',label:'按下',kind:'press',axis:[0,1,0],step:0.5,signalPins:['SW']}],
    outputs:[
      {id:'screen',label:'分钟显示屏',kind:'display',partIndex:11,bodyIndices:[8],signalPin:'SDA'},
      {id:'lamp',label:'提示灯',kind:'light',partIndex:3,bodyIndices:[2,3],signalPin:'DIN'}],
    connections:[
      wire('signal',5,'A',4,'D2'),wire('signal',5,'B',4,'D3'),wire('signal',5,'SW',4,'D4'),
      wire('signal',4,'SDA',11,'SDA'),wire('signal',4,'SCL',11,'SCL'),
      wire('signal',4,'D6',6,'1'),wire('signal',6,'2',3,'DIN'),
      wire('power',10,'VBUS',4,'USB-VBUS'),wire('power',4,'5V',11,'VCC'),wire('power',4,'5V',3,'VDD'),
      wire('ground',10,'GND',4,'GND'),wire('ground',4,'GND',11,'GND'),
      wire('ground',4,'GND',3,'GND'),wire('ground',4,'GND',5,'COM')],
    timer:{initialSeconds:180,minSeconds:60,maxSeconds:3600,stepSeconds:60},initialState:'set',
    states:[
      state('set','设定','hold','value','off'),state('run','计时','run','remaining','on'),
      state('pause','暂停','hold','remaining','off'),state('done','时间到','hold','remaining','breathe')],
    transitions:[t('set','wheel','set','adjust'),t('set','push','run','restart'),
      t('run','push','pause'),t('pause','push','run'),t('run','timer.expired','done'),t('done','push','set','reset')]};
}

// A sensor-only display: starting, sampling and finishing are simulated external
// events. This can use the same documented connections as the encoder fixture.
export function recorderFixture() {
  const m=timerModel();m.controls=[];m.timer=null;m.initialState='idle';m.outputs=[m.outputs[0]];
  m.systemEvents=[['begin','开始记录','connection'],['sample','检测到变化','feedback'],['finish','查看记录','connection']].map(([id,label,kind])=>({id,label,kind,partIndex:4,sourcePins:['D4'],condition:label,delayMs:null}));
  m.states=[['idle','准备'],['capture','记录中'],['review','回看']].map(([id,label])=>({id,label,clock:'hold',outputs:[{outputId:'screen',mode:'on'}]}));
  m.transitions=[['idle','begin','capture'],['capture','finish','review'],['review','begin','capture']].map(([from,event,to])=>({from,event,to,effect:'none'}));
  m.recorder={displayId:'screen',captureStates:['capture'],reviewStates:['review'],sampleEvents:['sample']};return m;
}
