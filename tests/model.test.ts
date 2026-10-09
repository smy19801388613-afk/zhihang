import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { createModelEngine, validateGroundedDocument, validateResumeDraft } from '../server/model.ts';
import { createJobAgentFixture, type JobReview } from '../server/job-analysis-agent.ts';
import type { Job, Profile, ResumeDocument, ResumeVersion } from '../shared/types.ts';

const profile: Profile = {
  name: '测试同学', email: 'private@example.invalid', phone: '13800001234', school: '示例大学', education: '本科',
  graduation: '2027', city: '北京', availability: '每周三天', targetRole: '产品实习生',
  experienceText: '负责校园活动宣传。参与用户调研并整理反馈。',
  facts: [
    { id: 'confirmed', text: '参与用户调研并整理反馈。', source: '参与用户调研并整理反馈。', confirmed: true },
    { id: 'pending', text: '带领团队提升收入 90%。', source: '未确认材料', confirmed: false },
  ],
};
const job: Job = { company: '示例公司', title: '产品实习生', text: '参与用户调研与需求分析。每周到岗三天。', url: '' };
const liveEnv = { MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'example-model', MODEL_API_KEY: 'secret-do-not-log' };
const groundedDocument: ResumeDocument = {
  headline: '产品实习生', summary: '具有用户调研和反馈整理的实践经历。', theme: 'modern', accent: 'navy',
  sections: [{ id: 'practice', title: '实践经历', items: [{
    id: 'research', title: '用户调研与反馈整理', subtitle: '', date: '',
    content: '参与用户调研工作，归纳并整理用户反馈。', factIds: ['confirmed'],
  }] }],
};

/** Contract fixtures exercise both agent stages through the real provider transport. */
function curationFixture(payload: any) {
  const data = JSON.parse(payload.messages[1].content).data;
  return data.agentTask === 'job_analysis' ? createJobAgentFixture(data) : undefined;
}
function analysisResponse(init: RequestInit, overrides: Partial<JobReview> | ((data: any) => Partial<JobReview>) = {}, fenced = false) {
  const data = JSON.parse(JSON.parse(String(init.body)).messages[1].content).data;
  const reply = createJobAgentFixture(data, data.phase === 'review' ? typeof overrides === 'function' ? overrides(data) : overrides : {});
  const content = JSON.stringify(reply);
  return new Response(JSON.stringify({ choices: [{ message: { content: fenced ? '```json\n' + content + '\n```' : content } }] }), { status: 200 });
}

