import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {editableForgeSource} from '../forge-source.js';

const run=promisify(execFile);
const body=(name,partIndex,positionMm,sizeMm)=>({
  name,partIndex,role:'printed',positionMm,
  features:[{op:'add',shape:'box',sizeMm,centerMm:[0,0,0],rotationDeg:[0,0,0]}]
});
const plan={version:1,bodies:[
  body('Encoder seat',0,[20,3,0],[4,3,2]),body('Knob',1,[22,3,7],[4,2,2]),
  body('Rotation indicator',2,[24,3,7],[1,1,1]),body('Housing',3,[5,-10,2],[2,2,2])
]};
const parts=plan.bodies.map(b=>({qty:1,sizeMm:b.features[0].sizeMm}));
const turn={id:'turn',label:'Turn dial',kind:'turn',fixedBodyIndex:0,movingBodyIndices:[1,2],axis:[0,0,1],pivotMm:[20,3,7],step:90};
const press={id:'press',label:'Press dial',kind:'press',fixedBodyIndex:0,movingBodyIndices:[1],axis:[0,0,-1],pivotMm:[20,3,7],step:1};
const interaction={controls:[turn,press]};

test('native editable source keeps shared controls, dependent bodies and resting geometry',async()=>{
  const source=await editableForgeSource(plan,parts,null,interaction);
  assert.match(source,/addRevolute\(/);
  assert.match(source,/addPrismatic\(/);
  assert.match(source,/addJointCoupling\(/);
  assert.match(source,/return mechanism\.solve\(\)/);
  for(const name of ['Encoder seat','Knob','Rotation indicator','Housing'])assert.ok(source.includes('addPart("'+name+'"'));
  assert.doesNotMatch(source,/addFixed\("Attach (Encoder seat|Housing)"/);
  const touch=await editableForgeSource(plan,parts,null,{controls:[{...press,kind:'touch',movingBodyIndices:[],step:0}]});
  assert.doesNotMatch(touch,/addPrismatic|addRevolute/);
  assert.doesNotMatch(await editableForgeSource(plan,parts,1,interaction),/mechanism\.|addFrame/);
});

test('ForgeCAD solves rest and combined input poses with the physical seat and shell fixed',
 {skip:process.env.FORGECAD_RESEARCH_AUTOMATION!=='true'||!process.env.FORGECAD_BIN},async()=>{
  const source=await editableForgeSource(plan,parts,null,interaction);
  const probe=`
    const primary=["1. Press dial","2. Turn dial"];
    const poses=[[0,0],[0,90],[1,90]].map(([distance,angle])=>{
      const solved=mechanism.solve({[primary[0]]:distance,[primary[1]]:angle});
      return ["Encoder seat","Knob","Rotation indicator","Housing"].map(name=>{
        const b=solved.getPart(name).boundingBox();
        return b.min.map((v,i)=>(v+b.max[i])/2);
      });
    });
    console.log("FORMWORK_NATIVE_POSES="+JSON.stringify(poses));
  `;
  const dir=await mkdtemp(join(tmpdir(),'formwork-forge-joints-'));
  try{
    const path=join(dir,'control.forge.js');
    await writeFile(path,source.replace('return mechanism.solve();',probe+'\nreturn mechanism.solve();'));
    const {stdout}=await run(process.env.FORGECAD_BIN,['run',path],{timeout:30000});
    assert.match(stdout,/Objects: 4/);
    const poses=JSON.parse(/FORMWORK_NATIVE_POSES=(\[.*\])/.exec(stdout)[1]);
    const expected=[
      [[20,3,0],[22,3,7],[24,3,7],[5,-10,2]],
      [[20,3,0],[20,5,7],[20,7,7],[5,-10,2]],
      [[20,3,0],[20,5,6],[20,7,7],[5,-10,2]]
    ];
    const values=poses.flat(2);
    assert.ok(expected.flat(2).every((v,i)=>Math.abs(v-values[i])<1e-6));
  }finally{await rm(dir,{recursive:true,force:true})}
});
