import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { Store } from '../server/store.ts';
import { Workflow } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { actionSchema } from '../server/validation.ts';
import { agentAnalysisFixture } from './fixtures/agent-analysis.ts';
import type { ResumeVersion } from '../shared/types.ts';

// Only an in-memory synthetic workspace is exposed to this temporary Vite server.
// Requests never reach the user's running service or model configuration.
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'clear-input-ui-'));
const store = new Store(':memory:');
const initial = agentAnalysisFixture();
initial.exploration = { messages: [{ role: 'user', content: '合成偏好：喜欢资料研究' }], directions: [], selectedDirectionIds: [], companies: [{ id: 'kept-job', name: '合成保留公司', industry: '服务业', role: '合成岗位', rationale: '合成匹配理由', requirements: [], careerUrl: 'https://example.com/jobs/test', sourceLabel: '合成来源', checkedAt: '2026-10-07', hiringStatus: 'unverified', selected: true, decision: 'like' }], stage: 'companies' };
store.save(initial, 0);
const workflow = new Workflow(store, createModelEngine({}), { fill: async () => ({ evidence: '' }), submit: async () => ({ receipt: '', evidence: '' }) });
const status = { mode: 'demo', model: 'synthetic-only', modelConfigured: false, browserAvailable: false, version: 'clear-ui-test' };
const writes: string[] = [], errors: string[] = [], screenshots: string[] = [];
let failurePage: any;
let failDelete = true, holdDelete: Promise<void> | undefined, releaseDelete: (() => void) | undefined;
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
        assert.equal(action.type, 'clear_profile', 'Clear draft controls must not save or send text');
        if (failDelete) { failDelete = false; throw new Error('合成暂时失败，原档案仍保留'); }
        if (holdDelete) await holdDelete;
        res.end(JSON.stringify(await workflow.act(action))); return;
      }
      throw new Error(`Unexpected isolated API ${req.method} ${path}`);
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic failure' })); }
  });
} }] });
await server.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  failurePage = page; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0], { waitUntil: 'networkidle' });
  const go = (name: string) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  const input = (label: string) => page.getByLabel(label, { exact: true });
  const button = (label: string) => page.getByRole('button', { name: label, exact: true });
  async function clearUndo(label: string, content: string) {
    await input(label).fill(content);
    assert.equal(await button(`清空${label}`).getAttribute('type'), 'button');
    await button(`清空${label}`).click(); assert.equal(await input(label).inputValue(), '');
    await button(`撤销清空${label}`).click(); assert.equal(await input(label).inputValue(), content);
    await button(`清空${label}`).click(); await input(label).fill('继续输入的新内容');
    assert.equal(await button(`撤销清空${label}`).count(), 0, 'Editing must invalidate the earlier snapshot');
    await input(label).fill(''); assert.equal(await button(`撤销清空${label}`).count(), 0, 'Deleting the edit cannot resurrect old undo');
  }
  console.log('Checking profile draft controls');
  const saved = store.read();
  await button('清空本页个人资料输入').click();
  assert.equal(await input('姓名').inputValue(), ''); assert.equal(await input('个人经历').inputValue(), '');
  assert.equal(await button('梳理经历').isDisabled(), true);
  assert.deepEqual(store.read(), saved); assert.deepEqual(writes, []);
  await button('撤销清空本页个人资料输入').click(); assert.equal(await input('姓名').inputValue(), saved.profile.name);
  await button('清空本页个人资料输入').click(); await input('姓名').fill('新草稿姓名');
  assert.equal(await button('撤销清空本页个人资料输入').count(), 0);
  await page.reload({ waitUntil: 'networkidle' });
  await clearUndo('个人经历', saved.profile.experienceText); await input('个人经历').fill(saved.profile.experienceText);
  console.log('Checking direction and JD controls');
  await go('方向与公司'); await clearUndo('方向探索消息', '希望找研究岗位');
  await page.locator('.manual-job-details>summary').click();
  await clearUndo('手动岗位 JD', saved.job.text); assert.equal(await button('保存岗位').isDisabled(), true); await input('手动岗位 JD').fill(saved.job.text);
  await go('岗位简历'); await page.locator('.resume-preparation-jd>summary').click();
  await clearUndo('简历工作区岗位 JD', saved.job.text); assert.equal(await button('保存完整 JD').isDisabled(), true); await input('简历工作区岗位 JD').fill(saved.job.text);
  assert.deepEqual(writes, []); assert.deepEqual(store.read(), saved);

  console.log('Checking resume and interview controls');
  // Add a pre-existing synthetic resume and interview for the remaining inputs.
  const withResume = store.read();
  const resume: ResumeVersion = { id: 'synthetic-history', version: 1, createdAt: '2026-10-07T06:00:00Z', profile: structuredClone(withResume.profile), job: structuredClone(withResume.job), bullets: [{ text: withResume.profile.facts[0].text, factIds: [withResume.profile.facts[0].id] }], rationale: '合成演示简历', approved: true, stale: false };
  withResume.resumes = [resume]; withResume.activeResumeId = resume.id; withResume.interview = { resumeId: resume.id, messages: [{ role: 'assistant', content: '请介绍合成项目' }] };
  withResume.applications = [{ id: 'kept-application', resumeId: resume.id, company: resume.job.company, jobTitle: resume.job.title, status: 'prepared', createdAt: resume.createdAt, updatedAt: resume.createdAt, simulated: true }];
  store.save(withResume, withResume.revision); await page.reload({ waitUntil: 'networkidle' });
  await go('岗位简历'); await clearUndo('简历修改要求', '请精简措辞但保留事实');
  await go('面试练习'); await clearUndo('面试回答', '我负责整理资料和协调信息。');
  assert.deepEqual(writes, []);
  await go('我的经历'); await input('姓名').fill('尚未保存的姓名');
  await button('清空个人经历').click(); assert.equal(await button('撤销清空个人经历').count(), 1);
  await button('删除当前个人档案').click();
  const dialog = page.getByRole('alertdialog', { name: '删除已保存的当前个人档案？' });
  assert.match(await dialog.innerText(), /历史简历仍含原有个人信息/);
  await button('取消删除').click(); assert.equal(await dialog.count(), 0); assert.deepEqual(writes, []);
  await button('删除当前个人档案').click(); await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
  await button('删除当前个人档案').click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow at ${width}`);
    const path = resolve(dir, `confirm-${width}.png`); await page.locator('.profile-delete-section').screenshot({ path, style: '.sidebar { visibility: hidden!important; }' }); screenshots.push(path);
  }
  console.log('Checking delete failure and retry');
  const beforeDelete = store.read();
  await button('确认删除当前档案').click(); await page.getByRole('alert').filter({ hasText: '合成暂时失败' }).waitFor();
  assert.deepEqual(store.read(), beforeDelete); assert.equal(await input('姓名').inputValue(), '尚未保存的姓名'); assert.equal(await button('撤销清空个人经历').count(), 1); assert.ok(await dialog.isVisible());
  holdDelete = new Promise<void>(done => { releaseDelete = done; });
  await button('确认删除当前档案').click(); await page.locator('.busy-indicator').waitFor();
  assert.equal(await button('确认删除当前档案').isDisabled(), true); assert.equal(await button('清空个人经历').isDisabled(), true);
  releaseDelete!(); await dialog.waitFor({ state: 'detached' });
  const cleared = store.read();
  assert.equal(cleared.profile.name, ''); assert.deepEqual(cleared.profile.facts, []); assert.equal(cleared.interview, null);
  assert.equal(await input('姓名').inputValue(), ''); assert.equal(await input('个人经历').inputValue(), '');
  assert.equal(await button('撤销清空本页个人资料输入').count(), 0); assert.equal(await button('撤销清空个人经历').count(), 0); assert.equal(await page.locator('.draft-alert').count(), 0);
  assert.deepEqual(cleared.resumes[0].profile, resume.profile); assert.equal(cleared.resumes[0].stale, true); assert.equal(cleared.applications.length, 1);
  assert.equal(cleared.exploration!.companies[0].decision, 'like'); assert.deepEqual(cleared.job, beforeDelete.job);
  await button('查看保留的简历').click(); assert.equal(await page.getByLabel('简历版本', { exact: true }).inputValue(), resume.id);
  assert.equal(await button('已确认内容准确').isDisabled(), true); assert.equal(await button('准备模拟申请').isDisabled(), true);
  assert.deepEqual(writes, ['clear_profile', 'clear_profile']); assert.deepEqual(errors, []);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', isolation: 'in-memory synthetic store with actual Workflow, temporary Vite, real Edge; no production service or model calls', checks: ['all six long-text inputs clear and undo locally', 'whole profile form clear and undo', 'typing invalidates undo permanently', 'no draft clear sends API writes or submits forms', 'empty experience/JD submit disabled', 'delete cancel and Escape preserve saved and draft data', 'delete failure preserves state and inputs; retry succeeds', 'busy disables clear/delete', 'delete preserves resume snapshots/jobs/likes/applications', 'retained stale resume can be opened read-only', 'no stale undo after deletion', '1440/390px no horizontal overflow'], screenshots }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', output: dir, writes, screenshots }, null, 2));
} catch (error) { console.log(JSON.stringify({ browserErrors: errors, url: failurePage?.url() })); if (failurePage) { await failurePage.screenshot({ path: resolve(dir, 'failure.png') }); console.log((await failurePage.locator('body').innerText()).slice(0, 2500)); } throw error; } finally { releaseDelete?.(); await browser?.close(); await server.close(); store.close(); }
