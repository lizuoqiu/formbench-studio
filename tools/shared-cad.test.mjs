import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileCadPlan} from '../consumer-geometry.js';

const catalogRoot=new URL('../samples/shared/',import.meta.url);
const json=async path=>JSON.parse(await readFile(new URL(path,catalogRoot),'utf8'));

test('each published revision has its original design, matching saved ForgeCAD parts, and a real preview',async()=>{
  const catalog=await json('manifest.json'), seen=new Set();
  for(const project of catalog.projects){
    assert.ok(!seen.has(project.slug));
    seen.add(project.slug);
    assert.equal(project.source,'studio');
    for(const [i,v] of project.versions.entries()){
      assert.equal(v.version,i+1);
      const publicRecord=await json(v.design),{design}=publicRecord,artifact=await json(v.cad);
      assert.doesNotMatch(JSON.stringify(publicRecord),/"mechanicalEvidenceReceipt"\s*:/);
      assert.deepEqual(artifact.cadPlan,design.cadPlan);
      assert.equal(design.generation.provider,'openai-api');
      assert.ok(design.generation.modelId);
      assert.equal(artifact.engine,'ForgeCAD CLI '+artifact.version);
      const preview=await readFile(new URL(v.preview,catalogRoot));
      assert.equal(preview.toString('ascii',8,12),'WEBP');
      assert.equal(artifact.bodies.length,design.cadPlan.bodies.length);
      for(const [j,body] of artifact.bodies.entries()){
        const b=design.cadPlan.bodies[j],bytes=Buffer.from(body.stlBase64,'base64');
        assert.equal(body.name,b.name);assert.equal(body.partIndex,b.partIndex);
        assert.deepEqual(body.positionMm,b.positionMm);
        assert.ok(bytes.readUInt32LE(80)>0);assert.equal(bytes.length,84+50*bytes.readUInt32LE(80));
      }
    }
  }
  for(const slug of ['hygrometer','usb-timekey','reading-timer','photo-cover'])assert.ok(seen.has(slug),slug);
  const withReference=catalog.projects.flatMap(p=>p.versions.filter(v=>v.referenceImage).map(v=>[p.slug,v.referenceImage]));
  assert.deepEqual(withReference,[['photo-cover','photo-cover/base-reference.png']]);
  const reference=await readFile(new URL(withReference[0][1],catalogRoot));
  assert.equal(reference.toString('ascii',1,4),'PNG');
});

test('the shared reading timer preserves all five recorded revisions and the initial clarification',async()=>{
  const {projects}=await json('manifest.json');
  const {versions}=projects.find(project=>project.slug==='reading-timer');
  assert.deepEqual(versions.map(v=>v.version),[1,2,3,4,5]);
  assert.equal(versions.at(-1).interactive,true);
  assert.equal(versions.at(-1).verification.interaction,'checked');
  const records=await Promise.all(versions.map(v=>json(v.design)));
  assert.equal(records.at(-1).design.generation.designReview.status,'preview-reviewed');
  const first=records[0].iteration.conversation;
  assert.ok(first.some(m=>m.role==='assistant' && m.text.trim()));
  assert.ok(first.some(m=>m.role==='user' && m.text.trim()));
  for(const [index,record] of records.entries()){
    assert.equal(record.iteration.version,index+1);
    assert.ok(versions[index].prompt.trim());
    if(index){
      const earlier=records[index-1].iteration.conversation;
      assert.deepEqual(record.iteration.conversation.slice(0,earlier.length),earlier);
      assert.ok(record.iteration.conversation.some(m=>m.role==='user' && m.text===versions[index].prompt));
    }
  }
});

test('an explicitly shared revision reads its immutable CAD on loopback and never regenerates it',async()=>{
  const v=(await json('manifest.json')).projects[0].versions[0],{design}=await json(v.design),artifact=await json(v.cad);
  const baseUrl='http://127.0.0.1:4173/index.html',savedCadUrl=new URL('samples/shared/'+v.cad,baseUrl).href;
  const requests=[],config={baseUrl,savedCadUrl,engine:'forgecad',fetcher:async(url,options)=>{
    requests.push([url.href,options.method||'GET']);assert.equal(url.href,savedCadUrl);return Response.json(artifact);
  }};
  const result=await compileCadPlan(design.cadPlan,config);
  assert.equal(result.engine,artifact.engine);assert.ok(result.exact);assert.deepEqual(requests,[[savedCadUrl,'GET']]);
  const stale=structuredClone(design.cadPlan);stale.bodies[0].positionMm[0]++;
  await assert.rejects(compileCadPlan(stale,config),/保存的 CAD/);
  assert.deepEqual(requests,[[savedCadUrl,'GET'],[savedCadUrl,'GET']]);
  await assert.rejects(compileCadPlan(design.cadPlan,{...config,savedCadUrl:'https://remote.test/file'}),/地址无效/);
});
