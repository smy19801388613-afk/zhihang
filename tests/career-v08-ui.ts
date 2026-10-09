import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../server/store.ts';
import { exampleProfile } from '../server/workflow.ts';
import { createExperienceAgentFixture } from '../server/experience-agent.ts';
import type { Action, WorkspaceState } from '../shared/types.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'career-v08-ui-'));
const store = new Store(resolve(dir, 'zhihang.sqlite'));
const initial = store.read();
initial.profile = { ...exampleProfile, major: '法学', experienceText: '校园经历\n2024.09—2025.06  学生会外联部｜小组长\n负责赞助沟通和资料整理。\n\n项目经历\n2025.03—2025.06  市场研究课程项目｜成员\n负责访谈同学并整理课程报告。', facts: [{ id: 'old', text: '原先确认的合成事实', source: '合成原文', confirmed: true }] };
initial.exploration!.messages = [{ role: 'user', content: '旧聊天' }, { role: 'assistant', content: '重复背景的旧回复' }];
initial.exploration!.companies = [{ id: 'saved', name: '已保存的合成公司', industry: '互联网', role: '运营', rationale: '', requirements: [], sourceLabel: '公司探索', careerUrl: 'https://example.com/careers', checkedAt: '2026-01-01', hiringStatus: 'unverified', selected: true, decision: 'like' }];
store.save(initial, initial.revision); store.close();
const requests: any[] = [];
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requests.push(body);
  const content = body.messages[1].content;
  const data = JSON.parse(typeof content === 'string' ? content : content[0].text).data;
  if (data.agentTask === 'experience') { const output = createExperienceAgentFixture(data); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })); return; }
  assert.ok(data.conversationPlan, 'This fixture expects career chat or experience organization');
  const reply = { message: '可以比较海洋科研机构和考古科研机构的资料研究岗位，日常任务涉及文献检索、访谈记录和材料对照。先检查岗位要求的专业限制，再决定是否继续投入；附件只作为参考，不会当成已确认的个人经历。已有方向可进入下一步。', directions: [{ id: 'marine', industry: '海洋科考服务', role: '资料研究助理', rationale: '合成方向，待核对', transferableSkills: ['资料整理'], gaps: ['领域知识待核对'], entryRequirements: '以实际JD为准', salaryContext: '未核实' }] };
  if (requests.filter(body => { const parts = body.messages[1].content; return JSON.parse(typeof parts === 'string' ? parts : parts[0].text).data.conversationPlan; }).length > 1) reply.directions = [{ ...reply.directions[0], id: 'archaeology', industry: '考古科研服务', role: '文献研究助理' }];
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] }));
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
const port = (reserve.address() as { port: number }).port; await new Promise<void>(done => reserve.close(() => done()));
const base = `http://127.0.0.1:${port}`;
let serverLog = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, MODEL_API_KEY: 'synthetic-test-key', MODEL_NAME: 'fixture', JOB_DISCOVERY_ENABLED: 'false', JOBSPY_ENABLED: 'false' } });
child.stdout?.on('data', data => serverLog += data); child.stderr?.on('data', data => serverLog += data);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/status`)).ok) break; } catch {} await sleep(200); }
  const read = async () => await (await fetch(`${base}/api/state`)).json() as WorkspaceState;
  browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  async function click(name: string, type: Action['type']) {
    const pending = page!.waitForResponse(response => response.url().endsWith('/api/actions') && response.request().postDataJSON()?.type === type);
    await page!.getByRole('button', { name, exact: true }).first().click(); const result = await pending;
    assert.equal(result.status(), 200, await result.text()); await page!.waitForFunction(() => !document.querySelector('.busy-indicator'));
    return await read();
  }
  let state = await click('重新检查分段', 'preview_fact_split');
  assert.equal(state.profile.facts[0].confirmed, true); assert.ok(state.factPreview!.facts.length >= 2);
  await page.getByTestId('fact-split-preview').screenshot({ path: resolve(dir, 'split-preview.png') });
  state = await click('确认替换，重新审核', 'apply_fact_split');
  assert.ok(state.profile.facts.every(fact => !fact.confirmed));
  for (const _fact of state.profile.facts) state = await click('确认属实', 'update_fact');
  const profileBefore = structuredClone(state.profile);
  await page.getByRole('button', { name: /方向与公司/ }).first().click();
  await page.getByRole('button', { name: '清空聊天', exact: true }).click();
  state = await click('确认清空聊天', 'clear_career_chat');
  assert.equal(state.exploration!.messages.length, 0); assert.equal(state.exploration!.companies[0].selected, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lMsAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('聊天附件', { exact: true }).setInputFiles([{ name: '参考岗位.txt', mimeType: 'text/plain', buffer: Buffer.from('这是参考岗位资料，不是已经确认的个人经历。') }, { name: '参考截图.png', mimeType: 'image/png', buffer: png }]);
  await page.locator('.career-attachment').filter({ hasText: '参考截图.png' }).waitFor();
  await page.getByLabel('方向探索消息').fill('我的专业能干什么，请结合附件比较研究方向。');
  state = await click('发送想法', 'career_chat');
  assert.equal(state.exploration!.messages[0].attachments!.length, 2);
  assert.deepEqual(state.profile, profileBefore);
  assert.ok(requests.some(body => Array.isArray(body.messages[1].content) && body.messages[1].content.some((part: any) => part.type === 'image_url')));
  state = await click('结束探索，进入下一步', 'finish_career_chat');
  assert.equal(state.exploration!.conversationPhase, 'ready');
  await page.getByRole('checkbox', { name: /选择方向：海洋科考服务/ }).check();
  await page.getByLabel('方向探索消息').fill('换个方向，请分析考古科研服务的文献研究助理。');
  state = await click('发送想法', 'career_chat');
  assert.equal(await page.getByRole('checkbox', { name: /选择方向：海洋科考服务/ }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: /选择方向：考古科研服务/ }).isChecked(), false);
  await page.getByRole('checkbox', { name: /选择方向：考古科研服务/ }).check();
  state = await click('发现公司与岗位', 'recommend_companies');
  assert.equal(state.exploration!.jobSearch!.sources.find(source => source.id === 'company-directory')?.status, 'unsupported');
  assert.equal(state.exploration!.companies.find(company => company.id === 'saved')!.selected, true);
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.locator('.career-next').screenshot({ path: resolve(dir, 'next-step.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: resolve(dir, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', checks: ['fact boundary preview and explicit replacement', 'clear chat retains profile and saved likes', 'document and native image upload through isolated API and actual local model transport', 'attachments never confirm profile facts', 'explicit finish signal and one-click direction-to-job step', 'empty catalog keeps saved jobs and returns source status rather than page error', 'mobile no overflow'], externalModel: false, artifacts: dir }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir }));
} catch (error) { await page?.screenshot({ path: resolve(dir, 'failure.png'), fullPage: true }).catch(() => {}); writeFileSync(resolve(dir, 'server.log'), serverLog); throw error; }
finally { await browser?.close(); if (child.connected) child.send('shutdown'); for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(200); if (child.exitCode === null) child.kill(); await new Promise<void>(done => provider.close(() => done())); }
