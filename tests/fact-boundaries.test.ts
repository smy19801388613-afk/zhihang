import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticFactSources } from '../server/fact-segmentation.ts';
import { createModelEngine, previewFactResegmentation, validateGroundedDocument } from '../server/model.ts';
import { validateExperienceScope } from '../server/resume-grounding.ts';
import { validateModelEdit } from '../server/resume-edit.ts';
import {createExperienceAgentFixture} from '../server/experience-agent.ts';
import { emptyProfile } from '../server/store.ts';
import type { ResumeDocument } from '../shared/types.ts';

// Synthetic DOCX-shaped paragraphs: these are not the user's personal resume.
const campus='2025.03\t春季校园招聘会\t外联部小组长\n\n● 负责参会企业对接与现场安排，整理企业招聘需求。\n\n● 统筹志愿者分工，核对接待流程。';
const course='2025.04—2025.06\t城市交通政策分析\t课程论文\n\n● 使用公开交通统计资料，撰写政策分析报告。\n\n● 梳理政策方案与实施约束。';
const source=['▌ 基本信息','测试同学\n邮箱：test@example.invalid','▌ 教育背景','2023.09—2027.06\t合成大学\t本科','● 核心课程：统计学、政策分析。','▌ 核心优势','● 能够整理文字资料。','● 能够协调活动安排。','▌ 校园经历',campus,'2025.07\t校园辩论赛\t会务部小组长','● 负责赛程核对，确认场地布置。','▌ 项目经历',course,'2025.08\t公共服务建模\t课程设计','● 编写数据处理脚本并整理模型说明。','▌ 技能证书','● 熟悉 Excel。','● 能够阅读英文公开资料。'].join('\n\n');

test('semantic boundaries keep date-role headers and all preceding duties within their own experience',()=>{
  const groups=semanticFactSources(source);
  const external=groups.find(group=>group.text.includes('外联部小组长'))!;
  assert.match(external.text,/核对接待流程/);
  assert.doesNotMatch(external.text,/辩论赛|课程论文|场地布置/);
  const debate=groups.find(group=>group.text.includes('会务部小组长'))!;
  assert.match(debate.text,/场地布置/);assert.doesNotMatch(debate.text,/核对接待流程|城市交通/);
  assert.equal(groups.filter(group=>group.kind==='experience').length,4);
  assert.equal(groups.filter(group=>group.kind==='summary').length,2);
  assert.equal(groups.filter(group=>group.kind==='skills').length,2);
  assert.equal(groups.map(group=>group.text).join('').replace(/\s/gu,''),source.replace(/\s/gu,''));
  for(const group of groups)assert.equal(source.slice(group.start,group.end),group.text);
});

test('resegmentation is a pure pending preview, excludes contact metadata, and links split legacy facts',()=>{
  const profile={...emptyProfile(),experienceText:source,facts:[{id:'old_mixed',text:source,source,confirmed:true}]};
  const before=structuredClone(profile);
  const preview=previewFactResegmentation(profile);
  assert.deepEqual(profile,before);
  assert.ok(preview.facts.length>4);assert.ok(preview.facts.every(fact=>!fact.confirmed&&source.includes(fact.source)&&fact.source.includes(fact.text)));
  assert.ok(preview.groups.every(group=>group.oldFactIds.includes('old_mixed')));
  assert.doesNotMatch(preview.facts.map(fact=>fact.text).join('\n'),/test@example.invalid|基本信息/);
  assert.match(preview.facts.find(fact=>fact.text.includes('外联部'))!.text,/接待流程/);
});

test('long single experiences split only inside their scope and carry the exact original identity',()=>{
  const heading='2025.04\t政策比较\t课程项目';
  const long=`${heading}\n${'● 整理公开政策并记录材料出处。\n'.repeat(240)}\n2025.09\t社区服务\t志愿者\n● 核对现场签到信息。`;
  const groups=semanticFactSources(long);
  assert.ok(groups.length>=3);
  assert.ok(groups.every(group=>long.slice(group.start,group.end)===group.text));
  const continuations=groups.filter(group=>group.sourceContext);
  assert.ok(continuations.length>0);assert.ok(continuations.every(group=>group.sourceContext===heading));
  assert.ok(groups.filter(group=>group.title===heading).every(group=>!group.text.includes('社区服务')));
  const fact={...continuations[0],id:'continued',confirmed:true};
  const profile={...emptyProfile(),facts:[fact]};
  const document:ResumeDocument={headline:'实习申请',summary:'',theme:'modern',accent:'navy',sections:[{id:'project',title:'项目经历',items:[{id:'item',title:'政策比较',subtitle:'企业实习',date:'',content:'整理公开政策并记录材料出处。',factIds:['continued']}]}]};
  assert.throws(()=>validateGroundedDocument(profile,document),/课程身份/);
  document.sections[0].items[0].subtitle='课程项目';
  assert.doesNotThrow(()=>validateGroundedDocument(profile,document));
  const original={...structuredClone(document),sections:[]};
  const resume={id:'r',version:1,createdAt:'',profile,job:{company:'示例',title:'岗位',url:'',text:'示例岗位'},document:original,bullets:[],approved:false,rationale:''};
  assert.doesNotThrow(()=>validateModelEdit(resume,document));
  document.sections[0].items[0].subtitle='企业实习';
  assert.throws(()=>validateModelEdit(resume,document),/课程身份/);
});

