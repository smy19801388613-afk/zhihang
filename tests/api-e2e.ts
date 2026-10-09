import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { Action, WorkspaceState } from '../shared/types.ts';
import { createExperienceAgentFixture } from '../server/experience-agent.ts';
import { createJobAgentFixture } from '../server/job-analysis-agent.ts';
import type { ModelSettingsPublic } from '../shared/model-config.ts';

// A local HTTP provider exercises the actual client and UI without spending API
// credits or sending personal data. This is not a DeepSeek service acceptance test.
const root = process.cwd();
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'api-e2e-'));
const secret = 'synthetic-key-for-local-contract-test';
const experience = '我在课程研究中检索隐私政策公开资料，并整理对比表。';
const polished = '围绕隐私政策开展课程研究，梳理公开资料并形成对比表。';
const requests: Array<{ body: any; authorization: string | undefined }> = [];
let upstreamFailure = 0;
let holdCareer = false;
let releaseCareer: (() => void) | undefined;
let signalCareer: (() => void) | undefined;
const provider = httpServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, authorization: req.headers.authorization });
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (upstreamFailure) { res.writeHead(upstreamFailure).end(`private diagnostic ${secret}`); return; }
    const instruction = body.messages[0].content as string;
    const input = JSON.parse(body.messages[1].content);
    const data = input.data ?? input;
    let output: unknown;
    if (data.conversationPlan && Array.isArray(data.currentDirections)) {
      if (holdCareer) { signalCareer?.(); await new Promise<void>(done => { releaseCareer = done; }); }
      output = { message: '可以先比较互联网隐私合规与出海制造产品合规。你更喜欢哪类工作内容？', directions: [
        { id: 'law-internet', industry: '互联网与数字服务', role: '数据隐私与业务合规', rationale: '课程研究提供资料整理的初步证据，需要继续核对实际职责。', transferableSkills: ['资料研究'], gaps: ['尚无企业实习'], entryRequirements: '以具体招聘职位为准。', salaryContext: '行业、岗位、地区、职级和经验共同影响薪资。' },
        { id: 'law-manufacturing', industry: '出海制造业', role: '产品合规与海外业务合规', rationale: '可进一步了解产品规范研究。', transferableSkills: ['检索与写作'], gaps: ['产品标准知识'], entryRequirements: '需要逐岗核验。', salaryContext: '需要以具体招聘信息比较。' },
      ] };
    } else if (instruction.includes('候选池')) {
      output = { candidates: data.pool.slice(0, 2).map((candidate: any) => ({ id: candidate.id, rationale: '可从该公司的官方招聘入口核查合规方向职位，目前未核实在招。' })) };
    } else if (instruction.includes('从简历原文补充')) {
      output = { fields: { major: '法学', experienceText: experience }, warnings: [] };
    } else if (data.agentTask === 'job_analysis') {
      output = createJobAgentFixture(data);
    } else if (data.agentTask === 'experience') {
      output = createExperienceAgentFixture(data);
    } else if (instruction.includes('根据编辑指令修改简历')) {
      output = { document: { ...data.document, theme: 'classic', summary: '具备隐私政策课程研究与公开资料整理经历。' }, message: '已调整为经典版式并精简简介，请核对表述。', reviewNotes: ['请核实改写后的表述。'] };
    } else if (instruction.includes('模拟面试')) {
      output = { message: '模拟面试：请介绍隐私政策课程研究中你如何筛选资料，并说明你独立完成了什么。' };
    } else if (instruction.includes('简历') && (data.facts || data.profile?.facts)) {
      const facts = data.facts || data.profile.facts;
      output = { document: { headline: data.job.title, summary: '具备隐私政策研究和资料整理经历。', theme: 'modern', accent: 'forest', sections: [{ id: 'projects', title: '项目经历', items: [{ id: 'privacy-study', title: '隐私政策课程研究', subtitle: '', date: '', content: polished, factIds: [facts[0].id] }] }] }, rationale: '围绕岗位方向组织已确认的课程经历。', reviewNotes: ['请核实改写是否准确。'] };
    } else {
      output = { ok: true };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  } catch (error) { res.writeHead(500).end(error instanceof Error ? error.message : 'fixture failed'); }
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
const port = await new Promise<number>(done => { const server = netServer(); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)); }); });
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
let child: ChildProcess | undefined;
let output = '';
let browser: Browser | undefined;
let page: Page | undefined;
let state: WorkspaceState;
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_JSON_MODE: '', MODEL_TIMEOUT_MS: '', JOB_DISCOVERY_ENABLED: 'false' } });
  child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/api/status`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('API test server did not start.');
}
async function stop() {
  if (child?.connected) child.send('shutdown');
  for (let i = 0; i < 20 && child?.exitCode === null; i++) await sleep(250);
  if (child?.exitCode === null) child.kill();
}
async function json(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, body: await response.json() };
}
async function act(action: Action) {
  const result = await json('/api/actions', 'POST', { ...action, expectedRevision: state.revision });
  assert.ok(result.response.ok, JSON.stringify(result.body));
  state = result.body;
  return state;
}
try {
  await start();
  state = (await json('/api/state')).body;
  const initial = (await json('/api/model-settings')).body as ModelSettingsPublic;
  assert.equal(initial.mode, 'demo'); assert.equal(initial.hasApiKey, false);
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /模型设置/ }).first().click();
  await page.getByLabel('模型服务商', { exact: true }).selectOption('custom');
  await page.getByLabel('API 基础地址', { exact: true }).fill(providerBase);
  await page.getByLabel('模型名称', { exact: true }).fill('local-http-contract-model');
  await page.getByLabel('API Key', { exact: true }).fill(secret);
  const enable = page.waitForResponse(r => r.url().endsWith('/api/model-settings') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: '验证并启用', exact: true }).click();
  const enabled = await enable; assert.equal(enabled.status(), 200, await enabled.text());
  let settings = await enabled.json() as ModelSettingsPublic;
  assert.equal(settings.mode, 'live'); assert.ok(settings.lastTest); assert.equal(settings.hasApiKey, true);
  await page.waitForFunction(() => (document.querySelector('input[aria-label="API Key"]') as HTMLInputElement | null)?.value === '');
  assert.equal((await json('/api/status')).body.mode, 'live');
  assert.equal((await json('/api/state')).body.revision, state.revision, 'API settings must not mutate profile or resume history');
  assert.ok(!JSON.stringify(settings).includes(secret));
  assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })).then(text => text.includes(secret)), false);
  await page.screenshot({ path: resolve(dir, 'model-settings.png'), fullPage: true });
  const config = () => ({ expectedRevision: settings.revision, provider: 'custom', baseUrl: providerBase, model: 'local-http-contract-model', jsonMode: true, timeoutMs: 90000 });
  const count = requests.length;
  assert.equal((await json('/api/model-settings', 'PUT', { ...config(), expectedRevision: settings.revision - 1, apiKey: secret })).response.status, 409);
  assert.equal(requests.length, count, 'Stale setting must not cause a paid request');
  assert.equal((await json('/api/model-settings/test', 'POST', { ...config(), baseUrl: 'https://different.example/v1' })).response.status, 400);
  upstreamFailure = 401;
  const failed = await json('/api/model-settings', 'PUT', { ...config(), apiKey: secret });
  assert.ok(!failed.response.ok); assert.ok(!JSON.stringify(failed.body).includes(secret));
  assert.equal((await json('/api/model-settings')).body.revision, settings.revision);
  assert.equal((await json('/api/status')).body.mode, 'live');
  upstreamFailure = 0;
  const sameKey = await json('/api/model-settings/test', 'POST', config());
  assert.equal(sameKey.response.status, 200);
  const profile = { name: '林禾', email: 'linhe@example.com', phone: '13800000000', school: '示例大学', education: '本科', major: '法学', graduation: '2027年6月', city: '北京', availability: '每周四天，可实习三个月', targetRole: '', experienceText: experience };
  const form = new FormData();
  form.append('file', new Blob([`姓名：林禾\n邮箱：linhe@example.com\n手机号：13800000000\n学校：示例大学\n学历：本科\n专业：法学\n${experience}`], { type: 'text/plain' }), 'resume.txt');
  form.append('expectedRevision', String(state.revision));
  const imported = await fetch(`${base}/api/resume-import`, { method: 'POST', body: form });
  assert.ok(imported.ok); state = await imported.json();
  assert.equal(state.resumeImport?.proposedProfile.major, '法学');
  await act({ type: 'accept_resume_import', profile });
  assert.equal(state.profile.facts[0].source, experience, 'Source ID is resolved locally to the exact uploaded experience');
  assert.equal(state.profile.facts[0].confirmed, false);
  await act({ type: 'update_fact', factId: state.profile.facts[0].id, text: experience, confirmed: true });
  holdCareer = true;
  const careerStarted = new Promise<void>(done => { signalCareer = done; });
  const careerResult = act({ type: 'career_chat', message: '请比较互联网合规与出海制造业合规。' });
  await careerStarted;
  assert.equal((await json('/api/model-settings/disable', 'POST', { expectedRevision: settings.revision })).response.status, 409);
  releaseCareer!(); holdCareer = false;
  await careerResult;
  assert.equal(state.exploration?.directions.length, 2);
  await act({ type: 'select_directions', directionIds: [state.exploration!.directions[0].id] });
  await act({ type: 'recommend_companies' });
  const company = state.exploration!.companies[0];
  assert.equal(company.hiringStatus, 'unverified');
  await act({ type: 'select_companies', companyIds: [company.id] });
  await act({ type: 'open_company', companyId: company.id });
  assert.equal(state.job.text, '');
  await act({ type: 'save_job', job: { ...state.job, text: '岗位职责：检索隐私政策公开资料，并整理对比表。任职要求：法学本科在读。' } });
  await act({ type: 'analyze_job' });
  await act({ type: 'generate_resume' });
  const resume = state.resumes.at(-1)!;
  assert.equal(resume.generation?.mode, 'live'); assert.equal(resume.approved, false);
  assert.equal(resume.document?.sections[0].items[0].content, polished);
  assert.notEqual(resume.bullets[0].text, experience);
  assert.equal(state.profile.facts[0].text, experience, 'Model phrasing cannot rewrite confirmed source facts');
  await act({ type: 'chat_resume_edit', resumeId: resume.id, message: '换成经典版式，并精简简介。' });
  const edited = state.resumes.at(-1)!;
  assert.equal(edited.parentId, resume.id); assert.equal(edited.document?.theme, 'classic');
  await act({ type: 'approve_resume', resumeId: edited.id });
  await act({ type: 'start_interview', resumeId: edited.id });
  assert.match(state.interview!.messages[0].content, /隐私政策/);
  upstreamFailure = 429;
  const revisionBeforeFailure = state.revision;
  const errorResult = await json('/api/actions', 'POST', { type: 'answer_interview', answer: '我先检查了资料出处。', expectedRevision: state.revision });
  assert.ok(!errorResult.response.ok); assert.match(errorResult.body.error, /429/);
  assert.ok(!JSON.stringify(errorResult.body).includes(secret));
  assert.equal((await json('/api/state')).body.revision, revisionBeforeFailure, 'Provider failure must not save invented demo output');
  upstreamFailure = 0;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /岗位简历/ }).first().click();
  await page.screenshot({ path: resolve(dir, 'live-resume.png'), fullPage: true });
  assert.ok(requests.every(request => request.authorization === `Bearer ${secret}`));
  assert.ok(requests.every(request => !JSON.stringify(request.body).includes(secret)));
  assert.ok(requests.every(request => !JSON.stringify(request.body).includes(profile.email)));
  assert.ok(requests.every(request => !JSON.stringify(request.body).includes(profile.phone)));
  await stop(); await start();
  assert.equal((await json('/api/status')).body.mode, 'live');
  const restored = (await json('/api/state')).body;
  assert.deepEqual(restored.profile, state.profile); assert.equal(restored.resumes.at(-1).id, edited.id);
  settings = (await json('/api/model-settings')).body;
  const disabled = await json('/api/model-settings/disable', 'POST', { expectedRevision: settings.revision });
  assert.equal(disabled.response.status, 200); assert.equal(disabled.body.mode, 'demo');
  await stop(); await start();
  assert.equal((await json('/api/status')).body.mode, 'demo', 'Explicitly disabled mode must survive restart');
  if (process.platform === 'win32') {
    for (const filename of readdirSync(dir).filter(name => /model|config|setting/i.test(name))) {
      assert.ok(!readFileSync(resolve(dir, filename), 'utf8').includes(secret), 'Windows configuration may not store a clear-text key');
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', provider: 'local HTTP contract fixture, not external DeepSeek', checks: ['settings UI', 'key isolation', 'successful probe and hot switch', 'failed configuration preserves previous state', 'revision conflict before request', 'busy workflow blocks model change', 'real transport import/extraction/career/company/analysis/draft/edit/interview', 'grounded polished draft', 'provider failure never falls back', 'restart persistence and explicit disable'], artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(dir, 'server.log'), output);
  throw error;
} finally {
  releaseCareer?.();
  await browser?.close();
  await stop();
  provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
}
