import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerEngine, discoveryCity } from '../server/career-engine.ts';
import { COMPANY_CATALOG } from '../server/company-catalog.ts';
import type { Profile, ResumeDocument, ResumeVersion } from '../shared/types.ts';

const profile: Profile = {
  name: '测试同学', email: 'private@example.invalid', phone: '13800001234', school: '示例大学', education: '本科', major: '法学',
  graduation: '2027', city: '', availability: '', targetRole: '', experienceText: '原始未确认内容',
  facts: [{ id: 'fact1', text: '参与法律案例检索，整理研究材料。与团队沟通分析框架。提交研究报告。', source: '用户填写', confirmed: true }, { id: 'pending', text: '未经确认的独家秘密', source: '待审核', confirmed: false }],
};
const document: ResumeDocument = { headline: '合规实习', summary: '参与研究。整理材料。完成反馈。', theme: 'modern', accent: 'forest', sections: [
  { id: 'education', title: '教育背景', items: [{ id: 'edu', title: '示例大学', subtitle: '法学 · 本科', date: '2027', content: '', factIds: [] }] },
  { id: 'experience', title: '项目与实践', items: [{ id: 'exp', title: '法律研究项目', subtitle: '', date: '', content: profile.facts[0].text, factIds: ['fact1'] }] },
] };
const resume: ResumeVersion = { id: 'r1', version: 1, createdAt: '', profile, job: { company: '测试企业', title: '合规实习', text: '法规研究与资料整理', url: '' }, bullets: [{ text: profile.facts[0].text, factIds: ['fact1'] }], rationale: '', approved: true, document };
const liveEnv = { MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'test-model', MODEL_API_KEY: 'secret-do-not-log' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test('job discovery follows the latest city preference without widening remote work to all cities', () => {
  assert.equal(discoveryCity({ ...profile, city: '北京' }, [{ role: 'user', content: '希望去上海或深圳' }]), '上海、深圳');
  assert.equal(discoveryCity({ ...profile, city: '北京' }, [{ role: 'user', content: '希望远程工作' }]), '远程');
  assert.equal(discoveryCity({ ...profile, city: '北京' }, [{ role: 'user', content: '城市不限' }]), '城市不限');
});

test('law exploration spans industries and asks for preferences before companies', async () => {
  const result = await createCareerEngine({}).chat(profile, [], []);
  assert.ok(result.directions.some(d => /互联网/u.test(d.industry) && /隐私/u.test(d.role)));
  assert.ok(result.directions.some(d => /制造/u.test(d.industry) && /产品合规/u.test(d.role)));
  assert.match(result.message, /日常工作/);
  assert.match(result.message, /城市/);
  assert.ok(result.directions.every(d => /岗位职能、城市、职级、经验/u.test(d.salaryContext)));
  assert.ok(result.directions.every(d => !/\d/u.test(d.salaryContext)));
  assert.match(result.directions[0].entryRequirements, /具体 JD/u);
});

test('conversation responds to city, interest and priority and excludes unwanted industries', async () => {
  const engine = createCareerEngine({});
  const initial = await engine.chat(profile, [], []);
  const next = await engine.chat(profile, [{ role: 'user', content: '我更喜欢出海产品合规，希望在上海，最看重成长和薪资，不考虑互联网。' }], initial.directions);
  assert.match(next.message, /上海/); assert.match(next.decisionSummary || '', /成长/); assert.match(next.decisionSummary || '', /薪资/);
  assert.ok(next.directions.every(d => !d.industry.includes('互联网')));
  assert.match(next.directions[0].industry, /制造/);
  assert.ok(!next.message.includes('你希望在哪些城市'));
  assert.notEqual(initial.message, next.message);
});

test('other majors receive different industry-role paths', async () => {
  const result = await createCareerEngine({}).chat({ ...profile, major: '计算机科学', facts: [{ id: 'tech', text: '开发 React 页面。', source: '', confirmed: true }] }, [], []);
  assert.ok(result.directions.some(d => /开发/u.test(d.role)));
  assert.ok(result.directions.some(d => /制造/u.test(d.industry)));
  assert.ok(result.directions.every(d => !/律师|法考/u.test(d.entryRequirements)));
});

test('current explicit major takes precedence over stale law history and earlier directions', async () => {
  const engine = createCareerEngine({});
  const original = await engine.chat(profile, [{ role: 'user', content: '我是法学专业学生，想考虑合规。' }], []);
  for (const major of ['计算机科学', '新闻传播学']) {
    const result = await engine.chat({ ...profile, major }, [
      { role: 'user', content: '我是法学专业学生，想考虑合规。' },
      { role: 'assistant', content: original.message },
      { role: 'user', content: '我的资料已经更新，希望在上海发展。' },
    ], original.directions);
    assert.ok(result.directions.every(d => !d.id.startsWith('law_')));
    assert.ok(result.directions.some(d => d.id.startsWith(major === '计算机科学' ? 'tech_' : 'general_')));
    assert.ok(!result.message.includes('法学背景可以'));
  }
});

test('latest active career intention can cross current major without inheriting older rejected work', async () => {
  const result = await createCareerEngine({}).chat(profile, [
    { role: 'user', content: '我以前想做企业法务。' },
    { role: 'user', content: '现在不想做合规，希望转向软件开发。' },
  ], []);
  assert.ok(result.directions.every(d => d.id.startsWith('tech_')));
});

test('a newer explicit inclusion reverses industry exclusion and later exclusion takes effect again', async () => {
  const engine = createCareerEngine({});
  const messages: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: '不考虑互联网。' }];
  const excluded = await engine.chat(profile, messages, []);
  assert.ok(excluded.directions.every(d => !d.industry.includes('互联网')));
  messages.push({ role: 'user', content: '现在想考虑互联网。' });
  const restored = await engine.chat(profile, messages, excluded.directions);
  assert.ok(restored.directions.some(d => d.industry.includes('互联网')));
  assert.match(restored.directions[0].industry, /互联网/);
  messages.push({ role: 'user', content: '薪资和成长更重要，希望在上海。' });
  const retained = await engine.chat(profile, messages, restored.directions);
  assert.ok(retained.directions.some(d => d.industry.includes('互联网')));
  messages.push({ role: 'user', content: '还是不考虑互联网，优先咨询。' });
  const excludedAgain = await engine.chat(profile, messages, retained.directions);
  assert.ok(excludedAgain.directions.every(d => !d.industry.includes('互联网')));
  assert.match(excludedAgain.directions[0].industry, /咨询/);
});

