import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Locator } from 'playwright';
import { Store } from '../server/store.ts';
import type { Action, CompanyCandidate, WorkspaceState } from '../shared/types.ts';

const root = process.cwd();
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'swipe-e2e-'));
const store = new Store(resolve(dir, 'zhihang.sqlite'));
const seeded = store.read();
seeded.profile = { ...seeded.profile, name: '合成测试同学', school: '示例大学', education: '本科', major: '法学', city: '上海', graduation: '2027年6月', experienceText: '在课程中检索隐私政策资料，使用 Excel 整理对比表。', facts: [{ id: 'synthetic-fact', text: '在课程中检索隐私政策资料，使用 Excel 整理对比表。', source: '合成测试资料', confirmed: true }] };
const jd = (city: string) => `城市专属要求：${city}政策研究。\n岗位职责：检索公开隐私政策资料，使用 Excel 整理对比表。\n${Array.from({ length: 24 }, (_, index) => `任职要求 ${index + 1}：在校学生，能够清楚记录研究过程，具备团队协作意识。`).join('\n')}\n完整 JD 末尾验证。`;
const candidates: CompanyCandidate[] = ['上海', '杭州', '深圳'].map((city, index) => ({ id: `synthetic-city-${index}`, companyId: 'synthetic-company', name: '合成公司', industry: '互联网', role: '数据合规实习生', rationale: '研究与资料整理经历可以迁移至该岗位，资格要求仍需核对。', requirements: ['法学相关专业', '政策资料检索'], careerUrl: `https://example.com/careers/${index}`, sourceKind: 'official_job', jdComplete: true, sourceLabel: '合成官网数据', checkedAt: '2024-05-06T10:00:00Z', hiringStatus: 'listed', selected: false, location: city, jobDescription: jd(city), jobType: '实习', sourceJobId: `job-${index}` }));
seeded.exploration = { messages: [], directions: [{ id: 'direction-1', industry: '互联网', role: '数据合规', rationale: '合成方向', transferableSkills: ['政策资料检索'], gaps: [], entryRequirements: '以真实 JD 为准', salaryContext: '未披露' }], selectedDirectionIds: ['direction-1'], companies: candidates, stage: 'companies', swipeHistory: [] };
store.save(seeded, seeded.revision); store.close();
const port = await new Promise<number>(resolvePort => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const available = (socket.address() as { port: number }).port; socket.close(() => resolvePort(available)); }); });
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
let serverOutput = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false' } });
child.stdout?.on('data', data => { serverOutput += data.toString(); });
child.stderr?.on('data', data => { serverOutput += data.toString(); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
let state: WorkspaceState;
const checks: string[] = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) { if (child.exitCode !== null) throw new Error(serverOutput); try { if ((await fetch(`${base}/api/status`)).ok) { ready = true; break; } } catch {} await sleep(250); }
  assert.ok(ready, serverOutput);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).mode, 'demo');
  const read = async () => await (await fetch(`${base}/api/state`)).json() as WorkspaceState;
  state = await read();
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
  const errors: string[] = [], requests: Action[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/actions') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.goto(base, { waitUntil: 'networkidle' });
  const goJobs = async () => { await page!.getByRole('button', { name: /方向与公司/ }).first().click(); await page!.getByTestId('job-discovery').waitFor(); };
  await goJobs();
  async function action(type: Action['type'], trigger: () => Promise<unknown>, expectedStatus = 200) {
    const pending = page!.waitForResponse(response => response.url().endsWith('/api/actions') && response.request().postDataJSON()?.type === type);
    await trigger();
    const response = await pending;
    const data = await response.json();
    assert.equal(response.status(), expectedStatus, JSON.stringify(data));
    if (response.ok()) state = data;
    await page!.waitForFunction(() => !document.querySelector('.busy-indicator'));
    return data;
  }
  const card = () => page!.getByTestId('job-swipe-card');
  const currentId = async () => await card().getAttribute('data-candidate-id');
  const like = () => action('swipe_company', () => page!.getByTestId('swipe-like').click());
  const boxOf = async (locator: Locator) => { await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox(); assert.ok(box); return box; };
  async function dragCard(horizontal: number) {
    const box = await boxOf(card());
    const x = box.x + box.width / 2, y = box.y + 90;
    await page!.mouse.move(x, y); await page!.mouse.down(); await page!.mouse.move(x + horizontal, y + 3, { steps: 12 }); await page!.mouse.up();
  }
  const overflow = async () => assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Horizontal overflow');
  await card().scrollIntoViewIfNeeded();
  await overflow();
  await page.screenshot({ path: resolve(dir, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await overflow();
  await card().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(dir, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  checks.push('desktop and mobile screenshot / no horizontal overflow');

  // Reading a long JD must never cast a preference vote.
  const beforeRead = requests.length;
  const jdBox = await boxOf(page.getByLabel('岗位描述，可滚动阅读'));
  await page.mouse.move(jdBox.x + jdBox.width / 2, jdBox.y + 25); await page.mouse.wheel(0, 180);
  await page.waitForFunction(() => (document.querySelector('.opportunity-jd-scroll')?.scrollTop || 0) > 0);
  await page.mouse.down(); await page.mouse.move(jdBox.x + jdBox.width / 2 + 3, jdBox.y + 110, { steps: 8 }); await page.mouse.up();
  assert.equal(requests.length, beforeRead); assert.equal(await currentId(), candidates[0].id);
  const message = page.getByLabel('方向探索消息');
  await message.fill('输入框里的方向键只移动光标'); await message.press('ArrowRight'); await message.press('ArrowLeft');
  assert.equal(requests.length, beforeRead); await message.fill('');
  checks.push('vertical JD scrolling / dragging and input arrows do not swipe');

  await action('swipe_company', () => dragCard(145));
  assert.equal(state.exploration!.companies[0].decision, 'like'); assert.equal(await currentId(), candidates[1].id);
  await action('swipe_company', () => dragCard(-145));
  assert.equal(state.exploration!.companies[1].decision, 'dislike');
  await action('undo_company_swipe', () => page!.getByTestId('undo-swipe').click());
  assert.equal(await currentId(), candidates[1].id); assert.equal(state.exploration!.companies[1].decision, undefined);
  await card().focus(); await action('swipe_company', () => card().press('ArrowRight'));
  assert.equal(state.exploration!.companies[1].decision, 'like'); assert.equal(await currentId(), candidates[2].id);
  checks.push('real mouse right / left swipe, undo restores card, focused-card keyboard selection');

  let failNext = true;
  await page.route('**/api/actions', async route => { if (failNext && route.request().postDataJSON()?.type === 'swipe_company') { failNext = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '合成失败：请重试' }) }); } else await route.continue(); });
  const revisionBeforeFailure = state.revision;
  await action('swipe_company', () => page!.getByTestId('swipe-like').click(), 500);
  assert.equal(await currentId(), candidates[2].id); assert.equal((await read()).revision, revisionBeforeFailure);
  assert.match(await page.getByRole('alert').textContent() || '', /合成失败/);
  await page.unroute('**/api/actions');
  const requestCount = requests.length;
  await action('swipe_company', () => page!.getByTestId('swipe-like').evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); }));
  assert.equal(requests.length, requestCount + 1); assert.equal(state.revision, revisionBeforeFailure + 1);
  assert.equal(state.exploration!.companies.filter(company => company.selected).length, 3);
  await page.getByTestId('discovery-complete').waitFor();
  checks.push('HTTP 500 preserves card and revision / same-tick double action is sent once');

  await page.reload({ waitUntil: 'networkidle' }); await goJobs();
  assert.equal(await page.getByTestId('liked-job').count(), 3);
  for (const company of candidates) await action('swipe_company', () => page!.getByRole('button', { name: `移除 ${company.name} · ${company.role}`, exact: true }).first().click());
  assert.equal(state.exploration!.companies.filter(company => company.selected).length, 0);
  assert.equal(await page.getByTestId('liked-job').count(), 0);
  await page.getByTestId('review-skipped').click();
  assert.equal(await currentId(), candidates[0].id);
  await like();
  assert.equal(state.exploration!.companies.filter(company => company.selected).length, 1);
  await page.getByRole('button', { name: '结束回看', exact: true }).click();
  checks.push('persisted likes survive reload / empty shortlist can revisit skipped cards');

  await action('refresh_jobs', () => page!.getByTestId('refresh-jobs').click());
  const retained = state.exploration!.companies.find(company => company.id === candidates[0].id)!;
  assert.equal(retained.selected, true); assert.equal(retained.hiringStatus, 'unverified'); assert.equal(retained.jobDescription, candidates[0].jobDescription);
  // Attribute selection also distinguishes equal company and role names across cities.
  const likedRow = page.locator(`[data-testid="liked-job"][data-candidate-id="${candidates[0].id}"]`);
  await likedRow.getByRole('button', { name: '回看', exact: true }).click();
  assert.equal(await currentId(), candidates[0].id);
  assert.match(await card().textContent() || '', /待重新核验 · 历史职位/);
  assert.match(await card().textContent() || '', /2024年5月6日/);
  assert.match(await card().textContent() || '', /城市专属要求：上海政策研究/);
  await page.screenshot({ path: resolve(dir, 'history-and-shortlist.png'), fullPage: true });
  await action('open_company', () => likedRow.getByTestId('prepare-liked-resume').click());
  await page.getByTestId('resume-preparation').waitFor();
  assert.equal(state.resumes.length, 0, 'Opening a workspace does not depend on a model generation');
  await page.getByRole('button', { name: '生成岗位简历', exact: true }).click();
  await page.getByLabel('简历版本', { exact: true }).waitFor();
  state = await read();
  const resume = state.resumes.find(item => item.id === state.activeResumeId)!;
  assert.equal(resume.job.candidateId, candidates[0].id); assert.equal(resume.job.sourceKind, 'official_job');
  assert.match(resume.job.text, /城市专属要求：上海政策研究/); assert.doesNotMatch(resume.job.text, /城市专属要求：杭州政策研究/);
  assert.ok(resume.document); assert.deepEqual(errors, []);
  checks.push('refresh retains likes and historical JD / matching city-specific JD generates resume');
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', checks, apiRequests: requests.length }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', checks, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(dir, 'server.log'), serverOutput); throw error;
} finally {
  await browser?.close();
  if (child.connected) child.send('shutdown');
  for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await sleep(250);
  if (child.exitCode === null) child.kill();
}
