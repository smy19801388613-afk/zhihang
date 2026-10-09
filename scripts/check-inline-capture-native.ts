import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Native Chrome/Edge executeScript verification on a synthetic localhost page.
// Production permissions are unchanged. No real BOSS login, no user profile,
// no model/API call and no workspace import are performed by this test.
mkdirSync(resolve('test-results'), { recursive: true });
const output = mkdtempSync(resolve('test-results/capture-inline-native-'));
const extension = resolve('extensions/zhihang-capture');
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const fixtureUrl = 'http://127.0.0.1:4317/__synthetic_capture_fixture';
  const html = `<!doctype html><meta charset="utf-8"><div id="main"><ul class="job-list-box"><li class="job-card-box active"><a class="job-card-left" href="https://www.zhipin.com/job_detail/nativeInlineA123.html"><span class="job-name">初级海外商务</span><span class="job-area">北京</span></a><div class="company-name">合成微帧</div></li></ul><section class="job-detail-container" data-job-id="nativeInlineA123"><header class="job-detail-header"><h2 class="job-title">初级海外商务</h2><span class="salary">8-13K</span></header><div class="job-sec-text">合成职责：整理海外商务资料与合作方案。</div><aside class="boss-info">PRIVATE_RECRUITER</aside></section></div>`;
  await context.route(fixtureUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(fixtureUrl); await page.locator('.job-sec-text').waitFor();
  const tab = await worker.evaluate(async url => (await (globalThis as any).chrome.tabs.query({ url }))[0], fixtureUrl);
  assert.ok(tab?.id, 'The localhost fixture is visible to the existing localhost permission');
  const result = await worker.evaluate(`(async () => {
    const tabId = ${JSON.stringify(tab.id)};
    const api = globalThis.chrome;
    const installed = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: ['adapters/common.js', 'adapters/boss.js'] });
    const documentId = installed[0].documentId;
    // A test-only platform dispatch override allows the production adapters to
    // read synthetic DOM on the already permitted localhost origin. It is not
    // in shipped extension code and does not add recruitment-site permissions.
    await api.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, func: () => {
      const capture = globalThis.__zhihangCapture;
      const original = capture.platformOf;
      capture.platformOf = (url) => url.startsWith('http://127.0.0.1:4317/__synthetic_capture_fixture') ? 'boss' : original(url);
    } });
    const started = performance.now();
    const capture = await api.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', files: ['adapters/capture.js'] });
    return { elapsedMs: performance.now() - started, documentId, result: capture[0].result, resultDocumentId: capture[0].documentId, permissions: await api.permissions.getAll(), version: api.runtime.getManifest().version };
  })()`) as any;
  assert.ok(result.elapsedMs >= 100, 'Native executeScript awaits the capture Promise and its 120ms stability check');
  assert.equal(result.documentId, result.resultDocumentId);
  assert.equal(result.result.jobs[0].fields.company, '合成微帧'); assert.equal(result.result.jobs[0].fields.jdComplete, true);
  assert.equal(result.result.jobs[0].sourceUrl, 'https://www.zhipin.com/job_detail/nativeInlineA123.html');
  assert.equal(result.result.inlineDiagnostics.reason, 'matched'); assert.doesNotMatch(JSON.stringify(result.result.jobs), /PRIVATE_RECRUITER/);
  assert.deepEqual(result.permissions.permissions.slice().sort(), ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(result.permissions.origins, ['http://127.0.0.1:4317/*']);
  const report = { mode: 'synthetic localhost DOM, native Edge extension executeScript; no real website verification', extensionVersion: result.version, elapsedMs: result.elapsedMs, permissions: result.permissions, diagnostics: result.result.inlineDiagnostics, checks: ['native executeScript awaits async file result', 'documentId is unchanged', 'same-page split job ID binds card employer to right JD', 'private recruiter text excluded', 'production permissions unchanged'], realWebsiteStatus: 'awaiting user capture on logged-in BOSS /web/geek/jobs page' };
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, extensionVersion: result.version, elapsedMs: result.elapsedMs }));
} finally { await context.close(); }