test('an incidental industry mention does not undo an exclusion but explicit cancellation does', async () => {
  const engine = createCareerEngine({});
  const messages: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: '我对互联网不感兴趣。' }, { role: 'user', content: '朋友在互联网公司工作。' }];
  const excluded = await engine.chat(profile, messages, []);
  assert.ok(excluded.directions.every(d => !d.industry.includes('互联网')));
  const restored = await engine.chat(profile, [...messages, { role: 'user', content: '我现在不再排除互联网。' }], excluded.directions);
  assert.ok(restored.directions.some(d => d.industry.includes('互联网')));
});

test('historical background only fills missing current major', async () => {
  const result = await createCareerEngine({}).chat({ ...profile, major: '', facts: [] }, [
    { role: 'user', content: '我是法学专业学生。' },
    { role: 'user', content: '希望在上海。' },
  ], []);
  assert.ok(result.directions.some(d => d.id.startsWith('law_')));
});

test('company candidates stay in selected directions with only curated URLs and no auto-selection', async () => {
  const engine = createCareerEngine({});
  const exploration = await engine.chat(profile, [], []);
  const selected = exploration.directions.filter(d => d.id === 'law_export');
  const companies = await engine.recommendCompanies(profile, selected, []);
  assert.ok(companies.length >= 2);
  assert.ok(companies.every(c => c.industry === selected[0].industry && c.role === selected[0].role));
  assert.ok(companies.every(c => c.hiringStatus === 'unverified' && !c.selected));
  assert.ok(companies.every(c => COMPANY_CATALOG.some(source => source.careerUrl === c.careerUrl && source.checkedAt === c.checkedAt)));
  assert.ok(companies.every(c => /尚未确认/u.test(c.rationale) && /岗位待核验/u.test(c.sourceLabel)));
  assert.equal(new Set(companies.map(c => c.id)).size, companies.length);
  await assert.rejects(engine.recommendCompanies(profile, [], []), /先选择/);
  assert.deepEqual(await engine.recommendCompanies(profile, [{ ...selected[0], industry: '未知行业' }], []), []);
});

test('demo edits theme, color and section order while retaining the original version', async () => {
  const result = await createCareerEngine({}).editResume(resume, '改成深蓝色经典版式，把教育背景放到最后');
  assert.equal(result.document.theme, 'classic'); assert.equal(result.document.accent, 'navy');
  assert.equal(result.document.sections.at(-1)?.id, 'education');
  assert.equal(resume.document?.theme, 'modern'); assert.equal(resume.document?.sections[0].id, 'education');
  assert.match(result.message, /已完成/);
});

