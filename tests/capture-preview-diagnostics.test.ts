import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

// Synthetic extension APIs in an isolated page. Real extension transport is tested
// separately by scripts/check-capture-extension.ts; these tests never send reports.
let browser: Browser;
const folder = resolve('extensions/zhihang-capture');
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const diagnostic = { reason: 'missing_company_region', strategy: 'none', regionTag: '', regionClasses: [], counts: { regions: 0, headings: 1, nameNodes: 0, companyLinks: 0, visibleLogos: 1, names: 0 } };
const fixture = (diagnostics: unknown = diagnostic, version?: string) => ({ extensionVersion: version, createdAt: '2026-10-05T00:00:00Z', reason: '', privateData: 'PRIVATE_SNAPSHOT_VALUE', url: 'https://www.zhipin.com/?secret=PRIVATE_QUERY', jobs: [{ platform: 'boss', pageKind: 'detail', capturedAt: '2026-10-05T00:00:00Z', sourceUrl: 'https://www.zhipin.com/job_detail/synthetic.html?secret=PRIVATE_QUERY', companyDiagnostics: diagnostics, privateData: 'PRIVATE_JOB_VALUE', fields: { company: '合成公司', title: '合成岗位', salary: '', city: '', education: '', experience: '', jd: 'PRIVATE_JOB_DESCRIPTION', jdComplete: true } }] });
async function preview(snapshot: unknown, copyFails = false) {
  const page = await browser.newPage();
  await page.addInitScript({ content: `{
    const snapshot = ${JSON.stringify(snapshot)}, copyFails = ${JSON.stringify(copyFails)};
    const scope = globalThis;
    scope.sent = []; scope.copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (copyFails) throw Error('Not allowed'); scope.copied = text; } } });
    scope.chrome = { runtime: { getManifest: () => ({ version: '0.1.2' }), sendMessage: async message => { scope.sent.push(message); return { ok: true, data: message.type === 'status' ? { connected: true, expiresAt: '2026-11-05T00:00:00Z' } : { imported: 1, updated: 0, duplicates: 0, errors: [] } }; } }, storage: { session: { get: async () => ({ snapshots: { synthetic: snapshot }, drafts: {} }), set: async () => {} } } };
  }` });
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === '/preview.js' ? 'preview.js' : path === '/preview.css' ? 'preview.css' : 'preview.html';
    return route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', body: readFileSync(resolve(folder, file), 'utf8') });
  });
  await page.goto('https://synthetic.invalid/preview.html?snapshot=synthetic');
  await page.getByText(/已连接 · 凭证有效至/).waitFor();
  return page;
}

test('preview identifies current version and warns for old or unversioned snapshots', async () => {
  for (const version of [undefined, '0.1.1', '0.1.2']) {
    const page = await preview(fixture(diagnostic, version));
    try {
      assert.equal(await page.locator('#extension-version').innerText(), 'v0.1.2');
      assert.equal(await page.locator('.snapshot-version-warning').count(), version === '0.1.2' ? 0 : 1);
      assert.match(await page.locator('#capture-info').innerText(), new RegExp(version || '未知（旧快照）'));
    } finally { await page.close(); }
  }
});
test('retired source snapshots are not offered for new import and manual source only offers BOSS', async () => {
  const snapshot = fixture(diagnostic, '0.1.2');
  snapshot.jobs[0].platform = '58'; snapshot.jobs[0].sourceUrl = 'https://sh.58.com/tech/12345678901234x.shtml';
  const page = await preview(snapshot);
  try {
    assert.equal(await page.locator('article.job').count(), 0);
    assert.equal(await page.getByRole('button', { name: '确认导入职航' }).isDisabled(), true);
    assert.match(await page.locator('#capture-info').innerText(), /历史导入记录不受影响/u);
    await page.getByRole('button', { name: '手动粘贴 JD' }).click();
    assert.deepEqual(await page.getByLabel('来源平台').locator('option').allTextContents(), ['BOSS直聘']);
    assert.doesNotMatch(await page.locator('main').innerText(), /58同城/u);
    assert.equal(await page.evaluate(() => (globalThis as any).sent.some((message: any) => message.type === 'import')), false);
  } finally { await page.close(); }
});

