import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerEngine } from '../server/career-engine.ts';
import { companyCoverageNotice } from '../server/company-catalog.ts';
import { emptyProfile } from '../server/store.ts';
import type { InterviewMessage } from '../shared/types.ts';

const profile = { ...emptyProfile(), name: '合成同学', major: '法学', facts: [{ id: 'f1', text: '参与课程案例检索。', source: '参与课程案例检索。', confirmed: true }] };
const noSearch = async () => ({ sources: [] });
const live = { MODEL_BASE_URL: 'http://127.0.0.1:12345/v1', MODEL_NAME: 'synthetic', MODEL_API_KEY: 'synthetic-key' };
const respond = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test('three exploratory replies stop preference collection even when the user is unsure', async () => {
  const engine = createCareerEngine({}, { search: noSearch });
  const messages: InterviewMessage[] = []; let directions = [] as (Awaited<ReturnType<typeof engine.chat>>)['directions'];
  const questions = new Set<string>();
  for (let round = 1; round <= 3; round++) {
    messages.push({ role: 'user', content: '我还不确定，可以先介绍方向。' });
    const reply = await engine.chat(profile, messages, directions);
    const asked = reply.message.match(/[^。！？\n]*[？?]/gu) || [];
    assert.ok(asked.length <= 1);
    for (const question of asked) { assert.ok(!questions.has(question)); questions.add(question); }
    assert.ok(reply.directions.length >= 2 && reply.directions.length <= 4);
    if (round === 3) { assert.equal(reply.conversationPhase, 'ready'); assert.equal(asked.length, 0); assert.match(reply.decisionSummary || '', /确认.*方向.*找岗位/); }
    directions = reply.directions; messages.push({ role: 'assistant', content: reply.message });
  }
});

test('ready state remains ready when the next question asks for a concrete explanation', async () => {
  const engine = createCareerEngine({}, { search: noSearch }); const initial = await engine.chat(profile, [], []);
  const reply = await engine.chat(profile, [{ role: 'assistant', content: initial.message }, { role: 'user', content: '详细解释合规的日常任务。' }], initial.directions, { forceReady: true });
  assert.equal(reply.conversationPhase, 'ready'); assert.doesNotMatch(reply.message, /[？?]/u);
  assert.deepEqual(reply.directions.map(direction => direction.id), initial.directions.map(direction => direction.id));
});

test('live follow-up strips repeated background, limits questions and enforces completed phase', async t => {
  const initial = await createCareerEngine({}, { search: noSearch }).chat(profile, [], []);
  t.mock.method(globalThis, 'fetch', async () => respond({ message: '根据你的法学专业和课程经历，我们先重新了解背景。数据合规通常先梳理数据流向，再检索对应规则，整理需要业务同学确认的问题。你希望在哪些城市工作？你最看重成长还是薪资？', directions: initial.directions, conversationPhase: 'explore' }));
  const reply = await createCareerEngine(live, { search: noSearch }).chat(profile, [{ role: 'assistant', content: initial.message }, { role: 'user', content: '说说日常工作。' }], initial.directions, { forceReady: true });
  assert.equal(reply.conversationPhase, 'ready'); assert.doesNotMatch(reply.message, /根据你的|[？?]/u); assert.match(reply.message, /数据流向/);
});

test('attachments stay reference material and image bytes use native content parts', async t => {
  const initial = await createCareerEngine({}, { search: noSearch }).chat(profile, [], []); let body: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return respond({ message: '附件里的岗位要求可以先按日常任务分组，经历部分仍需要你逐条确认后才能用于简历。', directions: initial.directions }); });
  const original = structuredClone(profile);
  await createCareerEngine(live, { search: noSearch }).chat(profile, [{ role: 'user', content: '分析附件' }], initial.directions, { attachments: [{ name: '岗位.txt', kind: 'document', text: '尚未确认的课程描述。' }, { name: '截图.png', kind: 'image', dataUrl: 'data:image/png;base64,YQ==' }] });
  const parts = body.messages[1].content;
  assert.equal(parts[1].type, 'image_url'); assert.equal(parts[1].image_url.url, 'data:image/png;base64,YQ==');
  const data = JSON.parse(parts[0].text).data;
  assert.equal(data.attachments[0].text, '尚未确认的课程描述。'); assert.ok(!JSON.stringify(data.profile.facts).includes('尚未确认'));
  assert.deepEqual(profile, original);
});

