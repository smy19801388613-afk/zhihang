import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Visual QA uses only the previously generated synthetic test workspace.
const root = process.cwd();
const fixture = resolve(root, 'test-results/four-steps-ui-T4WbXX/zhihang.sqlite');
assert.ok(existsSync(fixture), 'Generate the synthetic four-step UI fixture first');
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'ui-refresh-'));
copyFileSync(fixture, resolve(dir, 'zhihang.sqlite'));
const port = await new Promise<number>(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const available = (server.address() as { port: number }).port; server.close(() => done(available)); }); });
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
let log = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false', JOBSPY_ENABLED: 'false' } });
child.stdout?.on('data', value => { log += value.toString(); }); child.stderr?.on('data', value => { log += value.toString(); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const screenshots: string[] = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`${base}/api/status`)).ok) { ready = true; break; } } catch {} await sleep(200); }
  assert.ok(ready, log);
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [name, title] of [['profile', '我的经历'], ['jobs', '方向与公司'], ['resume', '岗位简历'], ['browser', '浏览器扩展'], ['settings', '模型设置']] as const) {
      await page.locator('.sidebar').getByRole('button', { name: title, exact: true }).click();
      await page.waitForTimeout(100);
      if (name === 'jobs') await page.getByTestId('job-discovery').evaluate(element => { element.scrollIntoView({ block: 'start' }); window.scrollBy(0, innerWidth <= 760 ? -125 : -20); }); else await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} horizontal overflow at ${viewport.width}`);
      const path = resolve(dir, `${name}-${viewport.width}.png`);
      await page.screenshot({ path, fullPage: false }); screenshots.push(path);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.sidebar').getByRole('button', { name: '方向与公司', exact: true }).click();
  await page.getByTestId('swipe-like').click();
  const pending = page.getByTestId('liked-job').filter({ hasText: '法务实习生' });
  await pending.getByTestId('prepare-liked-resume').click();
  await page.getByTestId('resume-preparation').waitFor();
  await page.locator('.resume-preparation-jd>summary').click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Resume preparation overflow at ${width}`);
    const path = resolve(dir, `prepare-${width}.png`);
    await page.screenshot({ path, fullPage: false }); screenshots.push(path);
  }
  await page.locator('.sidebar').getByRole('button', { name: '我的经历', exact: true }).click();
  const typography = await page.evaluate(() => ({ body: getComputedStyle(document.body).color, input: getComputedStyle(document.querySelector('.field input')!).fontSize, description: getComputedStyle(document.querySelector('.page-description')!).fontSize, button: getComputedStyle(document.querySelector('.button.primary')!).backgroundColor }));
  assert.equal(typography.body, 'rgb(39, 39, 42)'); assert.equal(typography.button, 'rgb(79, 70, 229)'); assert.ok(parseFloat(typography.input) >= 14); assert.ok(parseFloat(typography.description) >= 14);
  assert.deepEqual(errors, []);
  const report = { result: 'PASS', mode: 'isolated synthetic workspace; no user data changed', checks: ['five workspaces rendered at desktop and 390px mobile', 'no horizontal overflow', 'neutral text and indigo primary button', 'form and description text at least 14px', 'no browser errors'], typography, screenshots };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ result: 'PASS', output: dir, typography, screenshots }, null, 2));
} catch (error) { writeFileSync(resolve(dir, 'server.log'), log); throw error; }
finally { await browser?.close(); if (child.connected) child.send('shutdown'); for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await sleep(200); if (child.exitCode === null) child.kill(); }