test('many independent experiences are not merged or dropped to fit the old 40-fact quota',()=>{
  const many=Array.from({length:45},(_,i)=>`2025.03\t校园活动${i+1}\t参与成员\n● 整理该活动的实际记录。`).join('\n\n');
  const groups=semanticFactSources(many);
  assert.equal(groups.length,45);
  assert.ok(groups.every(group=>(group.text.match(/2025.03/g)||[]).length===1));
});

test('core course lists do not turn a campus leadership role into a course project',()=>{
  assert.doesNotThrow(()=>validateExperienceScope(`▌ 教育背景\n● 核心课程：统计学、政策分析。\n▌ 校园经历\n${campus}`,'春季校园招聘会｜外联部小组长\n负责参会企业对接与现场安排，核对接待流程。','校园经历'));
});

test('a legacy mixed citation resolves the campus role without borrowing a neighboring course identity',()=>{
  const mixed=`${campus}\n\n▌ 项目经历\n${course}`;
  assert.doesNotThrow(()=>validateExperienceScope(mixed,'春季校园招聘会｜外联部小组长\n负责参会企业对接与现场安排，整理企业招聘需求。','外联经历'));
  assert.throws(()=>validateExperienceScope(mixed,'城市交通政策分析｜公司实习\n使用公开交通统计资料，撰写政策分析报告。','研究经历'),/课程身份/);
  assert.throws(()=>validateExperienceScope(mixed,'春季校园招聘会｜外联部小组长\n使用公开交通统计资料，撰写政策分析报告。','借用课程成果'),/课程身份/);
});

test('course projects, qualification denials and personal-responsibility limits remain enforced',()=>{
  assert.throws(()=>validateExperienceScope(course,'城市交通政策分析｜企业实习\n梳理政策方案与实施约束。','项目'),/课程身份/);
  assert.doesNotThrow(()=>validateExperienceScope(course,'城市交通政策分析｜课程论文\n梳理政策方案与实施约束。','项目'));
  assert.throws(()=>validateExperienceScope('参与志愿活动，未担任项目负责人。','担任项目负责人。','职责'),/升级为负责人/);
  assert.throws(()=>validateExperienceScope('未通过法考。','已通过法考。','资格'),/职业资格/);
});

test('live extraction delegates semantic fact wording and independent review while retaining exact evidence',async t=>{
  let calls=0;
  const original='参与校园招聘会的企业对接与现场安排。';
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;
    calls++;assert.equal(data.agentTask,'experience');const result=createExperienceAgentFixture(data) as any;
    result.facts[0].text=data.phase==='review'?'协助校园招聘会企业沟通及现场安排。':'参与校园活动服务。';
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  });
  const result=await createModelEngine({MODEL_BASE_URL:'https://model.example/v1',MODEL_NAME:'test-model',MODEL_API_KEY:'test-only'}).extractProfile({...emptyProfile(),experienceText:original});
  assert.equal(calls,2);assert.equal(result.facts[0].text,'协助校园招聘会企业沟通及现场安排。');
  assert.equal(result.facts[0].source,original);assert.deepEqual(result.facts[0].sourceQuotes,[original]);assert.equal(result.facts[0].confirmed,false);
  assert.equal(result.agentRun?.reviewed,true);
});

test('agent integration rejects invented evidence after its bounded repair',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    calls++;const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;const result=createExperienceAgentFixture(data) as any;
    result.facts[0].quotes[0].quote='原文不存在的企业盈利成果。';
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  });
  await assert.rejects(createModelEngine({MODEL_BASE_URL:'https://model.example/v1',MODEL_NAME:'test-model',MODEL_API_KEY:'test-only'}).extractProfile({...emptyProfile(),experienceText:'参与校园活动。'}),/不完全一致/);
  assert.equal(calls,2);
});
