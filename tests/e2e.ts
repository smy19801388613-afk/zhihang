import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { parseResumeFile } from '../server/resume-import.ts';
import type { Action, WorkspaceState } from '../shared/types.ts';

const root = process.cwd();
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'e2e-'));
const port = await new Promise<number>(resolvePort => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolvePort(port)); });
});
const base = `http://127.0.0.1:${port}`;
let serverOutput = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false' }, windowsHide: true
});
child.stdout?.on('data', chunk => { serverOutput += chunk.toString(); });
child.stderr?.on('data', chunk => { serverOutput += chunk.toString(); });
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
let state: WorkspaceState;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${serverOutput}`);
    try { const response = await fetch(`${base}/api/status`); if (response.ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  assert.ok(ready, `Server did not become ready: ${serverOutput}`);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.mode, 'demo');
  assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  state = await (await fetch(`${base}/api/state`)).json();
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(existsSync);
  browser = await chromium.launch({ executablePath: executable, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.screenshot({ path: resolve(dir, 'empty.png'), fullPage: true });
  async function clickAction(button: string, type: Action['type']) {
    const pending = page!.waitForResponse(response => response.url().endsWith('/api/actions') && response.request().postDataJSON()?.type === type);
    await page!.getByRole('button', { name: button, exact: true }).first().click();
    const response = await pending;
    const body = await response.json();
    assert.ok(response.ok(), `${type}: ${JSON.stringify(body)}`);
    state = body;
  }
  const fixture = await browser.newPage();
  await fixture.setContent('<html lang="zh"><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei";font-size:14px;line-height:2}</style><h1>基础简历 · 虚构测试资料</h1><p>姓名：苏禾</p><p>邮箱：suhe@example.com</p><p>手机号：13800000000</p><p>学校：示例大学</p><p>学历：本科</p><p>专业：法学</p><p>毕业时间：2027年6月</p><p>意向城市：北京</p><p>到岗时间：每周4天，可连续实习3个月</p><h2>项目经历</h2><p>2025年我负责课程中的隐私政策研究，检索公开资料并整理对比表。</p><p>我参与校内模拟法庭，负责资料检索、论证写作和团队沟通。</p><p>我使用Excel整理研究材料，没有真实企业合规实习经历。</p></html>');
  const sourcePdf = await fixture.pdf({ format: 'A4' });
  await fixture.close();
  writeFileSync(resolve(dir, 'source-resume.pdf'), sourcePdf);
  const uploadPending = page.waitForResponse(response => response.url().endsWith('/api/resume-import'));
  await page.getByLabel('上传基础简历', { exact: true }).setInputFiles({ name: '基础简历.pdf', mimeType: 'application/pdf', buffer: sourcePdf });
  const uploaded = await uploadPending;
  assert.ok(uploaded.ok(), JSON.stringify(await uploaded.json()));
  state = await uploaded.json();
  assert.equal(state.profile.name, '');
  assert.equal(state.resumeImport?.proposedProfile.name, '苏禾');
  assert.equal(state.resumeImport?.proposedProfile.major, '法学');
  assert.equal(state.resumeImport?.proposedProfile.email, 'suhe@example.com');
  assert.doesNotMatch(state.resumeImport!.proposedProfile.experienceText, /13800000000|基础简历/);
  assert.match(state.resumeImport!.proposedProfile.experienceText, /隐私政策研究/);
  await page.screenshot({ path: resolve(dir, 'import-preview.png'), fullPage: true });
  await clickAction('确认导入并梳理经历', 'accept_resume_import');
  for (const _fact of state.profile.facts) await clickAction('确认属实', 'update_fact');
  await page.getByRole('button', { name: /方向与公司/ }).first().click();
  await page.getByLabel('方向探索消息').fill('我学法学，不想只考虑律师。我喜欢研究和写作，愿意了解互联网和出海制造业，更看重成长。');
  await clickAction('发送想法', 'career_chat');
  assert.ok(state.exploration?.directions.some(d => /互联网/.test(d.industry) && /合规/.test(d.role)));
  assert.ok(state.exploration?.directions.some(d => /制造/.test(d.industry) && /合规/.test(d.role)));
  await page.getByRole('checkbox', { name: /选择方向：.*互联网/ }).check();
  await page.getByRole('checkbox', { name: /选择方向：.*制造/ }).check();
  await clickAction('确认所选方向', 'select_directions');
  await clickAction('发现公司与岗位', 'recommend_companies');
  const candidates = state.exploration!.companies;
  assert.ok(candidates.every(c => !c.selected && c.hiringStatus === 'unverified'));
  const chosen = [candidates.find(c => /互联网/.test(c.industry))!, candidates.find(c => /制造/.test(c.industry))!];
  for (const company of candidates) {
    assert.equal(await page.getByTestId('job-swipe-card').getAttribute('data-candidate-id'), company.id);
    await clickAction(chosen.some(item => item.id === company.id) ? '喜欢这个岗位' : '跳过这个岗位', 'swipe_company');
  }
  assert.equal(state.exploration!.companies.filter(c => c.selected).length, 2);
  await page.screenshot({ path: resolve(dir, 'career-companies.png'), fullPage: true });
  await clickAction('补充 JD 并准备', 'open_company');
  await page.getByTestId('resume-preparation').waitFor();
  assert.equal(state.resumes.length, 0);
  assert.equal(state.job.text, '', 'Company exploration must not invent a hiring JD');
  await page.getByLabel('简历工作区岗位 JD', { exact: true }).fill('合成测试招聘要求：法学本科在读，协助检索公开隐私政策，使用 Excel 整理对比表，支持团队研究。');
  await clickAction('保存完整 JD', 'save_job');
  await clickAction('生成岗位简历', 'generate_resume');
  const initialResume = structuredClone(state.resumes.at(-1)!);
  assert.equal(initialResume.job.sourceKind, 'user_jd');
  await page.getByLabel('简历修改要求').fill('把配色改成海军蓝，再帮我精简简历内容');
  await clickAction('发送修改要求', 'chat_resume_edit');
  assert.equal(state.resumes.at(-1)!.document!.accent, 'navy');
  assert.equal(state.resumes.at(-1)!.approved, false);
  assert.equal(state.resumes.at(-1)!.parentId, initialResume.id);
  await page.getByRole('tab', { name: '网页编辑', exact: true }).click();
  await page.getByLabel('个人简介（选填）', { exact: true }).fill('法学背景，关注隐私政策与产品合规，具备课程研究和资料整理经历。');
  await clickAction('保存新版本', 'save_resume_edit');
  const resume = state.resumes.at(-1)!;
  assert.equal(resume.approved, false);
  assert.match(resume.document!.summary, /法学背景/);
  assert.deepEqual(state.resumes.find(r => r.id === initialResume.id)!.document, initialResume.document);
  const pdfResponse = await fetch(`${base}/api/resumes/${resume.id}/pdf`);
  assert.equal(pdfResponse.status, 200);
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  assert.ok(pdf.length > 1000); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  writeFileSync(resolve(dir, 'resume.pdf'), pdf);
  const exported = await parseResumeFile({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf });
  assert.match(exported.text, /法学背景/);
  assert.match(exported.text, /苏禾/);
  await clickAction('确认内容准确', 'approve_resume');
  await clickAction('准备模拟申请', 'prepare_application');
  const application = state.applications[0];
  await clickAction('自动填写测试表单', 'fill_application');
  assert.equal(state.applications[0].status, 'filled', state.applications[0].error);
  assert.equal((await fetch(`${base}/api/applications/${application.id}/evidence`)).status, 200);
  await page.getByRole('button', { name: '核对并模拟提交', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByRole('button', { name: '确认并模拟提交', exact: true }).isDisabled(), true);
  await dialog.getByRole('checkbox').check();
  await clickAction('确认并模拟提交', 'submit_application');
  assert.equal(state.applications[0].status, 'confirmed', state.applications[0].error);
  assert.match(state.applications[0].receipt!, /^DEMO-/);
  assert.equal(readdirSync(resolve(dir, 'sandbox-attachments')).length, 1);
  const duplicate = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'submit_application', applicationId: application.id, confirmed: true, expectedRevision: state.revision }) });
  assert.equal(duplicate.status, 400);
  await page.getByRole('button', { name: /面试练习/ }).first().click();
  await clickAction('开始面试练习', 'start_interview');
  await page.getByLabel('面试回答', { exact: true }).fill('我负责整理同学访谈反馈，用 Excel 合并重复需求，并和开发同学讨论优先级。最后交付了一份需求清单，没有可靠的提升比例数据。');
  await clickAction('发送回答', 'answer_interview');
  assert.equal(state.interview?.messages.length, 3);
  const persisted = await (await fetch(`${base}/api/state`)).json();
  assert.equal(persisted.applications[0].receipt, state.applications[0].receipt);
  assert.equal(persisted.interview.messages.length, 3);

  await page.getByRole('button', { name: /我的经历/ }).first().click();
  await page.screenshot({ path: resolve(dir, 'desktop.png'), fullPage: true });
  for (const name of ['方向与公司', '岗位简历', '投递记录', '面试练习']) {
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(dir, 'mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'Mobile layout overflows horizontally');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['real PDF import and mapped fields', 'law cross-industry career dialogue', 'swipe shortlist to resume', 'conversational resume edit', 'manual edit with immutable history', 'PDF text matches edit', 'explicit submit confirmation', 'data persistence', 'real browser fill and PDF upload to local sandbox', 'receipt verification', 'duplicate prevention', 'interview', 'five screens', 'mobile overflow', 'cross-origin rejection'], artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(dir, 'server.log'), serverOutput);
  throw error;
} finally {
  await browser?.close();
  if (child.connected) child.send('shutdown');
  for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await sleep(250);
  if (child.exitCode === null) child.kill();
}
