import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { EXTENSION_PACKAGE_FILES } from '../server/extension-package.ts';

const root = process.cwd(); await mkdir(resolve('test-results'), { recursive: true });
const dir = await mkdtemp(resolve('test-results/extension-download-ui-'));
const port = await new Promise<number>(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const value = (server.address() as { port: number }).port; server.close(() => done(value)); }); });
const base = `http://127.0.0.1:${port}`; let log = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false', JOBSPY_ENABLED: 'false' } });
child.stdout?.on('data', value => { log += String(value); }); child.stderr?.on('data', value => { log += String(value); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let n = 0; n < 80; n++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(base + '/api/status')).ok) { ready = true; break; } } catch {} await new Promise(done => setTimeout(done, 100)); }
  assert.ok(ready);
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', acceptDownloads: true });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?view=browser', { waitUntil: 'networkidle' });
  const panel = page.getByTestId('browser-connections');
  const button = panel.getByRole('button', { name: '下载扩展 ZIP', exact: true });
  await button.waitFor();
  assert.equal(await panel.getByLabel('扩展文件夹').isVisible(), false, 'The local project path is an optional closed advanced section');
  assert.match(await panel.innerText(), /自己电脑[\s\S]*chrome:\/\/extensions[\s\S]*edge:\/\/extensions/u);
  assert.equal(await panel.getByLabel('本机服务地址').inputValue(), 'http://127.0.0.1:4317');
  const event = page.waitForEvent('download'); await button.click(); const download = await event;
  assert.match(download.suggestedFilename(), /^zhihang-capture-v[\d.]+\.zip$/u);
  const zipPath = resolve(dir, download.suggestedFilename()); await download.saveAs(zipPath);
  assert.equal(await download.failure(), null);
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  assert.deepEqual(Object.keys(zip.files).sort(), EXTENSION_PACKAGE_FILES.map(name => `zhihang-capture/${name}`).sort());
  await panel.getByText('已发起扩展下载。', { exact: false }).waitFor();
  await panel.screenshot({ path: resolve(dir, 'download-desktop.png') });
  await panel.locator('summary').filter({ hasText: '高级：使用本机项目内的扩展' }).click();
  assert.equal(await panel.getByLabel('扩展文件夹').isVisible(), true);
  await panel.locator('summary').filter({ hasText: '高级：使用本机项目内的扩展' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(dir, 'download-mobile.png'), fullPage: true });
  assert.deepEqual((await (await fetch(base + '/api/browser-connections')).json()).connections, []);
  assert.deepEqual(errors, []);
  const report = { result: 'PASS', browser: 'isolated Chromium/Edge', downloadedFile: download.suggestedFilename(), fileCount: Object.keys(zip.files).length, advancedPathHiddenByDefault: true, mobileOverflow: false, pairingConnectionsCreated: 0, artifactDirectory: dir };
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await writeFile(resolve(dir, 'server.log'), log); throw error; }
finally { await browser?.close(); if (child.exitCode === null) { const exited = new Promise<void>(done => child.once('exit', () => done())); child.send!('shutdown'); await exited; } }