test('demo replaces explicit user wording and can remove a section', async () => {
  const engine = createCareerEngine({});
  const changed = await engine.editResume(resume, '把“参与法律案例检索”改成“开展法律案例检索”');
  assert.match(changed.document.sections[1].items[0].content, /开展法律案例检索/);
  assert.ok(changed.reviewNotes.some(n => /审核/u.test(n)));
  const removed = await engine.editResume(resume, '删除教育背景');
  assert.equal(removed.document.sections.length, 1);
});

test('concise edit keeps original sentences and unrecognized edit does not claim success', async () => {
  const engine = createCareerEngine({});
  const concise = await engine.editResume(resume, '请精简内容');
  assert.equal(concise.document.sections[1].items[0].content, '参与法律案例检索，整理研究材料。\n与团队沟通分析框架。\n提交研究报告。');
  const unchanged = await engine.editResume(resume, '给简历加一段不存在的诺贝尔奖获奖经历');
  assert.deepEqual(unchanged.document, document);
  assert.match(unchanged.message, /没有执行/);
  assert.ok(!unchanged.message.includes('已完成'));
});

test('fixed education layout requests explain their limit without claiming a change', async () => {
  const fixed = structuredClone(resume); fixed.document!.sections = fixed.document!.sections.filter(s => s.id !== 'education');
  const result = await createCareerEngine({}).editResume(fixed, '把教育背景放到最后');
  assert.match(result.message, /位置固定/); assert.match(result.message, /本次没有修改/);
  assert.deepEqual(result.document, fixed.document);
});

test('new ungrounded numeric achievements are rejected even in explicit rewrite', async () => {
  await assert.rejects(createCareerEngine({}).editResume(resume, '把“提交研究报告”改成“提交研究报告并提升效率 80%”'), /尚无依据的数字/);
});

test('partial and unsafe live configuration is rejected', () => {
  assert.throws(() => createCareerEngine({ MODEL_NAME: 'x' }), /配置不完整/);
  assert.throws(() => createCareerEngine({ ...liveEnv, MODEL_BASE_URL: 'http://remote.example/v1' }), /格式无效/);
});

test('live exploration redacts contacts and omits unconfirmed raw experience', async t => {
  const demo = await createCareerEngine({}).chat(profile, [], []);
  let body = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = String(init.body); return response(demo); });
  await createCareerEngine(liveEnv).chat(profile, [{ role: 'user', content: `联系电话 ${profile.phone}，邮件 ${profile.email}` }], []);
  assert.ok(!body.includes(profile.phone)); assert.ok(!body.includes(profile.email));
  assert.ok(!body.includes(profile.facts[1].text)); assert.ok(!body.includes(profile.experienceText));
});

test('live company selection cannot fabricate a company or URL', async t => {
  const engine = createCareerEngine({}); const directions = (await engine.chat(profile, [], [])).directions;
  t.mock.method(globalThis, 'fetch', async () => response({ candidates: [{ id: 'fake_company', rationale: '未知公司' }] }));
  await assert.rejects(createCareerEngine(liveEnv).recommendCompanies(profile, directions, []), /超出了/);
});

test('live edit permits wording but rejects new numbers and invalid fact ids', async t => {
  const changed = structuredClone(document); changed.sections[1].items[0].content = '开展法律案例检索与研究资料整理。';
  t.mock.method(globalThis, 'fetch', async () => response({ document: changed, message: '已润色研究经历。', reviewNotes: [] }));
  const result = await createCareerEngine(liveEnv).editResume(resume, '帮我润色');
  assert.match(result.document.sections[1].items[0].content, /开展/u);
  assert.ok(result.reviewNotes.some(n => /模型润色/u.test(n)));
  changed.sections[1].items[0].content += '效率提升 50%。';
  await assert.rejects(createCareerEngine(liveEnv).editResume(resume, '继续润色'), /尚无依据的数字/);
  changed.sections[1].items[0].content = '整理资料。'; changed.sections[1].items[0].factIds = ['pending'];
  await assert.rejects(createCareerEngine(liveEnv).editResume(resume, '继续润色'), /无效事实引用/);
});