async function mockProvider(t: TestContext, result: () => unknown) {
  const requests: Array<{ url: string; authorization?: string; payload: any }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push({ url: request.url || '', authorization: request.headers.authorization, payload: JSON.parse(body) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(curationFixture(JSON.parse(body)) || result()) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { requests, env: { ...liveEnv, MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1` } };
}

test('no configuration selects an explicitly labelled deterministic demo', async () => {
  const engine = createModelEngine({});
  assert.equal(engine.mode, 'demo');
  assert.match(engine.model, /规则演示/);
  const { facts: _facts, ...input } = profile;
  const first = await engine.extractProfile(input);
  assert.deepEqual(await engine.extractProfile(input), first);
  assert.equal(first.facts.length, 2);
  assert.ok(first.facts.every(fact => !fact.confirmed && input.experienceText.includes(fact.source) && fact.source.includes(fact.text)));
});

test('demo does not invent an experience when input is empty and asks for direction', async () => {
  const { facts: _facts, ...input } = profile;
  const output = await createModelEngine({}).extractProfile({ ...input, experienceText: '', targetRole: '' });
  assert.deepEqual(output.facts, []);
  assert.ok(output.questions.some(question => question.includes('岗位')));
});

test('partial and unsafe model configuration fails without exposing secrets', () => {
  for (const config of [{ MODEL_NAME: 'example-model' }, { MODEL_API_KEY: 'secret-do-not-log' }, { MODEL_BASE_URL: liveEnv.MODEL_BASE_URL, MODEL_NAME: liveEnv.MODEL_NAME }]) {
    assert.throws(() => createModelEngine(config), error => error instanceof Error && error.message.includes('配置不完整') && !error.message.includes('secret-do-not-log'));
  }
  assert.throws(() => createModelEngine({ ...liveEnv, MODEL_BASE_URL: 'https://user:secret-do-not-log@model.example/v1' }), /格式无效/);
  assert.throws(() => createModelEngine({ ...liveEnv, MODEL_BASE_URL: 'http://remote.example/v1' }), /格式无效/);
});

test('pending facts are excluded and attendance cites the actual profile field', async () => {
  const engine = createModelEngine({});
  const analysis = await engine.analyzeJob(profile, job);
  assert.ok(analysis.matches.every(match => !match.factIds.includes('pending')));
  assert.equal(analysis.matches.find(match => match.requirement.includes('到岗'))?.status, 'supported');
  assert.deepEqual(analysis.matches.find(match => match.requirement.includes('到岗'))?.profileFields, ['availability']);
  assert.match(analysis.summary, /规则演示/);
  const resume = await engine.draftResume(profile, job, analysis);
  assert.deepEqual(resume.bullets, [{ text: profile.facts[0].text, factIds: ['confirmed'] }]);
  assert.ok(!JSON.stringify(resume).includes('90%'));
});

test('a learning or negated skill never becomes supported through keyword matching', async () => {
  const learning = { ...profile, facts: [{ id: 'learning', text: '正在学习 SQL，尚未在真实业务中使用 SQL。', source: '正在学习 SQL，尚未在真实业务中使用 SQL。', confirmed: true }] };
  const analysis = await createModelEngine({}).analyzeJob(learning, { ...job, text: '熟练掌握 SQL，具备真实业务数据分析经验。' });
  assert.equal(analysis.matches[0].status, 'partial');
  assert.match(analysis.summary, /未进行模型语义判断/);
  assert.match(analysis.matches[0].evidence, /尚未/);
});

test('resume validator rejects pending/unknown/empty ids, extra metrics, and duplicate evidence', () => {
  assert.doesNotThrow(() => validateResumeDraft(profile, [{ text: profile.facts[0].text, factIds: ['confirmed'] }]));
  for (const factIds of [['pending'], ['unknown'], [], ['confirmed', 'confirmed']]) {
    assert.throws(() => validateResumeDraft(profile, [{ text: profile.facts[0].text, factIds }]));
  }
  assert.throws(() => validateResumeDraft(profile, [{ text: '参与用户调研，效率提升 30%。', factIds: ['confirmed'] }]), /原文不一致/);
  const bullet = { text: profile.facts[0].text, factIds: ['confirmed'] };
  assert.throws(() => validateResumeDraft(profile, [bullet, bullet]), /重复/);
});

test('no confirmed fact means resume generation fails', async () => {
  const engine = createModelEngine({});
  const pending = { ...profile, facts: profile.facts.map(fact => ({ ...fact, confirmed: false })) };
  await assert.rejects(engine.draftResume(pending, job, await engine.analyzeJob(pending, job)), /确认至少一条/);
});

test('live agent accepts fenced JSON and sends only full JD plus confirmed personal evidence', async t => {
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { bodies.push(String(init.body)); return analysisResponse(init, {}, true); });
  const result = await createModelEngine(liveEnv).analyzeJob(profile, job);
  assert.equal(bodies.length, 2);
  for (const body of bodies) for (const privateText of ['90%', 'experienceText', profile.name, profile.email, profile.phone]) assert.ok(!body.includes(privateText));
  const first = JSON.parse(JSON.parse(bodies[0]).messages[1].content).data;
  const reviewed = JSON.parse(JSON.parse(bodies[1]).messages[1].content).data;
  assert.equal(first.profile, undefined); assert.equal(first.facts, undefined);
  assert.equal(first.sources.map((item: any) => item.text).join(''), job.text);
  assert.deepEqual(reviewed.facts.map((item: any) => item.id), ['confirmed']);
  assert.equal(result.agentRun?.reviewed, true); assert.equal(result.agentRun?.model, 'example-model');
  assert.ok(result.matches.every(match => match.sourceQuotes?.every(quote => job.text.includes(quote))));
});

test('live agent preserves reviewed learning versus explicit qualification denial', async t => {
  const negative = { id: 'negative', text: 'Python正在学习中，尚未在真实业务中使用，也未通过法律职业资格考试。', source: '用户填写', confirmed: true };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => analysisResponse(init, data => ({ requirements: data.draft.requirements.map((item: any, i: number) => ({ ...item, evidenceState: i ? 'unmet' : 'partial', transferability: 'none', evidence: i ? '用户明确表示未通过法律职业资格考试。' : '正在学习相关工具，尚无真实业务使用的支持证据。', gap: i ? '当前明确未通过考试。' : '真实业务经验待补充。', evidenceRefs: [{ kind: 'fact', id: 'negative', quote: negative.text, relation: i ? 'contradicts' : 'supports' }] })) })));
  const result = await createModelEngine(liveEnv).analyzeJob({ ...profile, facts: [...profile.facts, negative] }, { ...job, text: '具备Python真实业务使用经验。\n具有法律职业资格。' });
  assert.deepEqual(result.matches.map(match => match.evidenceState), ['partial', 'unmet']);
  assert.deepEqual(result.matches[1].factIds, ['negative']);
});

test('live agent rejects invented JD quotes and pending personal references within a bounded budget', async t => {
  let calls = 0; let invalid = 'source';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { calls++; return analysisResponse(init, data => {
    const result = createJobAgentFixture(data) as JobReview;
    if (invalid === 'source') result.requirements[0].sources = [{ sourceId: 'jd_999', quote: '岗位原文没有的要求' }];
    else result.requirements[0].evidenceRefs = [{ kind: 'fact', id: invalid, quote: '不存在的依据', relation: 'supports' }];
    return result;
  }); });
  for (invalid of ['source', 'pending', 'unknown']) {
    calls = 0;
    await assert.rejects(createModelEngine(liveEnv).analyzeJob(profile, job), /校验|引用|修复/);
    assert.ok(calls <= 3);
  }
});

test('a grounded semantic transfer is retained without requiring shared keywords', async t => {
  const semantic = { ...profile, facts: [{ id: 'sponsor', text: '在校园外联活动中访谈赞助商，澄清需求并协调物料交付。', source: '本人填写', confirmed: true }] };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => analysisResponse(init, data => ({ requirements: [{ ...data.draft.requirements[0], requirement: '沟通客户需求并协调协作', evidenceState: 'partial', transferability: 'transferable', evidence: '校园外联中的需求澄清与协作方法可以迁移，但尚未证明企业客户交付。', gap: '企业客户场景仍需核对。', evidenceRefs: [{ kind: 'fact', id: 'sponsor', quote: semantic.facts[0].text, relation: 'supports' }] }] })));
  const result = await createModelEngine(liveEnv).analyzeJob(semantic, { ...job, text: '面向客户明确业务诉求，协调内部协作。' });
  assert.equal(result.matches[0].transferability, 'transferable');
  assert.equal(result.matches[0].evidenceState, 'partial');
  assert.deepEqual(result.matches[0].factIds, ['sponsor']);
  assert.match(result.matches[0].evidence, /可以迁移/);
});

test('live HTTP agent sees every long JD paragraph and reviews its final condition', async t => {
  const longText = Array.from({ length: 24 }, (_, index) => '负责第' + (index + 1) + '类资料的整理与分析。').join('\n') + '\n需要工作许可。';
  const provider = await mockProvider(t, () => ({}));
  const result = await createModelEngine(provider.env).analyzeJob(profile, { ...job, text: longText });
  assert.equal(provider.requests.length, 2);
  for (const request of provider.requests) {
    const data = JSON.parse(request.payload.messages[1].content).data;
    assert.equal(data.sources.map((item: any) => item.text).join(''), longText);
  }
  assert.ok(result.matches.at(-1)!.requirement.includes('需要工作许可。'));
  assert.equal(result.matches.at(-1)!.evidenceState, 'unknown');
});

test('live extraction rejects invalid model structure without silently accepting it', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [{ text: '提升收入 30%', source: '提升收入 30%' }], questions: [] }) } }] })); });
  const { facts: _facts, ...input } = profile;
  await assert.rejects(createModelEngine(liveEnv).extractProfile(input), /校验|复核|结构|修复/);
  assert.ok(calls <= 3);
});

test('live resume rejects a new metric even when it cites a valid confirmed fact', async t => {
  const document = structuredClone(groundedDocument);
  document.sections[0].items[0].content = '参与用户调研，转化率提升 30%。';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ document, rationale: '根据岗位定制。' }) } }] })));
  const analysis = await createModelEngine({}).analyzeJob(profile, job);
  await assert.rejects(createModelEngine(liveEnv).draftResume(profile, job, analysis), /没有依据的数字/);
});

test('live HTTP generation organizes and polishes confirmed facts without changing the profile', async t => {
  const original = structuredClone(profile);
  const provider = await mockProvider(t, () => ({ document: groundedDocument, rationale: '突出岗位相关的调研与反馈整理经历。', reviewNotes: ['请核对精简后的个人行动描述。'] }));
  const engine = createModelEngine({ ...provider.env, MODEL_JSON_MODE: 'true' });
  const analysis = await createModelEngine({}).analyzeJob(profile, job);
  const result = await engine.draftResume(profile, job, analysis);
  assert.deepEqual(result.document, groundedDocument);
  assert.notEqual(result.document!.sections[0].items[0].content, profile.facts[0].text);
  assert.equal(result.authoredBy, 'model');
  assert.ok(result.reviewNotes?.some(note => /不能证明语义真实/u.test(note)));
  assert.deepEqual(result.bullets, [{ text: '用户调研与反馈整理\n参与用户调研工作，归纳并整理用户反馈。', factIds: ['confirmed'] }]);
  assert.deepEqual(profile, original);
  assert.equal(provider.requests[0].url, '/v1/chat/completions');
  assert.equal(provider.requests[0].authorization, `Bearer ${liveEnv.MODEL_API_KEY}`);
  assert.deepEqual(provider.requests[0].payload.response_format, { type: 'json_object' });
  const sent = JSON.stringify(provider.requests[0].payload);
  assert.ok(sent.includes(profile.facts[0].text));
  for (const privateText of [profile.email, profile.phone, profile.name, profile.experienceText, profile.facts[1].text]) assert.ok(!sent.includes(privateText));
});

test('resume review notes distinguish missing evidence from missing ability', async t => {
  const provider = await mockProvider(t, () => ({ document: groundedDocument, rationale: '组织事实。', reviewNotes: ['你缺少互联网产品数据流实操能力。'] }));
  const analysis = { summary: '待核验', matches: [{ requirement: '了解数据隐私合规流程', status: 'missing' as const, factIds: [], evidence: '暂无证据' }], questions: [], directionAdvice: [] };
  const draft = await createModelEngine(provider.env).draftResume(profile, job, analysis);
  assert.ok(draft.reviewNotes?.some(note => note.includes('了解数据隐私合规流程') && note.includes('不代表你不具备')));
  assert.ok(draft.reviewNotes?.every(note => !note.includes('你缺少')));
});

test('live HTTP generation rejects unknown, pending, missing references and invented metrics', async t => {
  const document = structuredClone(groundedDocument);
  const provider = await mockProvider(t, () => ({ document, rationale: '按岗位组织。' }));
  const engine = createModelEngine(provider.env);
  const analysis = await createModelEngine({}).analyzeJob(profile, job);
  for (const factIds of [['unknown'], ['pending'], [], ['confirmed', 'confirmed']]) {
    document.sections[0].items[0].factIds = factIds;
    await assert.rejects(engine.draftResume(profile, job, analysis), /无效的事实引用/);
  }
  document.sections[0].items[0].factIds = ['confirmed'];
  document.sections[0].items[0].content += '转化率提升 30%。';
  await assert.rejects(engine.draftResume(profile, job, analysis), /没有依据的数字/);
});

test('grounded document quantities are normalized and checked against each cited fact', () => {
  const quantitative: Profile = { ...profile, facts: [
    { id: 'confirmed', text: '2025 年整理 1,000 条反馈。', source: '2025 年整理 1,000 条反馈。', confirmed: true },
    { id: 'other', text: '记录 30 条校园活动建议。', source: '记录 30 条校园活动建议。', confirmed: true },
  ] };
  const document = structuredClone(groundedDocument);
  const item = document.sections[0].items[0];
  item.date = '2025'; item.content = '整理用户反馈 1000 条。';
  assert.doesNotThrow(() => validateGroundedDocument(quantitative, document));
  item.content = '整理用户反馈 30 条。';
  assert.throws(() => validateGroundedDocument(quantitative, document), /没有依据的数字/);
  item.content = '整理用户反馈 1000 条，效率提升百分之五十。';
  assert.throws(() => validateGroundedDocument(quantitative, document), /没有依据的数字/);
  item.content = '整理用户反馈 1000 条。'; item.date = '2026';
  assert.throws(() => validateGroundedDocument(quantitative, document), /没有依据的数字或日期/);
});

test('grounded documents reject empty experience, duplicate identifiers and excessive output', () => {
  const empty = structuredClone(groundedDocument); empty.sections[0].items[0].content = '';
  assert.throws(() => validateGroundedDocument(profile, empty), /缺少有事实依据的正文/);
  const duplicate = structuredClone(groundedDocument); duplicate.sections[0].items[0].id = duplicate.sections[0].id;
  assert.throws(() => validateGroundedDocument(profile, duplicate), /结构、长度或段落标识/);
  const emptySection = structuredClone(groundedDocument); emptySection.sections[0].items = [];
  assert.throws(() => validateGroundedDocument(profile, emptySection), /至少需要一条/);
  const long = structuredClone(groundedDocument); long.sections[0].items[0].content = '过'.repeat(5001);
  assert.throws(() => validateGroundedDocument(profile, long), /结构、长度或段落标识/);
});

test('downstream request redacts contacts embedded in facts and interview answers', async t => {
  const withContact: Profile = { ...profile, facts: [{ ...profile.facts[0], text: `${profile.facts[0].text}联系：${profile.phone}，${profile.email}` }] };
  let response: unknown = { document: groundedDocument, rationale: '按岗位组织。' };
  const provider = await mockProvider(t, () => response);
  const engine = createModelEngine(provider.env);
  await engine.draftResume(withContact, job, await createModelEngine({}).analyzeJob(withContact, job));
  response = { message: '请说明整理反馈时的具体行动。' };
  const resume: ResumeVersion = { id: 'contact', version: 1, createdAt: '', profile: withContact, job, approved: true, rationale: '', bullets: [{ text: withContact.facts[0].text, factIds: ['confirmed'] }] };
  await engine.interview(resume, [{ role: 'user', content: `联系我：${profile.phone}，邮箱 ${profile.email}` }]);
  assert.equal(provider.requests.length, 2);
  for (const request of provider.requests) {
    const sent = JSON.stringify(request.payload);
    assert.ok(!sent.includes(profile.phone)); assert.ok(!sent.includes(profile.email));
    assert.ok(sent.includes('[邮箱已隐藏]')); assert.ok(sent.includes('[电话已隐藏]'));
  }
});

test('provider timeout is explicit and does not produce a demo output', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('private provider diagnostic', 'TimeoutError'); });
  await assert.rejects(createModelEngine(liveEnv).analyzeJob(profile, job), error => error instanceof Error && error.message.includes('超时') && !error.message.includes('private provider diagnostic'));
});

test('live output rejects unsupported evidence and never silently falls back on provider failure', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => analysisResponse(init, data => ({ requirements: [{ ...data.draft.requirements[0], evidenceState: 'supported', transferability: 'direct', evidence: '未经确认的资料。', gap: '', evidenceRefs: [{ kind: 'fact', id: 'pending', quote: profile.facts[1].text, relation: 'supports' }] }] }))); 
  await assert.rejects(createModelEngine(liveEnv).analyzeJob(profile, job), /引用|校验|修复/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('secret-do-not-log provider diagnostic', { status: 401 }));
  await assert.rejects(createModelEngine(liveEnv).analyzeJob(profile, job), error => error instanceof Error && error.message.includes('HTTP 401') && !error.message.includes('secret-do-not-log'));
});

test('demo interview responds to the latest answer and the bound resume snapshot', async () => {
  const resume: ResumeVersion = { id: 'resume_1', version: 3, createdAt: '', profile, job, bullets: [{ text: profile.facts[0].text, factIds: ['confirmed'] }], rationale: '', approved: true };
  const engine = createModelEngine({});
  const first = await engine.interview(resume, []);
  assert.match(first, /V3/);
  assert.ok(first.includes(profile.facts[0].text));
  const answer = await engine.interview(resume, [{ role: 'assistant', content: first }, { role: 'user', content: '我负责整理调研反馈。' }]);
  assert.match(answer, /个人角色/);
  assert.match(answer, /主要困难/);
  assert.notEqual(first, answer);
});

test('live interview receives only the submitted bullets, not other confirmed profile experiences', async t => {
  const unusedFact = { id: 'unused', text: '未选入该版简历的另一段经历。', source: '原始材料', confirmed: true };
  const resume: ResumeVersion = { id: 'resume_1', version: 3, createdAt: '', profile: { ...profile, facts: [...profile.facts, unusedFact] }, job, bullets: [{ text: profile.facts[0].text, factIds: ['confirmed'] }], rationale: '', approved: true };
  let requestBody = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requestBody = String(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: '请介绍你参与用户调研时承担的工作。' }) } }] }));
  });
  await createModelEngine(liveEnv).interview(resume, []);
  assert.ok(requestBody.includes(profile.facts[0].text));
  assert.ok(!requestBody.includes(unusedFact.text));
  assert.ok(!requestBody.includes(profile.email));
});
