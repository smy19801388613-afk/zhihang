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
import type { CompanyCandidate, ResumeVersion } from '../shared/types.ts';
import { resumeLabel } from '../shared/resume-scope.ts';

// Actual Workflow with synthetic browser hooks and in-memory data. No production/model/real recruiting calls.
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'resume-reuse-ui-'));
const store = new Store(':memory:'), initial = agentAnalysisFixture(); initial.factPreview = null; initial.analysis = null;
initial.profile.email = 'synthetic@example.test'; initial.profile.phone = '13800000000';
initial.job = { company: '', title: '', text: '', url: '' };
const company = (index: number, overrides: Partial<CompanyCandidate> = {}): CompanyCandidate => ({ id: `synthetic-${index}`, name: index < 3 ? '合成同名公司' : `合成公司${index}`, role: '资料整理实习生', industry: '信息服务', careerUrl: `https://example.test/jobs/${index}`, location: index === 2 ? '上海' : '北京', rationale: '', requirements: [], sourceLabel: '合成浏览器采集', sourceKind: 'browser_capture', jdComplete: true, jobDescription: '整理用户咨询资料，维护分类记录并根据反馈改进检索原型。', checkedAt: '2026-10-09T00:00:00Z', hiringStatus: 'unverified', selected: true, decision: 'like', ...overrides });
initial.exploration = { messages: [], directions: [], selectedDirectionIds: [], stage: 'companies', companies: [company(1), company(2), company(3, { jdComplete: false, jobDescription: '列表摘要' }), company(4), company(5, { sourceKind: 'exploration', jobDescription: '', jdComplete: false })] };
const single: ResumeVersion = { id: '11111111-1111-4111-8111-111111111111', version: 1, profile: structuredClone(initial.profile), job: { company: '原有专岗公司', title: '运营实习生', text: '整理资料与用户反馈，维护内容清单。', url: 'https://example.test/original', sourceKind: 'user_jd', jdComplete: true }, bullets: initial.profile.facts.map(fact => ({ text: fact.text, factIds: [fact.id] })), rationale: '合成已有审核专岗简历', approved: true, createdAt: '2026-10-09T00:00:00Z' };
initial.resumes = [single]; store.save(initial, 0);
const fills: string[] = [], submits: string[] = []; let failFill = true, partialFillResponse = true;
const workflow = new Workflow(store, createModelEngine({}), {
  fill: async ({ application }) => { fills.push(application.id); if (application.targetJob?.location === '上海' && failFill) { failFill = false; throw new Error('合成该项填写失败'); } return { evidence: '' }; },
  submit: async ({ application }) => { submits.push(application.id); if (application.targetJob?.location === '上海') throw new Error('合成提交返回中断'); return { receipt: store.createReceipt(application.id), evidence: '' }; },
});
const writes: string[] = [], errors: string[] = [], screenshots: string[] = []; let generationFailure = true;
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, plugins: [{ name: 'isolated-reuse-api', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    const path = (req.url || '').split('?')[0]; if (!path.startsWith('/api/')) { next(); return; }
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && path === '/api/state') { res.end(JSON.stringify(store.read())); return; }
      if (req.method === 'GET' && path === '/api/status') { res.end(JSON.stringify({ mode: 'demo', model: 'synthetic-only', modelConfigured: false, browserAvailable: true, version: 'reuse-ui-test' })); return; }
      // Only empty read-only records for the real-operation slot; this test never authorizes it.
      if (req.method === 'GET' && path.startsWith('/api/real-')) { res.end(JSON.stringify({ runs: [] })); return; }
      if (req.method === 'POST' && path === '/api/actions') {
        let body = ''; for await (const part of req) body += part;
        const action = actionSchema.parse(JSON.parse(body)); writes.push(action.type);
        assert.ok(['generate_general_resume', 'generate_multi_resume', 'approve_resume', 'prepare_applications', 'fill_applications', 'submit_applications'].includes(action.type));
        if (action.type === 'generate_general_resume' && generationFailure) { generationFailure = false; throw new Error('合成生成暂时失败'); }
        if (action.type === 'fill_applications' && partialFillResponse) { partialFillResponse = false; await workflow.act({ ...action, applicationIds: [action.applicationIds[0]] }); throw new Error('合成批次连接中断，已有项目单独保存'); }
        res.end(JSON.stringify(await workflow.act(action))); return;
      }
      throw new Error(`Unexpected isolated API ${req.method} ${path}`);
    } catch (error) { res.statusCode = (error as { status?: number }).status || 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic failure' })); }
  });
} }] }); await server.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0], { waitUntil: 'networkidle' });
  const go = (name: string) => page!.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  const button = (name: string) => page!.getByRole('button', { name, exact: true });
  const purpose = page.getByTestId('resume-purpose-panel'), reuse = page.getByTestId('resume-reuse-panel'), batch = page.getByTestId('application-batch-panel');
  async function completed() { await page!.locator('.busy-indicator').waitFor({ state: 'detached' }); }
  async function shot(name: string, selector: string) { for (const width of [1440, 390]) { await page!.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} overflow ${width}`); const path = resolve(dir, `${name}-${width}.png`); await page!.locator(selector).screenshot({ path, style: '.sidebar{visibility:hidden!important}' }); screenshots.push(path); } }
  async function openPurpose() { if ((await purpose.getAttribute('open')) === null) await purpose.locator(':scope>summary').click(); }
  console.log('General resume without current JD, with draft and failure preservation');
  await go('岗位简历'); await openPurpose(); await purpose.getByRole('button', { name: /通用简历 基于/ }).click();
  await page.getByLabel('新简历名称', { exact: true }).fill('合成通用资料简历'); const focus = page.getByLabel('简历用途说明', { exact: true }); await focus.fill('希望突出咨询记录整理和资料分类。');
  await button('清空简历用途说明').click(); await button('撤销清空简历用途说明').click(); assert.equal(await focus.inputValue(), '希望突出咨询记录整理和资料分类。');
  await go('我的经历'); await go('岗位简历'); assert.equal(await focus.inputValue(), '希望突出咨询记录整理和资料分类。');
  await button('生成通用简历').click(); await page.getByRole('alert').filter({ hasText: '合成生成暂时失败' }).waitFor(); assert.equal(await focus.inputValue(), '希望突出咨询记录整理和资料分类。'); assert.equal(store.read().resumes.length, 1);
  await shot('general-create', '.resume-purpose-panel'); await button('生成通用简历').click(); await page.getByLabel('简历版本', { exact: true }).waitFor(); await completed();
  const general = structuredClone(store.read().resumes.at(-1)!); assert.equal(general.scope!.kind, 'general'); assert.equal(store.read().job.company, ''); assert.equal(!!store.read().resumes[0].stale, false);
  assert.match(await page.locator('.resume-review').innerText(), /合成通用资料简历 · 通用简历/); assert.doesNotMatch(await page.locator('.model-generation-note').innerText(), /手动添加 JD|企业官网/);
  await page.reload({ waitUntil: 'networkidle' }); await go('岗位简历'); assert.equal(await page.getByLabel('简历版本', { exact: true }).inputValue(), general.id);
  await button('确认内容准确').click(); await completed(); await button('选择投递岗位').click();
  const choose = (n: number) => reuse.locator(`.resume-target-option[data-target-id="synthetic-${n}"] input`);
  for (const n of [1, 2, 3]) await choose(n).check(); assert.equal(await choose(5).isDisabled(), true);
  assert.match(await reuse.innerText(), /北京/); assert.match(await reuse.innerText(), /上海/); assert.match(await reuse.innerText(), /详情待补充/);
  const expectedPdf = `/api/resumes/${general.id}/pdf`; assert.equal(await page.getByRole('link', { name: '导出 PDF', exact: true }).getAttribute('href'), expectedPdf);
  await shot('reuse-targets', '.resume-reuse-panel'); await button('准备 3 个岗位的模拟申请').click(); await batch.waitFor(); await completed();
  assert.equal(store.read().applications.length, 3); assert.ok(store.read().applications.every(application => application.resumeId === general.id));
  assert.deepEqual(new Set(store.read().applications.map(application => application.targetJob!.location)), new Set(['北京', '上海']));
  console.log('Partial batch saves, per-item failure, explicit confirmation, unknown cannot resubmit');
  await batch.getByRole('button', { name: '勾选待填写', exact: true }).click(); await button('批量填写 3 个测试表单').click(); await page.getByRole('alert').filter({ hasText: '合成批次连接中断' }).waitFor();
  assert.equal(store.read().applications.filter(application => application.status === 'filled').length, 1); assert.match(await batch.innerText(), /待确认提交/);
  await button('勾选待填写').click(); await button('批量填写 2 个测试表单').click(); await completed(); assert.equal(store.read().applications.filter(application => application.status === 'failed').length, 1); assert.equal(store.read().applications.filter(application => application.status === 'filled').length, 2);
  await button('勾选待填写').click(); await button('批量填写 1 个测试表单').click(); await completed();
  await button('勾选待提交').click(); await button('核对并批量模拟提交').click(); const confirm = page.getByRole('dialog', { name: '确认这批模拟申请' }); await confirm.waitFor(); assert.match(await confirm.innerText(), /上海/); assert.match(await confirm.innerText(), new RegExp(`V${general.version}`)); assert.equal(await button('确认批量模拟提交').isDisabled(), true);
  await button('取消批量提交').click(); assert.equal(submits.length, 0); await button('核对并批量模拟提交').click(); await shot('batch-confirm', '.application-batch-panel'); await confirm.getByRole('checkbox').check(); await button('确认批量模拟提交').click(); await completed();
  assert.equal(store.read().applications.filter(application => application.status === 'confirmed').length, 2); assert.equal(store.read().applications.filter(application => application.status === 'unknown').length, 1); assert.equal(submits.length, 3);
  const unknown = store.read().applications.find(application => application.status === 'unknown')!; assert.equal(await batch.getByRole('checkbox', { name: /上海/ }).isDisabled(), true); assert.match(await batch.innerText(), /待核验，不能重复投递/);
  await button('勾选待提交').click(); assert.equal(await button('核对并批量模拟提交').isDisabled(), true); assert.equal(submits.filter(id => id === unknown.id).length, 1);
  await go('岗位简历'); await button('选择投递岗位').click(); for (const n of [1, 2, 3]) await choose(n).check(); await button('准备 3 个岗位的模拟申请').click(); await completed(); assert.equal(store.read().applications.length, 3); await page.getByRole('status').filter({ hasText: '本次新增 0 条' }).waitFor();
  console.log('Multi-job generation and reuse of an already-approved specialist version');
  await go('岗位简历'); await openPurpose(); await purpose.getByRole('button', { name: /一份多岗 比较/ }).click(); await page.getByLabel('新简历名称', { exact: true }).fill('合成双城共用简历');
  const multi = (n: number) => purpose.locator(`.resume-target-option[data-target-id="synthetic-${n}"] input`);
  assert.equal(await multi(3).isDisabled(), true); assert.equal(await multi(5).isDisabled(), true); await multi(1).check(); assert.equal(await button('生成多岗位简历').isDisabled(), true); await multi(2).check(); assert.equal(await button('生成多岗位简历').isEnabled(), true);
  await shot('multi-create', '.resume-purpose-panel'); await button('生成多岗位简历').click(); await completed(); const shared = store.read().resumes.at(-1)!; assert.equal(shared.scope!.targetJobs.length, 2); assert.equal(shared.scope!.kind, 'multi'); assert.equal(!!store.read().resumes.find(resume => resume.id === general.id)!.stale, false); assert.match(resumeLabel(shared), /2 个岗位共用/);
  await page.getByLabel('简历版本', { exact: true }).selectOption(single.id); await button('选择投递岗位').click(); await choose(4).check(); const countBefore = store.read().resumes.length; await button('准备 1 个岗位的模拟申请').click(); await completed(); assert.equal(store.read().resumes.length, countBefore); assert.equal(store.read().applications.find(application => application.targetJob?.candidateId === 'synthetic-4')!.resumeId, single.id);
  assert.equal(submits.length, 3); assert.deepEqual(errors, []);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', isolation: 'real Workflow and Edge with in-memory synthetic data; simulated browser fill/submit hooks; no production or real recruiting writes', checks: ['general without JD and no fake company/source', 'purpose draft persists across tabs and failure', 'general reload selects current scoped version', 'same reviewed PDF reused across distinct city targets and partial JD', 'batch API error refreshes already-saved partial results', 'per-item fill failure does not stop later items', 'explicit targets/version confirmation required; cancel never submits', 'unknown cannot resubmit', 'duplicate prepare does not create records', 'multi needs 2 complete concrete JDs; summary/exploration disabled', 'general and multi histories coexist', 'existing specialist resume reused without regeneration', 'desktop/mobile no horizontal overflow'], writes, fills, submits, screenshots }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', output: dir }, null, 2));
} catch (error) { writeFileSync(resolve(dir, 'failure-state.json'), JSON.stringify(store.read(), null, 2)); if (page) { await page.screenshot({ path: resolve(dir, 'failure.png') }); console.log((await page.locator('body').innerText()).slice(-6000)); } console.log(JSON.stringify({ errors, output: dir })); throw error; }
finally { await browser?.close(); await server.close(); store.close(); }
