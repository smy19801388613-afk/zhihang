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
import { RealApplications } from '../server/real-applications.ts';
import { toResumeDocument } from '../shared/resume-template.ts';

// Real authorization store and API behavior on a synthetic SQLite file; no recruiting website is visited.
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'real-application-ui-')), db = resolve(dir, 'workspace.sqlite');
const store = new Store(db), initial = agentAnalysisFixture(); initial.factPreview = null; initial.analysis = null; initial.job = { company: '', title: '', text: '', url: '' };
initial.profile.email = 'private-synthetic@example.test'; initial.profile.phone = '13800000000';
const resume = (id: string, version: number, approved: boolean): ResumeVersion => ({ id, version, createdAt: '2026-10-09T00:00:00Z', profile: structuredClone(initial.profile), job: { company: '', title: '资料整理方向', text: '', url: '' }, scope: { kind: 'general', name: `合成通用版本${version}`, focus: '资料整理', targetJobs: [] }, collectionId: id, bullets: initial.profile.facts.map(fact => ({ text: fact.text, factIds: [fact.id] })), rationale: '合成资料', approved });
initial.resumes = [resume('11111111-1111-4111-8111-111111111111', 1, false), resume('22222222-2222-4222-8222-222222222222', 2, true)]; initial.activeResumeId = initial.resumes[0].id; store.save(initial, 0);
const pdfCalls: string[] = [];
const real = new RealApplications(db, store, async version => { pdfCalls.push(version.id); return Buffer.from(`%PDF-1.7\nSynthetic PDF hook for immutable resume ${version.id}\n%%EOF`); });
const workflow = new Workflow(store, createModelEngine({}), { fill: async () => { throw new Error('No form operation'); }, submit: async () => { throw new Error('No submission'); } });
const requests: string[] = [], errors: string[] = [], screenshots: string[] = []; let base = '';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, plugins: [{ name: 'isolated-real-authorization-api', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    const path = (req.url || '').split('?')[0]; if (!path.startsWith('/api/')) { next(); return; }
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && path === '/api/state') { res.end(JSON.stringify(store.read())); return; }
      if (req.method === 'GET' && path === '/api/status') { res.end(JSON.stringify({ mode: 'demo', model: 'synthetic-only', modelConfigured: false, browserAvailable: true, version: 'real-auth-ui-test' })); return; }
      if (req.method === 'GET' && path === '/api/real-applications') { res.end(JSON.stringify({ runs: real.list() })); return; }
      if (req.headers.origin !== base) { res.statusCode = 403; res.end(JSON.stringify({ error: 'Only same-origin writes' })); return; }
      let body = ''; for await (const part of req) body += part;
      requests.push(`${req.method} ${path}`);
      if (req.method === 'POST' && path === '/api/actions') { const action = actionSchema.parse(JSON.parse(body)); assert.equal(action.type, 'approve_resume'); res.end(JSON.stringify(await workflow.act(action))); return; }
      if (req.method === 'POST' && path === '/api/real-applications') { res.end(JSON.stringify(await real.create(JSON.parse(body)))); return; }
      const match = path.match(/^\/api\/real-applications\/([^/]+)(\/revoke)?$/);
      if (match && match[2] && req.method === 'POST') { res.end(JSON.stringify({ run: real.revoke(match[1], JSON.parse(body).expectedRevision) })); return; }
      if (match && !match[2] && req.method === 'DELETE') { real.remove(match[1], JSON.parse(body).expectedRevision); res.end(JSON.stringify({ deleted: true })); return; }
      throw new Error(`Unexpected isolated API ${req.method} ${path}`);
    } catch (error) { res.statusCode = (error as { status?: number }).status || 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic failure' })); }
  });
} }] }); await server.listen(); base = server.resolvedUrls!.local[0].replace(/\/$/, '');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (route.request().url().startsWith(base) || route.request().url().startsWith('data:')) return route.continue(); errors.push(`Unexpected external request ${new URL(route.request().url()).origin}`); return route.abort(); });
  await page.goto(base, { waitUntil: 'networkidle' });
  const go = (name: string) => page!.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  const button = (name: string) => page!.getByRole('button', { name, exact: true });
  const panel = page.locator('.real-application-panel'), reuse = page.getByTestId('resume-reuse-panel'), records = page.locator('.real-application-records');
  const url = page.getByLabel('字节校招官网链接', { exact: true }), consent = panel.getByRole('checkbox'), create = button('生成本次网申授权码');
  async function completed() { await page!.locator('.busy-indicator').waitFor({ state: 'detached' }); }
  async function shot(name: string, selector: string) { for (const width of [1440, 390]) { await page!.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} overflow ${width}`); const path = resolve(dir, `${name}-${width}.png`); await page!.locator(selector).screenshot({ path, style: '.sidebar{visibility:hidden!important}' }); screenshots.push(path); } }
  const link1 = 'https://jobs.bytedance.com/campus/resume/1111111111111111111/apply', link2 = 'https://jobs.bytedance.com/campus/position/2222222222222222222/detail';
  await go('岗位简历'); await reuse.locator(':scope>summary').click();
  assert.equal(await create.isDisabled(), true); await url.fill(link1); await consent.check(); assert.equal(await create.isDisabled(), true); assert.equal(real.list().length, 0);
  await button('确认内容准确').click(); await completed(); assert.equal(await create.isEnabled(), true);
  await page.getByRole('tab', { name: '网页编辑', exact: true }).click(); const headline = page.getByLabel('简历标题 / 求职意向', { exact: true }); const beforeHeadline = await headline.inputValue(); await headline.fill(`${beforeHeadline} 未保存改动`); assert.equal(await create.isDisabled(), true); await button('撤销修改').click(); assert.equal(await create.isEnabled(), true);
  await url.fill('https://untrusted.example/campus/resume/1111111111111111111/apply'); await consent.check(); assert.equal(await create.isDisabled(), true); assert.match(await panel.innerText(), /请使用字节校招/); assert.equal(real.list().length, 0);
  await url.fill(`${link1}\n${link2}`); assert.equal(await consent.isChecked(), false); assert.equal(await create.isDisabled(), true); await consent.check();
  const profileBefore = structuredClone(store.read().profile); await create.click(); await panel.locator('.real-authorization code').waitFor(); assert.match(await panel.locator('.real-authorization code').innerText(), /^[A-F0-9]{16}$/); assert.equal(real.list().length, 1); assert.deepEqual(store.read().profile, profileBefore);
  const firstRun = real.list()[0]; assert.equal(firstRun.resume.id, initial.resumes[0].id); assert.equal(firstRun.targets.length, 2); assert.ok(firstRun.targets.every(target => target.status === 'pending')); assert.deepEqual(pdfCalls, [initial.resumes[0].id]);
  const list = await (await page.request.get(`${base}/api/real-applications`)).json(); assert.equal(list.runs.length, 1); assert.equal('fields' in list.runs[0], false); assert.doesNotMatch(JSON.stringify(list), /private-synthetic@example|13800000000|experienceText|facts|token|code/);
  await shot('authorization-code', '.real-application-panel');
  await url.fill(link1); assert.equal(await panel.locator('.real-authorization').count(), 0); assert.equal(await consent.isChecked(), false); assert.equal(real.list().length, 1);
  await page.getByLabel('简历版本', { exact: true }).selectOption(initial.resumes[1].id); assert.equal(await url.inputValue(), ''); assert.equal(await panel.locator('.real-authorization').count(), 0); assert.equal(await consent.isChecked(), false);
  await go('投递记录'); await records.getByText(/合成通用版本1/).waitFor(); assert.match(await records.innerText(), /待填写/); assert.doesNotMatch(await records.innerText(), /页面显示投递成功/); await shot('real-record', '.real-application-records');
  await records.getByRole('button', { name: '撤销授权', exact: true }).click(); await records.getByText('授权已撤销', { exact: true }).waitFor(); assert.ok(real.list()[0].revokedAt);
  await button('删除本地记录').click(); const dialog = page.getByRole('dialog', { name: '删除真实网申记录' }); await dialog.waitFor(); assert.match(await dialog.innerText(), /不会撤回官网申请/); await dialog.getByRole('button', { name: '保留', exact: true }).click(); assert.equal(real.list().length, 1);
  await button('删除本地记录').click(); await shot('delete-real-record', '.real-run'); await dialog.getByRole('button', { name: '确认删除记录', exact: true }).click(); await page.locator('.real-run').waitFor({ state: 'detached' }); assert.equal(real.list().length, 0);
  assert.equal(requests.filter(request => request === 'POST /api/real-applications').length, 1); assert.equal(requests.filter(request => request.startsWith('DELETE ')).length, 1); assert.deepEqual(errors, []);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', isolation: 'synthetic SQLite + actual RealApplications + real Edge; PDF bytes hook, no extension claim or real website interaction', checks: ['unreviewed and dirty versions cannot authorize', 'manual official URLs work with no picked targets', 'other domains rejected in UI', 'explicit consent bound to targets and version', 'code appears only after successful creation', 'records API excludes personal fields/code/token', 'changing links or resume clears old consent/code', 'records remain pending, never implied submitted', 'revoke then delete with cancel/confirm', 'no external browser requests', '1440/390 layout no overflow'], requests, screenshots }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', output: dir }, null, 2));
} catch (error) { if (page) { await page.screenshot({ path: resolve(dir, 'failure.png') }); console.log((await page.locator('body').innerText()).slice(-5000)); } console.log(JSON.stringify({ errors, output: dir })); throw error; }
finally { await browser?.close(); await server.close(); real.close(); store.close(); }
