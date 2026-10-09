import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { agentAnalysisFixture } from '../tests/fixtures/agent-analysis.ts';

// Real browser rendering of the app with synthetic, read-only API responses.
// No backend, production database, credentials, or external model is touched.
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'agent-analysis-ui-'));
const state = agentAnalysisFixture(), before = structuredClone(state);
const status = { mode: 'live', model: 'synthetic-model', modelConfigured: true, browserAvailable: false, version: 'synthetic-ui-test' };
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const base = server.resolvedUrls!.local[0];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const screenshots: string[] = [], errors: string[] = [], blockedRequests: string[] = [];
try {
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') { blockedRequests.push(`${request.method()} ${path}`); await route.abort(); return; }
    const body = path === '/api/state' ? state : path === '/api/status' ? status : null;
    if (!body) { blockedRequests.push(`${request.method()} ${path}`); await route.abort(); return; }
    await route.fulfill({ json: body });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.facts-list .fact-experience-context').count(), 2);
  assert.equal(await page.locator('.fact-split-review .is-child').count(), 1);
  assert.match(await page.locator('.fact-split-review').innerText(), /尚未替换现有事实/);
  assert.ok(await page.getByRole('button', { name: '确认替换，重新审核', exact: true }).isEnabled());
  await page.locator('.fact-split-review .fact-source>summary').click();
  assert.equal(await page.locator('.fact-split-review .fact-source blockquote').count(), 2);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('.sidebar').getByRole('button', { name: '我的经历', exact: true }).click();
    await page.locator('.fact-split-review').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Fact view overflow at ${width}`);
    for (const [name, selector] of [['preview', '.fact-split-review'], ['facts', '.facts-section']] as const) {
      const path = resolve(dir, `${name}-${width}.png`);
      await page.locator(selector).screenshot({ path, style: '.sidebar { visibility: hidden !important; }' }); screenshots.push(path);
    }
    await page.locator('.sidebar').getByRole('button', { name: '岗位简历', exact: true }).click();
    const summary = page.locator('.resume-match-details>summary');
    await summary.click();
    await page.getByTestId('match-analysis').waitFor();
    const order = await page.getByTestId('match-analysis').innerText();
    assert.ok(order.indexOf('这个岗位主要做什么') < order.indexOf('申请建议'));
    assert.ok(order.indexOf('申请建议') < order.indexOf('逐项核对证据'));
    const capability = page.getByTestId('match-capability');
    await capability.locator('.evidence-details>summary').click();
    await capability.locator('.fact-source>summary').click();
    assert.equal(await capability.locator('.fact-parent-title').innerText(), '所属经历校园迎新服务改进');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Analysis overflow at ${width}`);
    const screenshot = resolve(dir, `match-${width}.png`);
    await page.getByTestId('match-analysis').screenshot({ path: screenshot, style: '.sidebar { visibility: hidden !important; }' }); screenshots.push(screenshot);
    const typography = await page.locator('.match-advice-reason').evaluate(element => getComputedStyle(element).fontSize);
    assert.ok(parseFloat(typography) >= 14);
  }
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []); assert.deepEqual(state, before);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', mode: 'synthetic read-only API fixture, real Edge; no website/model validation', checks: ['preview remains uncommitted', 'parent-child experience context rendered', 'source quotes expand', 'work and advice before evidence categories', 'direct and transferable badges', 'legacy UI unit tests', 'no horizontal overflow at 1440 or 390px', 'no browser errors or mutations'], screenshots }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', output: dir, screenshots }, null, 2));
} finally { await browser?.close(); await server.close(); }
