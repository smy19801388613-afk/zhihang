import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Isolated local browser verification. No real recruitment login, no real user workspace writes.
const extension = resolve('extensions/zhihang-capture');
mkdirSync(resolve('test-results'), { recursive: true });
const output = mkdtempSync(resolve('test-results/capture-extension-'));
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, viewport: { width: 1180, height: 880 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const manifest = await worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest());
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:4317/*']);
  assert.doesNotMatch(manifest.description, /58/u);
  const capturedAt = new Date().toISOString();
  const transport: Array<{ method: string; path: string; origin: string | undefined }> = [];
  let importedPayload: any;
  // Fulfilled transport responses are synthetic; the browser/service-worker HTTP
  // request, Origin generation and restricted host permissions are real.
  await context.route('http://127.0.0.1:4317/extension/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = await request.allHeaders();
    transport.push({ method: request.method(), path, origin: headers.origin });
    const body = request.method() === 'OPTIONS' ? null : path.endsWith('/pair') ? { token: 'a'.repeat(43), connectionId: 'synthetic', expiresAt: '2026-11-05T00:00:00Z' }
      : path.endsWith('/status') ? { connected: true, expiresAt: '2026-11-05T00:00:00Z' }
      : path.endsWith('/connection') ? { revoked: true }
      : { imported: 1, updated: 0, duplicates: 0, errors: [] };
    if (path.endsWith('/import') && request.method() === 'POST') importedPayload = request.postDataJSON();
    await route.fulfill({ status: request.method() === 'OPTIONS' ? 204 : 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': `chrome-extension://${id}`, 'Access-Control-Allow-Methods': 'POST,GET,DELETE', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' }, body: body ? JSON.stringify(body) : '' });
  });
  await worker.evaluate(async ({ capturedAt }) => {
    await (globalThis as any).chrome.storage.session.set({ snapshots: { synthetic: { id: 'synthetic', createdAt: capturedAt, extensionVersion: (globalThis as any).chrome.runtime.getManifest().version, reason: '', jobs: [{ platform: 'boss', sourceUrl: 'https://www.zhipin.com/job_detail/synthetic.html', capturedAt, pageKind: 'list', companyDiagnostics: { reason: 'company_found', strategy: 'selector', regionTag: 'ASIDE', regionClasses: ['sider-company'], counts: { regions: 1, headings: 1, nameNodes: 1, companyLinks: 0, visibleLogos: 0, names: 1 } }, fields: { company: '合成测试公司', title: '<img src=x onerror=alert(1)>法务实习', city: '上海', salary: '200元/天', education: '本科', experience: '在校/应届', jd: '仅用于测试的岗位摘要。', jdComplete: false, industry: '' } }] } } });
  }, { capturedAt });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/preview.html?snapshot=synthetic`);
  await page.getByText('详情待补充', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('main').innerText(), /58同城/u);
  assert.equal(await page.locator('#extension-version').textContent(), `v${manifest.version}`);
  assert.equal(await page.locator('.snapshot-version-warning').count(), 0);
  await page.getByRole('button', { name: '复制采集诊断', exact: true }).waitFor();
  const ownPreviewTabs = await worker.evaluate(async () => {
    const api = (globalThis as any).chrome;
    const views = await api.runtime.getContexts({ contextTypes: ['TAB'] });
    const view = views.find((candidate: any) => candidate.documentUrl === api.runtime.getURL('preview.html?snapshot=synthetic'));
    if (!view) throw new Error('Own preview is not visible through the existing permissions');
    const refreshed = await api.tabs.update(view.tabId, { active: true });
    await api.windows.update(refreshed.windowId, { focused: true });
    return views.map((candidate: any) => ({ id: candidate.tabId, url: candidate.documentUrl }));
  });
  assert.equal(ownPreviewTabs.length, 1);
  await page.getByLabel('一次性配对码').fill('SYNTHETIC');
  await page.getByRole('button', { name: '配对', exact: true }).click();
  await page.getByText(/已连接 · 凭证有效至/).waitFor();
  assert.equal(await page.locator('article.job img').count(), 0);
  await page.locator('[data-field="company"]').fill('人工修正公司');
  await page.locator('[data-field="jd"]').fill('手动补充完整岗位描述，协助合同审查和法律资料研究。');
  await page.getByLabel('我已核对这是完整 JD（列表摘要请勿勾选）').check();
  await page.screenshot({ path: resolve(output, 'preview.png'), fullPage: true });
  await page.getByRole('button', { name: '确认导入职航', exact: true }).click();
  await page.getByText(/导入完成：新增 1 条/).waitFor();
  const payload = importedPayload;
  assert.equal(payload.jobs[0].fields.company, '合成测试公司');
  assert.equal(payload.jobs[0].edits.company, '人工修正公司');
  assert.equal(payload.jobs[0].edits.jdComplete, true);
  assert.equal(payload.protocolVersion, 1);
  assert.equal(payload.jobs[0].companyDiagnostics, undefined);
  await page.reload(); await page.locator('[data-field="company"]').waitFor();
  assert.equal(await page.locator('[data-field="company"]').inputValue(), '人工修正公司');
  assert.equal(await page.getByLabel('选择岗位 1').isChecked(), false);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByText('连接已撤销。再次导入需要重新配对。').waitFor();
  assert.ok(transport.every(request => request.origin === `chrome-extension://${id}`), 'Every extension API request must carry its native extension Origin');
  const permissions = await worker.evaluate(async () => (globalThis as any).chrome.permissions.getAll());
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ mode: 'synthetic extension UI and responses; real service-worker HTTP transport', chromeVersion: context.browser()?.version(), extensionId: id, extensionVersion: manifest.version, permissions, transport, checks: ['Manifest V3 loads with exact localhost port', 'own preview getContexts, activation and window focus work without tabs permission', 'current extension and snapshot versions displayed', 'diagnostic control available without sending diagnostic fields in import payload', 'no remote HTML execution', 'preview field edits remain separate from source fields', 'explicit complete-JD confirmation', 'import payload and counts', 'draft persists across preview reload', 'pair, status, import and disconnect use real extension fetch'], realWebsiteValidation: { boss: 'not exercised by this synthetic run; user real-page company recapture pending', '58': 'not exercised by this synthetic run' } }, null, 2));
  console.log(JSON.stringify({ passed: true, output, extensionId: id, permissions, transport }));
} finally { await context.close(); }
