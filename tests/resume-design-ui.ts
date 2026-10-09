import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { Store, emptyProfile } from '../server/store.ts';
import { Workflow } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { actionSchema } from '../server/validation.ts';
import { agentAnalysisFixture } from './fixtures/agent-analysis.ts';
import type { ResumeVersion } from '../shared/types.ts';
import { closeBrowser, prepareResume, renderResumePdf } from '../server/browser.ts';
import { toResumeDocument } from '../shared/resume-template.ts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Real Workflow, renderer and Edge. Isolated in-memory synthetic profile; no paid model API.
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'resume-design-ui-'));
const store = new Store(':memory:'), initial = agentAnalysisFixture(); initial.factPreview = null;
const old: ResumeVersion = { id: '11111111-1111-4111-8111-111111111111', version: 1, createdAt: '2026-10-07T00:00:00Z', profile: structuredClone(initial.profile), job: { ...initial.job, company: '历史合成公司' }, bullets: [], rationale: '', approved: false, stale: true, quality: { status: 'not_checked', checkedAt: '2026-10-07T00:00:00Z', warnings: [], adjustments: [] } };
initial.resumes = [old]; store.save(initial, 0);
const workflow = new Workflow(store, createModelEngine({}), { fill: async () => { throw new Error('No application'); }, submit: async () => { throw new Error('No submission'); }, prepareResume });
const writes: string[] = [], payloads: unknown[] = [], errors: string[] = [], screenshots: string[] = [];
const failures = new Set(['preview_resume_design', 'apply_resume_design']);
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, plugins: [{ name: 'isolated-design-api', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    const path = (req.url || '').split('?')[0]; if (!path.startsWith('/api/')) { next(); return; }
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && path === '/api/state') { res.end(JSON.stringify(store.read())); return; }
      if (req.method === 'GET' && path === '/api/status') { res.end(JSON.stringify({ mode: 'demo', model: 'synthetic-only', modelConfigured: false, browserAvailable: true, version: 'design-ui-test' })); return; }
      if (req.method === 'GET' && /^\/api\/resumes\/[^/]+\/pdf$/.test(path)) {
        const resume = store.read().resumes.find(value => value.id === path.split('/')[3]); assert.ok(resume);
        res.setHeader('Content-Type', 'application/pdf'); res.end(await renderResumePdf(resume)); return;
      }
      if (req.method === 'POST' && path === '/api/actions') {
        let body = ''; for await (const part of req) body += part;
        const action = actionSchema.parse(JSON.parse(body)); writes.push(action.type); payloads.push(action);
        assert.ok(['preview_resume_design', 'save_resume_design', 'select_resume_design', 'delete_resume_design', 'apply_resume_design', 'generate_resume', 'save_resume_edit', 'clear_profile'].includes(action.type));
        if (failures.delete(action.type)) throw Object.assign(new Error('合成暂时失败，草稿与已保存版本不变。'), { status: 500 });
        res.end(JSON.stringify(await workflow.act(action))); return;
      }
      throw new Error(`Unexpected isolated API ${req.method} ${path}`);
    } catch (error) { res.statusCode = (error as { status?: number }).status || 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic failure' })); }
  });
} }] });
await server.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0], { waitUntil: 'networkidle' });
  const go = (name: string) => page!.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  const button = (name: string) => page!.getByRole('button', { name, exact: true });
  const panel = page.getByTestId('resume-design-panel');
  const input = page.getByLabel('设计要求', { exact: true }), name = page.getByLabel('设计名称', { exact: true });
  async function completed() { await page!.locator('.busy-indicator').waitFor({ state: 'detached' }); }
  async function screenshot(label: string, selector: string) {
    for (const width of [1440, 390]) {
      await page!.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} overflow ${width}`);
      const path = resolve(dir, `${label}-${width}.png`); await page!.locator(selector).screenshot({ path, style: '.sidebar{visibility:hidden!important}' }); screenshots.push(path);
    }
  }
  async function preview() { await button('预览设计规则').click(); await completed(); }
  await go('岗位简历'); await panel.locator(':scope>summary').click();
  await page.getByLabel('打开历史简历', { exact: true }).selectOption(old.id); assert.match(await page.locator('.resume-design-status').innerText(), /尚未检查 PDF/); assert.equal(await page.locator('.resume-design-status .tag.green').count(), 0);
  await page.reload({ waitUntil: 'networkidle' }); await go('岗位简历'); await panel.locator(':scope>summary').click();
  console.log('Checking local file limits, undo, dirty preservation and preview boundaries');
  const upload = page.getByLabel('读取设计文件', { exact: true });
  for (const file of [{ name: 'bad.exe', mimeType: 'text/plain', buffer: Buffer.from('bad') }, { name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0, 1, 2]) }, { name: 'large.md', mimeType: 'text/markdown', buffer: Buffer.from('x'.repeat(12001)) }, { name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(50000)) }]) {
    await upload.setInputFiles(file); await panel.getByRole('alert').waitFor(); assert.equal(await input.inputValue(), '');
  }
  const requirements = '采用黑白配色，教育背景放在最后，正文字号 11 pt，优先一页。添加三栏图表。';
  await upload.setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(requirements) }); await input.inputValue();
  await page.waitForFunction(text => (document.querySelector('[aria-label="设计要求"]') as HTMLTextAreaElement)?.value === text, requirements);
  assert.equal(await name.inputValue(), '导入的设计规则'); assert.deepEqual(writes, []);
  await button('清空设计要求').click(); assert.equal(await input.inputValue(), ''); await button('撤销清空设计要求').click(); assert.equal(await input.inputValue(), requirements);
  await button('清空设计要求').click(); await input.fill('编辑后不能被旧撤销覆盖'); assert.equal(await button('撤销清空设计要求').count(), 0); await input.fill(requirements);
  await go('我的经历'); await go('岗位简历'); assert.equal(await input.inputValue(), requirements); assert.equal(await button('生成岗位简历').isDisabled(), true);
  const concurrent = store.read(); concurrent.questions.push('合成其他窗口的更新'); store.save(concurrent, concurrent.revision);
  await button('刷新工作台记录').click(); assert.equal(await input.inputValue(), requirements);
  await preview(); await page.getByRole('alert').filter({ hasText: '合成暂时失败' }).waitFor(); assert.equal(await input.inputValue(), requirements); assert.equal(store.read().resumeDesign!.skills.length, 0);
  await preview(); await page.getByLabel('设计规则预览', { exact: true }).waitFor();
  assert.equal(store.read().resumeDesign!.skills.length, 0); assert.equal(store.read().resumeDesign!.currentSkillId, null);
  await input.fill(`${requirements} 新要求`); assert.equal(await button('保存并设为默认').isDisabled(), true); await input.fill(requirements);
  await panel.getByText('查看实际排版参数', { exact: true }).click(); await screenshot('design-preview', '.resume-design-panel');
  await button('保存并设为默认').click(); await completed(); const firstSkill = store.read().resumeDesign!.skills[0]; assert.equal(store.read().resumeDesign!.defaultSkillId, firstSkill.id);
  assert.equal(await button('生成岗位简历').isEnabled(), true);
  console.log('Checking real PDF generation, style-only versioning and manual compatibility');
  await button('生成岗位简历').click(); await page.getByLabel('简历版本', { exact: true }).waitFor({ timeout: 60000 }); await completed();
  const original = structuredClone(store.read().resumes.at(-1)!); assert.equal(original.designSkill!.id, firstSkill.id); assert.ok(original.quality!.pageCount! > 0);
  assert.match(await page.locator('.resume-design-status').innerText(), /已保存 PDF/);
  const pdfHref = await page.getByRole('link', { name: '导出 PDF', exact: true }).getAttribute('href'); assert.ok(pdfHref);
  const response = await page.request.get(`${server.resolvedUrls!.local[0].replace(/\/$/, '')}${pdfHref}`); assert.equal(response.status(), 200);
  const pdfBytes = await response.body(); writeFileSync(resolve(dir, 'generated.pdf'), pdfBytes); const pdfTask = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }); const pdf = await pdfTask.promise; assert.equal(pdf.numPages, original.quality!.pageCount); await pdfTask.destroy();
  await screenshot('version-quality', '.resume-design-status');
  await panel.getByRole('button', { name: /经典正式/ }).click(); await name.fill('合成经典规则'); await input.fill('采用衬线字体，教育背景放在最前。');
  await workflow.act({ type: 'select_resume_design', skillId: null, expectedRevision: store.read().revision }); await button('刷新工作台记录').click(); assert.equal(await name.inputValue(), '合成经典规则'); assert.equal(await input.inputValue(), '采用衬线字体，教育背景放在最前。');
  await preview(); await button('保存用于本岗位').click(); await completed();
  const secondSkill = store.read().resumeDesign!.skills.at(-1)!; assert.equal(store.read().resumeDesign!.defaultSkillId, firstSkill.id); assert.deepEqual(store.read().resumes.at(-1), original);
  await button('应用设计并生成新版本').click(); await page.getByRole('alert').filter({ hasText: '合成暂时失败' }).waitFor(); assert.equal(store.read().resumes.at(-1)!.id, original.id);
  await button('应用设计并生成新版本').click(); await completed();
  const styled = structuredClone(store.read().resumes.at(-1)!); assert.equal(styled.parentId, original.id); assert.equal(styled.approved, false); assert.deepEqual(styled.document!.sections, original.document!.sections); assert.equal(styled.designSkill!.id, secondSkill.id);
  assert.match(await page.getByTestId('resume-diff').innerText(), /字体|教育背景位置/);
  await page.getByRole('tab', { name: '网页编辑', exact: true }).click(); await button('配色：森林绿').click(); assert.equal(await button('预览设计规则').isDisabled(), true); assert.match(await page.locator('.resume-design-status').innerText(), /草稿尚未检查/);
  await button('保存新版本').click(); await completed(); const edited = store.read().resumes.at(-1)!; assert.deepEqual(edited.document!.design, styled.document!.design); assert.equal(edited.document!.accent, 'forest');
  console.log('Checking explicit selection, draft replacement and snapshot-preserving deletion');
  await input.fill('仍未保存的设计草稿'); await page.getByLabel('设计规则库', { exact: true }).selectOption(firstSkill.id); await button('使用所选设计').click(); const replace = page.getByRole('alertdialog', { name: '替换未保存的设计草稿？' }); await replace.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await input.inputValue(), '仍未保存的设计草稿');
  await button('使用所选设计').click(); await button('放弃草稿并选择').click(); await completed(); assert.equal(store.read().resumeDesign!.currentSkillId, firstSkill.id); assert.equal(await input.inputValue(), firstSkill.instructions);
  await input.fill('删除规则时保留的新设计草稿'); await page.getByLabel('设计规则库', { exact: true }).selectOption(secondSkill.id); await button('删除所选设计').click(); await screenshot('delete-design', '.record-delete-confirm'); await button('确认删除设计').click(); await completed();
  assert.equal(store.read().resumeDesign!.skills.some(skill => skill.id === secondSkill.id), false); assert.equal(store.read().resumes.at(-1)!.designSkill!.id, secondSkill.id); assert.equal(await input.inputValue(), '删除规则时保留的新设计草稿');
  await page.reload({ waitUntil: 'networkidle' }); await go('岗位简历'); assert.match(await page.locator('.resume-design-status').innerText(), /合成经典规则/);
  await panel.locator(':scope>summary').click(); await input.fill('删除档案时应清掉的合成设计草稿');
  await go('我的经历'); await button('删除当前个人档案').click(); await button('确认删除当前档案').click(); await completed();
  await go('岗位简历'); await panel.locator(':scope>summary').click(); assert.equal(await input.inputValue(), firstSkill.instructions); assert.equal(await button('放弃设计草稿').count(), 0); assert.equal(store.read().resumeDesign!.skills.length, 1);
  assert.ok(payloads.every(payload => !JSON.stringify(payload).includes('fakepath') && !JSON.stringify(payload).includes('C:\\'))); assert.deepEqual(errors, []);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', isolation: 'real Workflow, SQLite in memory, real Edge and PDF renderer, synthetic data; no production or model API', checks: ['three presets and file extension/binary/size limits', 'local text import and clear/undo', 'dirty draft survives tab and external revision refresh', 'preview cannot silently select design; edited draft invalidates preview', 'failed preview and apply retain data', 'save for current job or default', 'real generated PDF pages match quality report', 'design application creates a new unapproved content-preserving version', 'manual editing keeps design parameters and invalidates quality until save', 'explicit library selection with draft replacement confirmation', 'deleting rule keeps immutable resume snapshot', 'unchecked quality is neutral', 'clear profile resets only local design draft to saved default and preserves rule library', 'no horizontal overflow at desktop/mobile'], writes, screenshots }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', output: dir }, null, 2));
} catch (error) { writeFileSync(resolve(dir, 'failure-state.json'), JSON.stringify(store.read(), null, 2)); console.log(JSON.stringify({ errors, url: page?.url(), output: dir })); if (page) { await page.screenshot({ path: resolve(dir, 'failure.png') }); console.log((await page.locator('body').innerText()).slice(-4200)); } throw error; }
finally { await browser?.close(); await closeBrowser(); await server.close(); store.close(); }