test('current and historical documents share one budget and message history never duplicates full attachments', async t => {
  const initial = await createCareerEngine({}, { search: noSearch }).chat(profile, [], []); let body: any;
  const currentText = '本轮文档开头' + '甲'.repeat(10000) + '本轮文档结尾';
  const historicalText = '历史文档开头' + '乙'.repeat(12000) + '历史文档结尾';
  const messages: InterviewMessage[] = [
    { role: 'user', content: '之前的材料', attachments: [{ id: 'old-doc', name: '旧文档.txt', kind: 'document', size: 12000, text: historicalText }, { id: 'old-image', name: '旧图片.png', kind: 'image', size: 100 }] },
    { role: 'assistant', content: '上次已讨论岗位任务。' },
    { role: 'user', content: '结合本轮文件比较方向', attachments: [{ id: 'current-doc', name: '本轮文档.txt', kind: 'document', size: 10000, text: currentText }] },
  ];
  const original = structuredClone(messages);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return respond({ message: '本轮材料优先读取，历史文档只提供了开头；未包含的细节还需另行核对，旧图片需要重新上传才能查看。', directions: initial.directions }); });
  await createCareerEngine(live, { search: noSearch }).chat(profile, messages, initial.directions, { attachments: [{ name: '本轮文档.txt', kind: 'document', text: currentText }] });
  const data = JSON.parse(body.messages[1].content).data;
  assert.ok(data.messages.flatMap((message: any) => message.attachments || []).every((attachment: any) => !('text' in attachment) && !('dataUrl' in attachment)));
  assert.equal(JSON.stringify(data).split(currentText).length - 1, 1, 'Current full text appears only in bounded reference materials');
  assert.ok(!JSON.stringify(data).includes(historicalText), 'History body is not duplicated outside the shared budget');
  const included = data.attachments.reduce((sum: number, attachment: any) => sum + (attachment.text?.length || 0), 0);
  assert.equal(included, 18000); assert.equal(data.attachmentReading.includedDocumentCharacters, included);
  assert.equal(data.attachments.find((attachment: any) => attachment.scope === 'history').truncated, true);
  assert.equal(data.messages[0].attachments.find((attachment: any) => attachment.kind === 'image').originalImageAvailable, false);
  assert.match(data.attachmentReading.imageHistory, /没有原图.*重新上传/);
  assert.deepEqual(messages, original, 'Stored conversation and attachment metadata are not mutated');
});

test('uncovered industries return an empty pool with actionable explanation instead of throwing', async () => {
  const engine = createCareerEngine({}, { search: noSearch }); const initial = await engine.chat(profile, [], []);
  const directions = [{ ...initial.directions[0], industry: '航天材料研究' }];
  assert.deepEqual(await engine.recommendCompanies(profile, directions, []), []);
  assert.match(companyCoverageNotice(directions) || '', /保留所选方向.*浏览器扩展/);
});

test('a model multi-industry label becomes concrete selectable cards without discarding the answer', async t => {
  const initial = await createCareerEngine({}, { search: noSearch }).chat(profile, [], []);
  t.mock.method(globalThis, 'fetch', async () => respond({ message: '可以分别比较互联网、制造和金融领域中的合规支持任务，之后按具体招聘要求核对资格。', directions: [{ ...initial.directions[0], industry: '互联网/消费品制造/金融等' }, { ...initial.directions[1], industry: '各类企业' }] }));
  const reply = await createCareerEngine(live, { search: noSearch }).chat(profile, [{ role: 'user', content: '请给我具体方向' }], []);
  assert.deepEqual(reply.directions.map(direction => direction.industry), ['互联网', '消费品制造', '金融']);
  assert.equal(new Set(reply.directions.map(direction => direction.id)).size, 3);
  assert.match(reply.message, /分别比较/);
});

test('asking to compare a new industry can add it instead of permanently freezing the first directions', async t => {
  const initial = await createCareerEngine({}, { search: noSearch }).chat(profile, [], []);
  const prior = initial.directions.filter(direction => direction.industry.includes('互联网'));
  t.mock.method(globalThis, 'fetch', async () => respond({ message: '互联网侧重数据和平台规则，制造业侧重产品标准和贸易要求，可以分别核对工作任务和入门条件。', directions: initial.directions.filter(direction => /互联网|制造/u.test(direction.industry)) }));
  const reply = await createCareerEngine(live, { search: noSearch }).chat(profile, [{ role: 'user', content: '比较互联网与制造业合规的日常任务' }], prior, { forceReady: true });
  assert.ok(reply.directions.some(direction => /制造/u.test(direction.industry)));
  assert.equal(reply.conversationPhase, 'ready');
});
