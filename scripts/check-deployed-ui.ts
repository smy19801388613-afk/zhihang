import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Read-only smoke of the deployed local build. All API mutations are blocked.
const base = 'http://127.0.0.1:4317';
const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
const getState = () => fetch(`${base}/api/state`).then(response => { assert.equal(response.status, 200); return response.json(); });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before = await getState();
const status = await fetch(`${base}/api/status`).then(response => response.json());
assert.equal(status.version, version);
const browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
const errors: string[] = [], mutations: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') { mutations.push(new URL(route.request().url()).pathname); await route.abort(); }
    else await route.continue();
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  const screens = ['我的经历', '方向与公司', '岗位简历', '投递记录'];
  for (const name of screens) {
    await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    if (name === '岗位简历') {
      const design = page.getByTestId('resume-design-panel');
      await design.waitFor({ state: 'visible' });
      if ((await design.getAttribute('open')) === null) await design.locator('summary').first().click();
      await design.getByLabel('设计要求', { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await design.getByRole('button', { name: '预览设计规则', exact: true }).count(), 1);
    }
    if (name === '我的经历' && before.profile.facts.length) {
      assert.equal(await page.locator('.facts-list .fact-item').count(), before.profile.facts.length);
      assert.ok(await page.getByRole('button', { name: '重新检查分段', exact: true }).isEnabled());
    }
    if (name === '岗位简历' && before.job.company && before.job.title) {
      const remove = page.getByRole('button', { name: '移除当前岗位', exact: true });
      assert.equal(await remove.count(), 1);
      await remove.click();
      const confirmation = page.getByRole('alertdialog', { name: '移除当前岗位？' });
      await confirmation.waitFor();
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    }
    if (name === '投递记录' && before.applications.length) {
      const remove = page.getByRole('button', { name: '删除记录', exact: true });
      assert.equal(await remove.count(), before.applications.length);
      await remove.first().click();
      const confirmation = page.getByRole('alertdialog', { name: '删除这条模拟投递记录？' });
      await confirmation.waitFor();
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
  assert.equal(hash(await getState()), hash(before));
  mkdirSync(resolve('test-results'), { recursive: true });
  const report = { result: 'PASS', version, readOnly: true, screens, browserErrors: 0, mutations: 0, workspaceUnchanged: true };
  writeFileSync(resolve('test-results', `deployed-ui-${version}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
