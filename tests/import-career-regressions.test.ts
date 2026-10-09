import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelEngine, factSourceSegments } from '../server/model.ts';
import { createExperienceAgentFixture } from '../server/experience-agent.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { emptyProfile } from '../server/store.ts';
import type { InterviewMessage, Profile } from '../shared/types.ts';

const env = {MODEL_BASE_URL:'https://model.example/v1',MODEL_NAME:'test-model',MODEL_API_KEY:'test-not-a-real-key'};
const respond = (value: unknown) => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const profile: Profile = {...emptyProfile(),name:'合成同学',major:'法学',education:'本科',city:'上海',experienceText:'参与课程法律案例检索。',facts:[{id:'fact-1',text:'参与课程法律案例检索。',source:'参与课程法律案例检索。',confirmed:true}]};

test('local extraction segments retain exact source coverage and stay within the fact limit for many DOCX paragraphs', () => {
  for (const text of [Array.from({length:49},(_,i)=>`第${i+1}段\n参与课程研究并整理真实材料。`).join('\n\n'), '真实项目记录。'.repeat(3750), '短经历']) {
    const segments = factSourceSegments(text);
    assert.ok(segments.length > 0 && segments.length <= 120);
    assert.ok(segments.every(segment => text.includes(segment.text) && segment.text.length <= 6000));
    assert.equal(segments.map(segment=>segment.text).join('').replace(/\s/gu,''),text.replace(/\s/gu,''));
    assert.equal(new Set(segments.map(segment=>segment.id)).size,segments.length);
  }
});
test('live organization retains exact source quotes and hides contact information', async t => {
  const input = {...profile,experienceText:'项目甲｜参与成员\n参与　资料整理，使用 Excel。\n\n联系项目邮箱 synthetic@example.test 及电话13800001234。'};
  const bodies: string[] = [];
  t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit) => {
    const body=String(init.body); bodies.push(body); const data=JSON.parse(JSON.parse(body).messages[1].content).data;
    assert.equal(data.experienceText,undefined);
    return respond(createExperienceAgentFixture(data));
  });
  const result = await createModelEngine(env).extractProfile(input);
  assert.ok(result.facts.length > 0); assert.equal(result.agentRun?.passes,2);
  assert.ok(result.facts.every(fact=>!fact.confirmed&&fact.sourceQuotes?.every(quote=>input.experienceText.includes(quote))));
  for(const body of bodies){assert.ok(!body.includes('synthetic@example.test'));assert.ok(!body.includes('13800001234'));}
});
test('agent organization rejects invented source references and does not silently accept them',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    calls++;const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;
    const output=createExperienceAgentFixture(data) as any;output.facts[0].quotes[0].sourceId='invented_source';return respond(output);
  });
  await assert.rejects(createModelEngine(env).extractProfile(profile),/引用|原文|校验|来源/);assert.ok(calls<=3);
});
test('agent organization accepts grounded paraphrase but rejects invented results',async t=>{
  const input={...profile,experienceText:'参与合同整理，使用 Excel 核对记录。'};let invented=false;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;
    const output=createExperienceAgentFixture(data) as any;
    output.facts[0].text=invented?'独立负责合同审核并提升效率30%。':'使用 Excel 核对合同记录，并参与资料整理。';return respond(output);
  });
  const result=await createModelEngine(env).extractProfile(input);
  assert.notEqual(result.facts[0].text,input.experienceText);assert.equal(result.facts[0].source,input.experienceText);
  invented=true;await assert.rejects(createModelEngine(env).extractProfile(input),/数字|日期|职责|引用/);
});
test('empty experience makes no paid call and duplicate fact identifiers cannot be saved',async t=>{
  let calls=0;let duplicate=false;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{calls++;const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;const output=createExperienceAgentFixture(data) as any;if(duplicate)output.facts.push({...output.facts[0]});return respond(output);});
  assert.deepEqual((await createModelEngine(env).extractProfile({...profile,experienceText:''})).facts,[]);assert.equal(calls,0);
  assert.equal((await createModelEngine(env).extractProfile(profile)).facts.length,1);assert.equal(calls,2);
  duplicate=true;await assert.rejects(createModelEngine(env).extractProfile(profile),/重复/);
});
test('a chosen cross-major path survives a later city-only answer',async()=>{
  const engine=createCareerEngine({});
  const messages:InterviewMessage[]=[{role:'user',content:'我不想做合规，希望转向软件开发。'}];
  const first=await engine.chat(profile,messages,[]);
  messages.push({role:'assistant',content:first.message},{role:'user',content:'上海，优先成长。'});
  const next=await engine.chat(profile,messages,first.directions);
  assert.ok(next.directions.every(direction=>direction.id.startsWith('tech_')));
  assert.doesNotMatch(next.message,/希望在哪些城市/);
});
test('demo explanations and company questions give concrete next steps without restarting preference collection',async()=>{
  const engine=createCareerEngine({});const initial=await engine.chat(profile,[],[]);
  for(const content of ['详细介绍这些岗位每天做什么，怎么准备作品。不要再问城市。','已经说过，我要下一步具体行动。','如何开始公司筛选？']) {
    const next=await engine.chat(profile,[{role:'assistant',content:initial.message},{role:'user',content}],initial.directions);
    assert.ok(next.message.length > 250);assert.doesNotMatch(next.message,/你希望在哪些城市|你更愿意做哪类|你目前最看重/);
    assert.deepEqual(next.directions.map(direction=>direction.id),initial.directions.map(direction=>direction.id));
    assert.match(next.message,/具体 JD|真实 JD|实习时长/);
  }
});
test('live follow-up receives explicit turn context and does not replace existing directions just to elaborate',async t=>{
  const initial=await createCareerEngine({}).chat(profile,[],[]);let body='';
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{body=String(init.body);return respond({message:'我已经理解，请问你希望在哪些城市工作？',directions:initial.directions.map(direction=>({...direction,id:`changed_${direction.id}`,rationale:'重新措辞'}))});});
  const result=await createCareerEngine(env).chat(profile,[{role:'user',content:'上海，优先成长。'},{role:'assistant',content:initial.message},{role:'user',content:'详细解释互联网合规的日常工作，不要再问城市。'}],initial.directions);
  const data=JSON.parse(JSON.parse(body).messages[1].content).data;
  assert.equal(data.conversationPlan.mayAskPreference,false);
  assert.ok(result.message.length>250); assert.doesNotMatch(result.message,/希望在哪些城市/);
  assert.deepEqual(result.directions,initial.directions);
});
test('repeated live answers gain direction-specific actions instead of repeating the same question',async t=>{
  const initial=await createCareerEngine({}).chat(profile,[],[]);const repeated='当前需要进一步确认你的意向。你希望在哪些城市工作？';
  t.mock.method(globalThis,'fetch',async()=>respond({message:repeated,directions:initial.directions}));
  const result=await createCareerEngine(env).chat(profile,[{role:'assistant',content:repeated},{role:'user',content:'上海，已经说过。请给具体行动。'}],initial.directions);
  assert.ok(result.message.length>250);assert.doesNotMatch(result.message,/希望在哪些城市/);assert.match(result.message,/真实 JD|岗位任务/);
});