test('copied diagnostic uses strict enums and structure allowlist without page or job contents', async () => {
  const dirty = { ...diagnostic, regionTag: 'ASIDE', regionClasses: ['sider-company', 'PRIVATE_CLASS', 'sider-company'], counts: { ...diagnostic.counts, headings: 201, nameNodes: -1, companyLinks: 1.5, private: 'PRIVATE_COUNT' }, company: 'PRIVATE_NAME', html: 'PRIVATE_HTML', url: 'https://example.com/?secret=PRIVATE_URL' };
  const snapshot = fixture(dirty, '0.1.1'); snapshot.jobs[0].fields.company = '';
  const page = await preview(snapshot);
  try {
    await page.getByRole('button', { name: '复制采集诊断' }).click();
    const copied = await page.evaluate(() => (globalThis as any).copied) as string;
    const report = JSON.parse(copied);
    assert.equal(report.extensionVersion, '0.1.2'); assert.equal(report.snapshotVersion, '0.1.1');
    assert.equal(report.jobsCount, 1); assert.equal(report.emptyCompanyCount, 1);
    assert.deepEqual(report.jobs[0], { index: 1, platform: 'boss', pageKind: 'detail', companyDiagnostics: { reason: 'missing_company_region', strategy: 'none', regionTag: 'ASIDE', regionClasses: ['sider-company'], counts: { regions: 0, visibleLogos: 1, names: 0 } } });
    assert.doesNotMatch(copied, /PRIVATE|https?:|合成岗位|sourceUrl|capturedAt/);
    assert.deepEqual(await page.evaluate(() => (globalThis as any).sent.map((message: any) => message.type)), ['status'], 'Copy does not send diagnostics anywhere');
  } finally { await page.close(); }
});

test('unavailable clipboard exposes a read-only manual copy field; absent diagnostics hide the button', async () => {
  const page = await preview(fixture(diagnostic, '0.1.2'), true);
  try {
    await page.getByRole('button', { name: '复制采集诊断' }).click();
    assert.equal(await page.locator('#diagnostic-fallback').isVisible(), true);
    assert.equal(await page.locator('#diagnostic-text').getAttribute('readonly'), '');
    assert.match(await page.locator('#diagnostic-text').inputValue(), /missing_company_region/);
  } finally { await page.close(); }
  const empty = await preview(fixture(null, '0.1.2'));
  try { assert.equal(await empty.getByRole('button', { name: '复制采集诊断' }).isVisible(), false); }
  finally { await empty.close(); }
});

test('diagnostic metadata never enters the strict import payload', async () => {
  const page = await preview(fixture(diagnostic, '0.1.2'));
  try {
    await page.getByRole('button', { name: '确认导入职航' }).click();
    await page.getByText(/导入完成：新增 1 条/).waitFor();
    const payload = await page.evaluate(() => (globalThis as any).sent.find((message: any) => message.type === 'import').body);
    assert.deepEqual(Object.keys(payload.jobs[0]).sort(), ['capturedAt', 'fields', 'pageKind', 'platform', 'sourceUrl'].sort());
    assert.equal(payload.jobs[0].companyDiagnostics, undefined); assert.equal(payload.jobs[0].privateData, undefined);
  } finally { await page.close(); }
});

test('split-panel-only diagnostics copy only allowed counts and enums and never enter imports', async () => {
  const snapshot = { ...fixture(null, '0.1.2'), inlineDiagnostics: { reason: 'missing_identity', counts: { cards: 12, selectedCards: 1, panels: 1, identifiedPanels: 0, descriptionPanels: 1, jobId: 'PRIVATE_JOB_ID', secret: 'PRIVATE_SECRET' }, url: 'https://www.zhipin.com/?securityId=PRIVATE_QUERY', jd: 'PRIVATE_RIGHT_JD', title: 'PRIVATE_TITLE' } };
  const page = await preview(snapshot);
  try {
    await page.getByRole('button', { name: '复制采集诊断' }).click();
    const copied = await page.evaluate(() => (globalThis as any).copied) as string;
    const report = JSON.parse(copied);
    assert.deepEqual(report.inlineDiagnostics, { reason: 'missing_identity', counts: { cards: 12, selectedCards: 1, panels: 1, identifiedPanels: 0, descriptionPanels: 1 } });
    assert.deepEqual(report.jobs, []); assert.doesNotMatch(copied, /PRIVATE|https?:|securityId|jobId/);
    await page.getByRole('button', { name: '确认导入职航' }).click();
    await page.getByText(/导入完成：新增 1 条/).waitFor();
    const payload = await page.evaluate(() => (globalThis as any).sent.find((message: any) => message.type === 'import').body);
    assert.equal(payload.inlineDiagnostics, undefined); assert.equal(payload.jobs[0].inlineDiagnostics, undefined);
  } finally { await page.close(); }
});

test('discarded SPA capture still offers bounded structure-only diagnostics with no jobs', async () => {
  const snapshot = { ...fixture(null, '0.1.2'), jobs: [], inlineDiagnostics: { reason: 'changed_during_capture', counts: { cards: 2, selectedCards: 1, panels: 1, identifiedPanels: 1, descriptionPanels: 1 } } };
  const page = await preview(snapshot);
  try {
    await page.getByRole('button', { name: '复制采集诊断' }).click();
    const report = JSON.parse(await page.evaluate(() => (globalThis as any).copied));
    assert.equal(report.jobsCount, 0); assert.equal(report.inlineDiagnostics.reason, 'changed_during_capture');
  } finally { await page.close(); }
});
