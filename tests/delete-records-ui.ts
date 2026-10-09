import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { Store, emptyProfile } from '../server/store.ts';
import { Workflow } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { actionSchema } from '../server/validation.ts';
import { agentAnalysisFixture } from './fixtures/agent-analysis.ts';
import type { ResumeVersion } from '../shared/types.ts';

// Actual Workflow with an in-memory synthetic store. No production API or model calls.
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'delete-records-ui-'));
const store = new Store(':memory:'), initial = agentAnalysisFixture(), historyProfile = structuredClone(initial.profile);
initial.profile = emptyProfile(); initial.analysis = null; initial.factPreview = null;
initial.job = { company: '北京合成招聘公司', title: '顾问实习生', text: '合成招聘要求：整理客户需求，提供资料支持。', url: '', sourceKind: 'user_jd', jdComplete: true };
const makeResume = (id: string, version: number): ResumeVersion => ({ id, version, createdAt: '2026-10-07T07:00:00Z', profile: structuredClone(historyProfile), job: { ...initial.job, company: '历史合成公司' }, bullets: [{ text: historyProfile.facts[0].text, factIds: [historyProfile.facts[0].id] }], rationale: '合成简历', approved: true, stale: true });
initial.resumes = [makeResume('11111111-1111-4111-8111-111111111111', 1), makeResume('22222222-2222-4222-8222-222222222222', 2)]; initial.activeResumeId = null;
initial.applications = [{ id: '33333333-3333-4333-8333-333333333333', resumeId: '11111111-1111-4111-8111-111111111111', company: '历史合成公司', jobTitle: '顾问实习生', status: 'confirmed', receipt: 'DEMO-SYNTHETIC', createdAt: '2026-10-07T07:00:00Z', updatedAt: '2026-10-07T07:00:00Z', simulated: true }];
initial.exploration = { messages: [], directions: [], selectedDirectionIds: [], companies: [{ id: 'source-card', name: initial.job.company, industry: '服务业', role: initial.job.title, careerUrl: 'https://example.com/synthetic', rationale: '', requirements: [], sourceLabel: '合成来源', checkedAt: '2026-10-07', hiringStatus: 'unverified', selected: true, decision: 'like' }], stage: 'companies' };
store.save(initial, 0);
const workflow = new Workflow(store, createModelEngine({}), { fill: async () => ({ evidence: '' }), submit: async () => ({ receipt: '', evidence: '' }) });
const status = { mode: 'demo', model: 'synthetic-only', modelConfigured: false, browserAvailable: false, version: 'delete-ui-test' };
const writes: string[] = [], errors: string[] = [], screenshots: string[] = [], failures = new Set(['clear_job', 'delete_application', 'delete_resume']);
let hold: Promise<void> | undefined, release: (() => void) | undefined;
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, plugins: [{ name: 'synthetic-api', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    const path = (req.url || '').split('?')[0]; if (!path.startsWith('/api/')) { next(); return; }
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && path === '/api/state') { res.end(JSON.stringify(store.read())); return; }
      if (req.method === 'GET' && path === '/api/status') { res.end(JSON.stringify(status)); return; }
      if (req.method === 'POST' && path === '/api/actions') {
        let body = ''; for await (const part of req) body += part;
        const action = actionSchema.parse(JSON.parse(body)); writes.push(action.type);
        assert.ok(['clear_job', 'delete_application', 'delete_resume'].includes(action.type));
        if (hold) await hold;
        if (failures.delete(action.type)) {
          if (action.type === 'delete_resume') { const current = store.read(); store.save(current, current.revision); }
          throw Object.assign(new Error(action.type === 'delete_resume' ? '合成关联冲突：请先删除对应投递记录。' : '合成暂时失败，现有资料保持不变。'), { status: action.type === 'delete_resume' ? 409 : 500 });
        }
        res.end(JSON.stringify(await workflow.act(action))); return;
      }
      throw new Error(`Unexpected synthetic API ${req.method} ${path}`);
    } catch (error) { res.statusCode = (error as { status?: number }).status || 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic failure' })); }
  });
} }] });
await server.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0], { waitUntil: 'networkidle' });
  const go = (name: string) => page!.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  const button = (name: string) => page!.getByRole('button', { name, exact: true });
  const dialog = (name: string) => page!.getByRole('alertdialog', { name });
  async function screenshot(name: string, selector: string) {
    for (const width of [1440, 390]) {
      await page!.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} overflow at ${width}`);
      const path = resolve(dir, `${name}-${width}.png`); await page!.locator(selector).screenshot({ path, style: '.sidebar { visibility: hidden!important; }' }); screenshots.push(path);
    }
  }
  console.log('Checking zero-fact target removal and local draft preservation');
  await go('岗位简历'); await page.getByTestId('resume-preparation').waitFor();
  assert.equal(await button('移除当前岗位').isEnabled(), true); assert.equal(await button('生成岗位简历').isDisabled(), true);
  await page.getByLabel('打开历史简历', { exact: true }).selectOption('11111111-1111-4111-8111-111111111111');
  assert.equal(await button('移除当前岗位').count(), 1); await button('移除当前岗位').click();
  assert.match(await dialog('移除当前岗位？').innerText(), /北京合成招聘公司/); assert.doesNotMatch(await dialog('移除当前岗位？').innerText(), /历史合成公司/);
  await dialog('移除当前岗位？').getByRole('button', { name: '取消', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' }); await go('岗位简历');
  await page.locator('.resume-preparation-jd>summary').click();
  const jd = page.getByLabel('简历工作区岗位 JD', { exact: true }); await jd.fill('尚未保存的合成 JD 变更');
  assert.equal(await button('移除当前岗位').isDisabled(), true); await jd.fill(initial.job.text);
  await button('移除当前岗位').click(); await dialog('移除当前岗位？').getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual(writes, []);
  await button('移除当前岗位').click(); await screenshot('remove-target', '.current-job-controls');
  const before = store.read(); hold = new Promise<void>(done => { release = done; });
  await button('确认移除岗位').click(); await page.locator('.busy-indicator').waitFor(); assert.equal(await button('确认移除岗位').isDisabled(), true);
  await jd.fill('请求期间输入的新草稿应保留'); release!(); hold = undefined;
  await page.getByRole('alert').filter({ hasText: '合成暂时失败' }).waitFor(); assert.deepEqual(store.read(), before); assert.equal(await jd.inputValue(), '请求期间输入的新草稿应保留');
  await jd.fill(initial.job.text); await button('确认移除岗位').click(); await page.getByTestId('resume-preparation').waitFor({ state: 'detached' });
  assert.equal(store.read().job.company, ''); assert.equal(store.read().exploration!.companies[0].decision, 'like'); assert.deepEqual(store.read().resumes, before.resumes);
  await page.reload({ waitUntil: 'networkidle' }); await go('岗位简历');
  assert.equal(await page.getByTestId('resume-preparation').count(), 0); assert.equal(await page.getByLabel('简历版本', { exact: true }).count(), 0);
  assert.ok(await page.getByLabel('打开历史简历', { exact: true }).isVisible());
  await go('面试练习'); const interviewSelect = page.locator('.review-card select'); assert.equal(await interviewSelect.inputValue(), ''); assert.match(await interviewSelect.locator('option:checked').innerText(), /请选择简历版本/);
  await interviewSelect.selectOption('11111111-1111-4111-8111-111111111111'); assert.equal(await button('开始面试练习').isEnabled(), true);
  await page.reload({ waitUntil: 'networkidle' }); await go('岗位简历'); await page.getByLabel('打开历史简历', { exact: true }).selectOption('11111111-1111-4111-8111-111111111111');

  console.log('Checking referenced-resume guidance and verified application deletion');
  await button('删除此版本').click(); const linked = dialog('删除简历 V1？'); assert.match(await linked.innerText(), /仍关联 1 条模拟投递记录/); assert.equal(await button('确认删除此版本').count(), 0);
  await button('前往投递记录').click(); assert.match(await page.locator('.application-card').innerText(), /已核验提交/);
  await button('删除记录').click(); await dialog('删除这条模拟投递记录？').getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual(writes, ['clear_job', 'clear_job']);
  await button('删除记录').click(); await screenshot('delete-application', '.application-card'); const beforeApplication = store.read();
  await button('确认删除记录').click(); await page.getByRole('alert').filter({ hasText: '合成暂时失败' }).waitFor(); assert.deepEqual(store.read(), beforeApplication);
  await button('确认删除记录').click(); await page.locator('.application-card').waitFor({ state: 'detached' }); assert.equal(store.read().applications.length, 0); assert.equal(store.read().resumes.length, 2);
  await go('岗位简历'); await button('删除此版本').click(); await screenshot('delete-resume', '.record-delete-confirm');
  await dialog('删除简历 V1？').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(store.read().resumes.length, 2);
  await button('删除此版本').click(); await button('确认删除此版本').click();
  await page.getByRole('alert').filter({ hasText: '合成关联冲突：请先删除对应投递记录。' }).waitFor(); assert.equal(store.read().resumes.length, 2);
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /其他页面发生变化/);
  await button('确认删除此版本').click(); await page.getByLabel('简历版本', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(store.read().resumes.length, 1); assert.equal(store.read().resumes[0].id, '22222222-2222-4222-8222-222222222222'); assert.equal(store.read().job.company, '');
  assert.equal(await page.getByLabel('打开历史简历', { exact: true }).inputValue(), '');
  await page.getByLabel('打开历史简历', { exact: true }).selectOption('22222222-2222-4222-8222-222222222222'); assert.equal(await page.getByLabel('简历版本', { exact: true }).inputValue(), '22222222-2222-4222-8222-222222222222');
  await page.reload({ waitUntil: 'networkidle' }); await go('面试练习');
  assert.equal(await interviewSelect.inputValue(), ''); assert.equal(await interviewSelect.locator('option').count(), 2);
  await interviewSelect.selectOption('22222222-2222-4222-8222-222222222222'); assert.equal(await button('开始面试练习').isEnabled(), true);
  assert.deepEqual(errors, []); assert.deepEqual(writes, ['clear_job', 'clear_job', 'delete_application', 'delete_application', 'delete_resume', 'delete_resume']);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', isolation: 'actual Workflow with in-memory synthetic data, temporary Vite, real Edge; no production writes', checks: ['zero-fact current job can be removed', 'current job removal is available while viewing a different historical resume and labels the actual target', 'unsaved JD blocks removal', 'failure retains edits typed during request', 'clear job stays empty after reload and preserves source likes/history', 'explicit history selection only', 'interview has empty placeholder and explicit choice works with multiple and single versions', 'referenced resume directs to application record first', 'verified application can be deleted', 'cancel makes no request', '409 shows actual reason and retry uses refreshed revision', 'single resume removal preserves other history', 'busy protection and no horizontal overflow at 1440/390px'], screenshots, writes }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', output: dir, screenshots }, null, 2));
} catch (error) { console.log(JSON.stringify({ errors, url: page?.url() })); if (page) { await page.screenshot({ path: resolve(dir, 'failure.png') }); console.log((await page.locator('body').innerText()).slice(0, 2400)); } throw error; }
finally { release?.(); await browser?.close(); await server.close(); store.close(); }
