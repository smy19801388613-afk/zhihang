import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Real Edge extension transport + synthetic local service responses only.
// This neither visits a recruitment website nor reads production data.
mkdirSync(resolve('test-results'), { recursive: true });
const output = mkdtempSync(resolve('test-results/bytedance-extension-'));
const extension = resolve('extensions/zhihang-capture');
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, viewport: { width: 1100, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname, origin = `chrome-extension://${id}`;
  const pdf = Buffer.from('%PDF-1.7\nsynthetic approved PDF fixture\n%%EOF');
  const jobId = '7246662982998313277';
  const run = { id: 'synthetic-run', revision: 0, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), resume: { id: 'synthetic-resume', version: 2, label: '合成通用简历', sha256: createHash('sha256').update(pdf).digest('hex') }, fields: { name: '合成同学', email: 'student@example.com', phone: '13800000000', school: '合成大学', education: '本科', major: '合成专业', graduation: '', city: '北京', availability: '' }, targets: [{ id: jobId, url: `https://jobs.bytedance.com/campus/position/${jobId}/detail`, applyUrl: `https://jobs.bytedance.com/campus/resume/${jobId}/apply`, title: '合成岗位', company: '字节跳动', status: 'pending' }] };
  let failSubmitting = false;
  const transport: any[] = [];
  await context.route('http://127.0.0.1:4317/extension/apply/v1/**', async route => {
    const request = route.request(), headers = await request.allHeaders(), path = new URL(request.url()).pathname;
    transport.push({ method: request.method(), path, origin: headers.origin, hasAuthorization: Boolean(headers.authorization), ...(path.endsWith('/checkpoint') ? { status: request.postDataJSON().status } : {}) });
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path.endsWith('/resume.pdf')) return route.fulfill({ contentType: 'application/pdf', headers: cors, body: pdf });
    if (path.endsWith('/checkpoint')) {
      const data = request.postDataJSON();
      if (failSubmitting && data.status === 'submitting') return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: '合成预存失败' }) });
      assert.equal(data.expectedRevision, run.revision); run.revision++; run.targets[0].status = data.status;
    }
    const data = path.endsWith('/claim') ? { token: 'z'.repeat(43), expiresAt: run.expiresAt, run } : run;
    await route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(data) });
  });
  await worker.evaluate(async ({ jobId }) => {
    const api = (globalThis as any).chrome;
    await api.storage.session.set({ applicationSnapshot: { tabId: 123, documentId: 'synthetic', url: `https://jobs.bytedance.com/campus/resume/${jobId}/apply`, extensionVersion: api.runtime.getManifest().version, createdAt: new Date().toISOString(), diagnostic: { routeKind: 'apply', positionId: jobId, fields: [], buttons: [], automaticSubmitEnabled: false } } });
  }, { jobId });
  const page = await context.newPage(); await page.goto(`${origin}/application.html`);
  await page.getByLabel('本次网申授权码').fill('ABCDEF1234567890'); await page.getByRole('button', { name: '连接本次申请', exact: true }).click();
  await page.getByText('合成通用简历 · 版本 2', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('本次网申授权码').inputValue(), '');
  await page.getByRole('button', { name: '预览已批准 PDF', exact: true }).click();
  await page.getByRole('link', { name: '打开已批准 PDF · 版本 2' }).waitFor();
  assert.match(await page.getByRole('link', { name: '打开已批准 PDF · 版本 2' }).getAttribute('href') || '', /^blob:chrome-extension:/u);
  await page.screenshot({ path: resolve(output, 'approved-run.png'), fullPage: true });
  await page.reload(); await page.getByText('合成通用简历 · 版本 2', { exact: true }).waitFor();
  // Native extension UI, sender checks and service-worker HTTP are real. A
  // narrow synthetic adapter bridge stands in for activeTab website access;
  // real DOM behavior is separately covered in bytedance-application.test.ts.
  await worker.evaluate(({ jobId }) => {
    const api = (globalThis as any).chrome;
    const originalGet = api.tabs.get;
    api.tabs.get = async (tabId: number) => tabId === 123 ? { id: 123, url: `https://jobs.bytedance.com/campus/resume/${jobId}/apply` } : originalGet(tabId);
    (globalThis as any).__syntheticClicks = 0;
    api.scripting.executeScript = async (input: any) => {
      const url = `https://jobs.bytedance.com/campus/resume/${jobId}/apply`;
      if (!input.args) return [{ result: url }];
      if (input.args[0] === 'submitPreflight') return [{ result: { fingerprint: 'synthetic-form', fileCheck: 'requires_user_confirmation', buttonLabel: '提交简历' } }];
      if (input.args[0] === 'submit') { (globalThis as any).__syntheticClicks++; return [{ result: { outcome: 'submitted', evidence: '投递成功', pageUrl: url } }]; }
      throw new Error('Unexpected synthetic operation');
    };
  }, { jobId });
  await page.getByRole('button', { name: '检查最终提交', exact: true }).click();
  await page.locator('#submit-review').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: '确认向字节提交本岗位申请', exact: true }).isEnabled(), false);
  for (const id of ['review-fields', 'review-attachment', 'review-agreements']) await page.locator(`#${id}`).check();
  await page.screenshot({ path: resolve(output, 'explicit-submit-review.png'), fullPage: true });
  await page.getByRole('button', { name: '确认向字节提交本岗位申请', exact: true }).click();
  await page.getByText('官网当前岗位页面显示明确成功提示，已记录。请保留官网投递记录。', { exact: true }).waitFor();
  assert.equal(run.targets[0].status, 'submitted');
  assert.equal(await worker.evaluate(() => (globalThis as any).__syntheticClicks), 1);
  assert.deepEqual(transport.filter(item => item.status).map(item => item.status), ['filled', 'submitting', 'submitted']);
  // New synthetic target/run simulates a second individually confirmed job.
  run.id = 'synthetic-run-failure'; run.revision = 0; run.targets[0].status = 'pending'; failSubmitting = true;
  await page.reload(); await page.getByRole('button', { name: '检查最终提交', exact: true }).click();
  for (const id of ['review-fields', 'review-attachment', 'review-agreements']) await page.locator(`#${id}`).check();
  await page.getByRole('button', { name: '确认向字节提交本岗位申请', exact: true }).click();
  await page.getByText('合成预存失败', { exact: true }).waitFor();
  assert.equal(await worker.evaluate(() => (globalThis as any).__syntheticClicks), 1, 'Failed submitting checkpoint must send no second click');
  await page.getByRole('button', { name: '清除此浏览器的临时授权', exact: true }).click();
  await page.getByText('尚未连接本次申请。', { exact: true }).waitFor();
  const authorization = await worker.evaluate(async () => (await (globalThis as any).chrome.storage.session.get('applicationAuthorization')).applicationAuthorization);
  assert.equal(authorization, undefined);
  assert.ok(transport.every(item => item.method === 'POST' || item.method === 'OPTIONS'));
  assert.ok(transport.every(item => item.origin === origin), 'Native browser must attach exact extension Origin to every endpoint');
  assert.ok(transport.filter(item => item.method === 'POST' && !item.path.endsWith('/claim')).every(item => item.hasAuthorization));
  const permissions = await worker.evaluate(async () => (globalThis as any).chrome.permissions.getAll());
  assert.deepEqual(permissions.origins, ['http://127.0.0.1:4317/*']);
  const report = { passed: true, mode: 'real isolated Edge extension UI/HTTP + synthetic server responses and adapter bridge; no live form write', version: await worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest().version), checks: ['separate application page and one-run code', 'native POST Origin on claim/run/PDF/checkpoint', 'approved PDF hash verified before local preview', 'session authorization survives page reload', 'three explicit review checkboxes required', 'filled/submitting saved before one synthetic click and exact success record', 'failed submitting checkpoint sends no click', 'forget removes only temporary application credential', 'no expanded host permissions'], transport, permissions, liveWebsiteWrite: 'not performed' };
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, output, transport }));
} finally { await context.close(); }
