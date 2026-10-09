import assert from 'node:assert/strict';
import test from 'node:test';
import {createModelEngine,validateGroundedDocument} from '../server/model.ts';
import {emptyProfile} from '../server/store.ts';
import {buildAnalysis} from '../server/matching.ts';
import type {Profile,ResumeDocument} from '../shared/types.ts';

const env={MODEL_BASE_URL:'https://model.example/v1',MODEL_NAME:'test-model',MODEL_API_KEY:'test-only'};
const course='隐私政策课程项目。检索20份公开政策并记录材料出处。';
const campus='校园招聘会志愿者，协助参会企业对接与现场安排。';
const profile={...emptyProfile(),facts:[{id:'course',text:course,source:course,confirmed:true},{id:'campus',text:campus,source:campus,confirmed:true}]};
const job={company:'示例公司',title:'资料整理实习',text:'协助资料整理。',url:''};
const analysis=buildAnalysis(profile,job);
const document:ResumeDocument={headline:'资料整理实习',summary:'',theme:'modern',accent:'navy',sections:[{id:'practice',title:'实践经历',items:[{id:'course_item',title:'隐私政策检索',subtitle:'项目实践',date:'',content:'检索20份公开政策并记录材料出处。',factIds:['course']},{id:'campus_item',title:'校园招聘会',subtitle:'志愿者',date:'',content:'协助参会企业对接与现场安排。',factIds:['campus']}]}]};
const response=(document:ResumeDocument)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({document,rationale:'依据已确认原文组织。',reviewNotes:[]})}}]}));

test('one course-identity repair retains other content and revalidates all evidence',async t=>{
  let calls=0;
  const fixed=structuredClone(document);fixed.sections[0].items[0].subtitle='课程项目';
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    calls++;if(calls===2){const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;assert.equal(data.validationFailure.code,'missing_course_identity');assert.equal(data.validationFailure.itemId,'course_item');assert.deepEqual(data.facts.map((fact:any)=>fact.id),['course','campus']);}
    return response(calls===1?document:fixed);
  });
  const before=structuredClone(profile);
  const result=await createModelEngine(env).draftResume(profile,job,analysis);
  assert.equal(calls,2);assert.deepEqual(result.document,fixed);assert.deepEqual(profile,before);
  assert.ok(result.reviewNotes?.some(note=>note.includes('一次限定修正')));
});

test('scope repair may remove only the rejected item while retaining valid experiences',async t=>{
  let calls=0;const fixed=structuredClone(document);fixed.sections[0].items.shift();
  t.mock.method(globalThis,'fetch',async()=>response(++calls===1?document:fixed));
  const result=await createModelEngine(env).draftResume(profile,job,analysis);
  assert.equal(calls,2);assert.equal(result.document!.sections[0].items.length,1);
  assert.equal(result.document!.sections[0].items[0].id,'campus_item');
});

test('a second scope violation stays rejected without a repair loop',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return response(document);});
  await assert.rejects(createModelEngine(env).draftResume(profile,job,analysis),/课程身份/);
  assert.equal(calls,2);
});

test('repair cannot alter unrelated items, dates, fact references, or add ungrounded numbers',async t=>{
  for(const mutate of [
    (doc:ResumeDocument)=>{doc.sections[0].items[1].content='独立领导企业项目。';},
    (doc:ResumeDocument)=>{doc.sections[0].items[0].date='2025.03';},
    (doc:ResumeDocument)=>{doc.sections[0].items[0].factIds=['course','campus'];},
    (doc:ResumeDocument)=>{doc.sections[0].items[0].content+='新增业务收入300万元。';},
  ]){
    let calls=0;const fixed=structuredClone(document);fixed.sections[0].items[0].subtitle='课程项目';mutate(fixed);
    const mock=t.mock.method(globalThis,'fetch',async()=>response(++calls===1?document:fixed));
    await assert.rejects(createModelEngine(env).draftResume(profile,job,analysis),/已拦截/);assert.equal(calls,2);mock.mock.restore();
  }
});

test('numeric hallucinations and unknown references do not trigger a scope-repair request',async t=>{
  for(const mutate of [
    (doc:ResumeDocument)=>{doc.sections[0].items[0].content+='提高效率30%。';},
    (doc:ResumeDocument)=>{doc.sections[0].items[0].factIds=['unknown'];},
  ]){
    let calls=0;const invalid=structuredClone(document);mutate(invalid);
    const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;return response(invalid);});
    await assert.rejects(createModelEngine(env).draftResume(profile,job,analysis));assert.equal(calls,1);mock.mock.restore();
  }
});

test('reviewed company course-product work is distinct from a personal course assignment',()=>{
  const companyProfile:Profile=structuredClone(profile);
  companyProfile.facts=[{id:'company',text:'参与课程研究，整理用户反馈。',source:'教育公司实习：参与课程研究，整理用户反馈。',confirmed:true,
    experience:{id:'exp_company',title:'教育公司研究助理',kind:'internship',role:'实习生'},sourceContext:'教育公司实习\n课程研究助理'}];
  const output=structuredClone(document);
  output.sections[0].items=[{id:'company_item',title:'教育公司',subtitle:'研究助理实习生',date:'',content:'整理用户反馈。',factIds:['company']}];
  assert.doesNotThrow(()=>validateGroundedDocument(companyProfile,output));
  companyProfile.facts[0].experience={id:'exp_course',title:'研究论文',kind:'education',role:'学生'};
  companyProfile.facts[0].sourceContext='个人课程论文：课程研究';
  assert.throws(()=>validateGroundedDocument(companyProfile,output),/课程身份/);
  companyProfile.facts[0].experience={id:'exp_company',title:'教育公司研究助理',kind:'internship',role:'实习生'};
  companyProfile.facts[0].text+='未担任项目负责人。';
  output.sections[0].items[0].content='担任项目负责人，整理用户反馈。';
  assert.throws(()=>validateGroundedDocument(companyProfile,output),/升级为负责人/);
});
