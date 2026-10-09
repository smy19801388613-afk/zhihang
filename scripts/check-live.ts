import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SettingsManager } from '../server/model-settings.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { probeModel } from '../server/model-provider.ts';
import { Workflow } from '../server/workflow.ts';
import { Store } from '../server/store.ts';
import { renderResumePdf, closeBrowser } from '../server/browser.ts';
import type { Action, WorkspaceState } from '../shared/types.ts';

// This opt-in check uses paid requests and synthetic data only. It never changes
// the user's settings/database or writes decrypted credentials to any artifact.
if (!process.argv.includes('--run')) {
  console.log('Paid live check is opt-in: npx tsx scripts/check-live.ts --run');
  process.exit(0);
}
const root = process.cwd();
const settings = new SettingsManager(resolve(root, 'data'), {});
const publicSettings = settings.public();
assert.equal(publicSettings.mode, 'live', '请先在模型设置中启用真实模型。');
const env = settings.env();
const key = env.MODEL_API_KEY!;
const clean = (value: string) => value.replaceAll(key, '[REDACTED]');
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'live-deepseek-'));
const base = 'http://127.0.0.1:4317';
const before = await (await fetch(base + '/api/state')).json();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const beforeDigest = digest(before);
const store = new Store(':memory:');
const workflow = new Workflow(store, createModelEngine(env), {
  fill: async () => { throw new Error('Live model check never fills or submits an application.'); },
  submit: async () => { throw new Error('Live model check never fills or submits an application.'); },
}, createCareerEngine(env));
const calls: Array<Record<string, unknown>> = [];
const checks: Array<{ stage: string; seconds: number; result: string; detail?: string }> = [];
const resumeIndex = process.argv.indexOf('--resume');
const resumeDirectory = resumeIndex < 0 ? null : resolve(process.argv[resumeIndex + 1] || '');
const completedStages = new Set<string>();
if (resumeDirectory) {
  assert.ok(resumeDirectory.startsWith(resolve(root, 'test-results') + '\\') || resumeDirectory.startsWith(resolve(root, 'test-results') + '/'), 'Only this project test artifacts may be resumed.');
  const prior = JSON.parse(readFileSync(resolve(resumeDirectory, 'report.json'), 'utf8'));
  assert.equal(prior.syntheticDataOnly, true); assert.equal(prior.model, publicSettings.model); assert.equal(prior.provider, publicSettings.provider);
  const synthetic = JSON.parse(readFileSync(resolve(resumeDirectory, 'synthetic-workspace.json'), 'utf8')) as WorkspaceState;
  store.save(synthetic, 0);
  for (const check of prior.checks.filter((entry: { result: string }) => entry.result === 'PASS')) { checks.push(check); completedStages.add(check.stage); }
}
const originalFetch = globalThis.fetch;
let stageName = '';
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (new URL(url).hostname !== new URL(publicSettings.baseUrl).hostname) return originalFetch(input, init);
  const start = performance.now();
  const response = await originalFetch(input, init);
  const entry: Record<string, unknown> = { stage: stageName, httpStatus: response.status };
  calls.push(entry);
  if (response.ok) {
    const payload = await response.clone().json() as { model?: string; usage?: Record<string, unknown>; choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
    entry.seconds = Number(((performance.now() - start) / 1000).toFixed(2));
    entry.model = payload.model; entry.usage = payload.usage; entry.finishReason = payload.choices?.[0]?.finish_reason;
    const content = payload.choices?.[0]?.message?.content;
    if (content) writeFileSync(resolve(dir, `response-${calls.length}.txt`), clean(content));
  }
  return response;
};
let state: WorkspaceState = store.read();
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  if (completedStages.has(name)) return;
  stageName = name; console.log(JSON.stringify({ stage: name, status: 'running' }));
  const start = performance.now();
  try {
    await run();
    checks.push({ stage: name, seconds: Number(((performance.now() - start) / 1000).toFixed(2)), result: 'PASS' });
    console.log(JSON.stringify(checks.at(-1)));
    return;
  } catch (error) {
    const detail = clean(error instanceof Error ? error.message : 'Unknown failure');
    checks.push({ stage: name, seconds: Number(((performance.now() - start) / 1000).toFixed(2)), result: 'FAIL', detail });
    throw error;
  }
}
async function act(action: Action) {
  state = await workflow.act({ ...action, expectedRevision: state.revision });
  return state;
}
const experienceA = '2025年3月至6月，我参与隐私政策课程研究，检索公开资料，对比三家虚构平台的条款，并整理研究表格。';
const experienceB = '2025年9月至12月，我参与校园模拟法庭，负责证据资料检索和论证初稿，最终与团队完成课堂展示。';
const limitation = '我会使用Excel整理资料，正在学习Python，尚未在真实业务中使用Python；没有企业合规实习经历，尚未通过法律职业资格考试。';
const text = `个人简历\n姓名：林澄\n邮箱：lincheng@example.com\n手机号：13800000000\n学校：示例大学\n学历：本科\n专业：法学\n毕业时间：2027年6月\n意向城市：上海\n到岗时间：每周4天，可连续实习3个月\n项目经历\n${experienceA}\n${experienceB}\n技能与补充\n${limitation}`;
let outcome = 'FAIL';
try {
  await step('DeepSeek 连接与 JSON 输出', async () => { const result = await probeModel(env); assert.ok(result.latencyMs >= 0); });
  await step('基础简历导入与字段对应', async () => {
    state = await workflow.importResume({ name: '虚构测试简历.txt', mimeType: 'text/plain', buffer: Buffer.from(text) }, state.revision);
    assert.equal(state.profile.name, '');
    assert.equal(state.resumeImport?.proposedProfile.major, '法学');
    assert.ok(state.resumeImport!.proposedProfile.experienceText.includes('模拟法庭'), '导入不能丢失第二段经历');
    assert.ok(state.resumeImport!.proposedProfile.experienceText.includes('尚未通过'), '导入不能丢失资格限制');
  });
  await step('经历提取与来源校验', async () => {
    await act({ type: 'accept_resume_import', profile: state.resumeImport!.proposedProfile });
    assert.ok(state.profile.facts.length >= 2);
    assert.ok(state.profile.facts.some(fact => fact.text.includes('模拟法庭')));
    assert.ok(state.profile.facts.every(fact => !fact.confirmed && state.profile.experienceText.includes(fact.source)));
    for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  });
  await step('职业探索：尚未确定岗位', async () => {
    await act({ type: 'career_chat', message: '我读法学，但还不知道能做什么。我喜欢研究、资料分析和写作，不想只考虑律师，请帮助我比较行业和岗位。' });
    assert.ok(state.exploration!.directions.length >= 2);
    assert.ok(state.exploration!.directions.every(direction => direction.industry !== direction.role));
  });
  await step('职业探索：承接偏好并跨行业比较', async () => {
    await act({ type: 'career_chat', message: '我暂不考虑律师事务所和金融业。城市优先上海或杭州，更看重成长，希望重点比较互联网的数据隐私合规和出海制造业的产品合规。' });
    const directions = state.exploration!.directions;
    assert.ok(directions.some(d => /互联网|数字|科技/.test(d.industry)), '应回应互联网行业偏好');
    assert.ok(directions.some(d => /制造|出海/.test(d.industry)), '应回应出海制造业偏好');
    const selected = directions.filter(d => /互联网|数字|科技|制造|出海/.test(d.industry)).slice(0, 4);
    await act({ type: 'select_directions', directionIds: selected.map(d => d.id) });
  });
  await step('候选公司清单', async () => {
    await act({ type: 'recommend_companies' });
    assert.ok(state.exploration!.companies.length >= 1);
    assert.ok(state.exploration!.companies.every(company => !company.selected && company.hiringStatus === 'unverified' && company.careerUrl.startsWith('https://')));
    await act({ type: 'select_companies', companyIds: [state.exploration!.companies[0].id] });
  });
  await step('岗位分析与完整简历生成', async () => {
    await act({ type: 'activate_company', companyId: state.exploration!.companies.find(company => company.selected)!.id });
    const resume = state.resumes.at(-1)!;
    assert.equal(resume.generation?.mode, 'live'); assert.equal(resume.approved, false);
    assert.ok(resume.document!.sections.length > 0);
    assert.ok(resume.document!.sections.flatMap(section => section.items).every(item => item.factIds.length > 0));
    assert.ok(!JSON.stringify(resume.document).includes(state.profile.phone));
    assert.ok(!JSON.stringify(resume.document).includes(state.profile.email));
  });
  await step('自然语言修改与版本保留', async () => {
    const previous = structuredClone(state.resumes.at(-1)!);
    const requestedSummary = '关注数据隐私合规，参与过课程研究、公开资料检索与条款对比。';
    await act({ type: 'chat_resume_edit', resumeId: previous.id, message: `换成经典版式和海军蓝配色，将个人简介完整替换为“${requestedSummary}”，保留研究与资料检索的具体工作。不得新增经历、数字、资格，也不要把正在学习Python改成已经熟练掌握。` });
    const edited = state.resumes.at(-1)!;
    assert.equal(edited.parentId, previous.id); assert.equal(edited.approved, false);
    assert.equal(edited.document!.theme, 'classic'); assert.equal(edited.document!.accent, 'navy');
    assert.equal(edited.document!.summary, requestedSummary, '自然语言编辑必须实际修改所指定的正文');
    assert.notEqual(edited.document!.summary, previous.document!.summary);
    assert.deepEqual(state.resumes.find(resume => resume.id === previous.id)!.document, previous.document);
  });
  await step('面试开场', async () => {
    const resume = state.resumes.at(-1)!;
    await act({ type: 'approve_resume', resumeId: resume.id });
    await act({ type: 'start_interview', resumeId: resume.id });
    assert.ok(state.interview!.messages[0].content.length > 30);
  });
  await step('面试反馈与追问', async () => {
    await act({ type: 'answer_interview', answer: '在隐私政策课程研究中，我先按数据类型和使用目的整理条款，再把差异放进表格。我主要负责公开资料检索和对比表，不是项目负责人。结果是完成课程研究材料，没有可证明业务效果的数字。' });
    assert.equal(state.interview!.messages.length, 3);
    assert.notEqual(state.interview!.messages[2].content, state.interview!.messages[0].content);
  });
  await step('PDF 导出', async () => {
    const pdf = await renderResumePdf(state.resumes.at(-1)!);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    writeFileSync(resolve(dir, 'sample-resume.pdf'), pdf);
  });
  outcome = 'PASS';
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', stage: stageName, error: clean(error instanceof Error ? error.message : 'Unknown failure') }));
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await closeBrowser(); store.close();
  const after = await (await fetch(base + '/api/state')).json();
  const report = { result: outcome, testedAt: new Date().toISOString(), model: publicSettings.model, provider: publicSettings.provider, syntheticDataOnly: true, resumedFrom: resumeDirectory, realApplicationsSubmitted: 0, userWorkspaceUnchanged: digest(after) === beforeDigest, checks, calls, totalTokens: calls.reduce((sum, call) => sum + Number((call.usage as { total_tokens?: number } | undefined)?.total_tokens || 0), 0) };
  writeFileSync(resolve(dir, 'report.json'), clean(JSON.stringify(report, null, 2)));
  writeFileSync(resolve(dir, 'synthetic-workspace.json'), clean(JSON.stringify(state, null, 2)));
  console.log(JSON.stringify({ result: outcome, model: publicSettings.model, checks: checks.length, apiCalls: calls.length, totalTokens: report.totalTokens, userWorkspaceUnchanged: report.userWorkspaceUnchanged, artifacts: dir }));
}