test('live edit reports actual changes even when the model claims more work', async t => {
  const changed = structuredClone(document);
  changed.theme = changed.theme === 'classic' ? 'modern' : 'classic';
  t.mock.method(globalThis, 'fetch', async () => response({ document: changed, message: '已精简个人简介并合并重复正文。', reviewNotes: ['你缺少互联网合规能力。'] }));
  const result = await createCareerEngine(liveEnv).editResume(resume, '换版式并精简');
  assert.match(result.message, /版式/u);
  assert.match(result.message, /正文未变化/u);
  assert.doesNotMatch(result.message, /已精简|合并重复/u);
  assert.ok(result.reviewNotes.every(note => !note.includes('你缺少')));
  changed.summary = '参与法律案例检索与研究。';
  const edited = await createCareerEngine(liveEnv).editResume(resume, '更新个人简介');
  assert.match(edited.message, /个人简介/u);
  assert.doesNotMatch(edited.message, /正文未变化/u);
});

test('live import accepts only literal grounded fields and retains locally parsed contacts', async t => {
  const raw = '姓名：林同学\n示例大学 本科 法学\n2027 毕业\n电话：13800001234\n邮箱：private@example.invalid';
  let body = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = String(init.body); return response({ fields: { name: '林同学', major: '法学', education: '博士', school: '不存在的大学' }, warnings: [] }); });
  const result = await createCareerEngine(liveEnv).enrichImport(raw, { education: '本科', school: '示例大学', email: profile.email, phone: profile.phone });
  assert.equal(result.fields.name, '林同学'); assert.equal(result.fields.major, '法学'); assert.equal(result.fields.education, '本科');
  assert.equal(result.fields.school, '示例大学'); assert.equal(result.fields.email, profile.email);
  assert.equal(result.warnings.length, 2); assert.ok(!body.includes(profile.email)); assert.ok(!body.includes(profile.phone));
});

test('live import ignores a truncated model experience reply and retains all projects, skills and limitations', async t => {
  const projects = '2025年3月至6月，我参与隐私政策课程研究，检索公开资料，对比三家虚构平台的条款，并整理研究表格。\n2025年9月至12月，我参与校园模拟法庭，负责证据资料检索和论证初稿，最终与团队完成课堂展示。';
  const skills = '我会使用Excel整理研究材料，Python正在学习中，尚未在真实业务中使用；我未通过法考，没有律师执业资格。';
  const fullExperience = `${projects}\n${skills}`;
  const raw = `姓名：林澄\n学校：示例大学\n学历：本科\n专业：法学\n毕业时间：2027年6月\n意向城市：上海\n到岗时间：每周4天，可连续实习3个月\n项目经历\n${fullExperience}`;
  const baseline = { name: '林澄', school: '示例大学', education: '本科', major: '法学', experienceText: fullExperience };
  const original = structuredClone(baseline);
  let sent = '';
  // Shape and truncated experience reproduce the first real DeepSeek import response.
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = String(init.body);
    return response({ fields: { name: '林澄', school: '示例大学', education: '本科', major: '法学', graduation: '2027年6月', city: '上海', availability: '每周4天，可连续实习3个月', experienceText: projects }, warnings: ['未提供求职意向原文'] });
  });
  const result = await createCareerEngine(liveEnv).enrichImport(raw, baseline);
  assert.equal(result.fields.experienceText, fullExperience);
  assert.ok(result.fields.experienceText!.includes(skills));
  assert.equal(result.fields.graduation, '2027年6月');
  assert.equal(result.fields.city, '上海');
  assert.deepEqual(baseline, original);
  assert.equal(JSON.parse(JSON.parse(sent).messages[1].content).data.text, raw);
  assert.ok(!JSON.parse(sent).messages[0].content.includes('"experienceText"'));
});

test('import retains original text when local experience extraction is missing or blank', async t => {
  const raw = '先参与课程研究。\n另参与校园实践。\nPython正在学习中，尚未通过法考。';
  t.mock.method(globalThis, 'fetch', async () => response({ fields: { experienceText: '先参与课程研究。' }, warnings: [] }));
  for (const experienceText of [undefined, '', '  ']) {
    const live = await createCareerEngine(liveEnv).enrichImport(raw, { experienceText });
    const demo = await createCareerEngine({}).enrichImport(raw, { experienceText });
    assert.equal(live.fields.experienceText, raw);
    assert.equal(demo.fields.experienceText, raw);
  }
});

test('provider errors are explicit and never silently fall back or leak upstream bodies', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('secret-do-not-log', { status: 401 }));
  await assert.rejects(createCareerEngine(liveEnv).chat(profile, [], []), error => error instanceof Error && /未切换到演示模式/u.test(error.message) && !error.message.includes('secret-do-not-log'));
});

test('strict live JSON rejects fenced text instead of treating it as a saved result', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{}\n```' } }] })));
  await assert.rejects(createCareerEngine(liveEnv).chat(profile, [], []), /JSON 结构/);
});
