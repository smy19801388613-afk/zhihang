import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Action, WorkspaceState } from '../shared/types.ts';

// Real HTTP, real Chromium filling/uploading, and the local synthetic destination.
// Never uses production data, a model API, or a live recruitment website.
const root = process.cwd();
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'resume-batch-api-'));
const port = await new Promise<number>(done => {
  const socket = createServer(); socket.listen(0, '127.0.0.1', () => {
    const value = (socket.address() as { port: number }).port; socket.close(() => done(value));
  });
});
const base = `http://127.0.0.1:${port}`;
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
let child: ChildProcess | undefined, logs = '', state: WorkspaceState;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir,
      MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false' } });
  child.stdout?.on('data', chunk => { logs += chunk; }); child.stderr?.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) { assert.equal((await response.json()).mode, 'demo', 'Paid model must remain disabled'); return; }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await sleep(150);
  }
  throw new Error('Isolated batch server did not start');
}
async function stop() {
  if (child?.connected) child.send('shutdown');
  for (let count = 0; count < 60 && child?.exitCode === null; count++) await sleep(150);
  if (child?.exitCode === null) { child.kill(); await sleep(300); }
}
async function post(path: string, input: unknown, origin = base, token?: string) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}
async function act(action: Action) {
  state = await post('/api/actions', { ...action, expectedRevision: state.revision });
}
function auxiliary(applicationId: string) {
  const db = new DatabaseSync(resolve(dir, 'zhihang.sqlite'), { readOnly: true });
  try {
    return {
      token: (db.prepare('SELECT token FROM sandbox_tokens WHERE application_id=?').get(applicationId) as { token: string } | undefined)?.token,
      receipt: (db.prepare('SELECT receipt FROM sandbox_receipts WHERE application_id=?').get(applicationId) as { receipt: string } | undefined)?.receipt,
    };
  } finally { db.close(); }
}
try {
  await start(); state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.resumes.length, 0); assert.equal(state.applications.length, 0);
  await act({ type: 'load_example' }); const { facts: _facts, ...profile } = state.profile;
  await act({ type: 'extract_profile', profile });
  for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  await act({ type: 'clear_job' });
  assert.equal(state.job.title, ''); assert.equal(state.analysis, null);
  await act({ type: 'generate_general_resume', name: '合成资料运营通用简历', focus: '资料整理、活动执行与反馈整理' });
  const resume = state.resumes.at(-1)!;
  assert.equal(resume.scope?.kind, 'general'); assert.ok(resume.collectionId); assert.equal(resume.job.company, '');
  assert.equal(resume.quality?.textComplete, true); assert.equal(resume.quality?.overflow, false);
  await act({ type: 'approve_resume', resumeId: resume.id });
  const profileSnapshot = JSON.stringify(state.profile);

  // These URLs identify synthetic fixtures only; neither browser nor HTTP visits them.
  const jobs = [
    { company: '合成甲公司', title: '资料运营实习', city: '北京', jd: '协助整理用户反馈、维护报名表并更新项目文档。' },
    { company: '合成乙公司', title: '活动执行实习', city: '上海', jd: '协助活动筹备、报名表维护、内容排期及活动反馈整理。' },
  ];
  const pairingCode = await post('/api/browser-connections/pairing-code', {});
  const paired = await post('/extension/v1/pair', { code: pairingCode.code, clientName: '批量模拟集成测试' }, extensionOrigin);
  const imported = await post('/extension/v1/import', { protocolVersion: 1, requestId: randomUUID(), jobs: jobs.map((job, index) => ({
    platform: 'boss', sourceUrl: `https://www.zhipin.com/job_detail/SyntheticBatch${index + 1}.html`, capturedAt: new Date().toISOString(), pageKind: 'detail',
    fields: { ...job, salary: '180元/天', education: '本科', experience: '不限', jdComplete: true },
  })) }, extensionOrigin, paired.token);
  assert.equal(imported.imported, 2); assert.deepEqual(imported.errors, []);
  state = await (await fetch(`${base}/api/state`)).json(); const candidateIds = Object.keys(state.browserCaptures!); assert.equal(candidateIds.length, 2);
  await act({ type: 'prepare_applications', resumeId: resume.id, candidateIds });
  assert.equal(state.applications.length, 2); assert.ok(state.applications.every(application => application.resumeId === resume.id && application.status === 'prepared' && application.simulated));
  const applicationIds = state.applications.map(application => application.id);
  const targetsBefore = state.applications.map(application => structuredClone(application.targetJob));
  assert.deepEqual(new Set(state.applications.map(application => `${application.company}|${application.jobTitle}`)), new Set(jobs.map(job => `${job.company}|${job.title}`)));
  await act({ type: 'fill_applications', applicationIds });
  assert.ok(state.applications.every(application => application.status === 'filled'), JSON.stringify(state.applications.map(application => ({ status: application.status, error: application.error }))));
  for (const application of state.applications) {
    const auth = auxiliary(application.id); assert.ok(auth.token); assert.equal(auth.receipt, undefined);
    const context = await (await fetch(`${base}/api/sandbox/context?applicationId=${application.id}&token=${auth.token}`)).json();
    assert.deepEqual(context, { company: application.company, jobTitle: application.jobTitle });
    assert.equal((await fetch(`${base}/api/applications/${application.id}/evidence`)).status, 200);
  }
  await act({ type: 'submit_applications', applicationIds, confirmed: true });
  assert.ok(state.applications.every(application => application.status === 'confirmed'), JSON.stringify(state.applications.map(application => ({ status: application.status, error: application.error }))));
  assert.equal(new Set(state.applications.map(application => application.receipt)).size, 2);
  const attachments = state.applications.map(application => {
    const receipt = auxiliary(application.id).receipt; assert.equal(receipt, application.receipt); assert.ok(receipt?.startsWith('DEMO-'));
    const path = resolve(dir, 'sandbox-attachments', `${application.id}.pdf`); assert.ok(existsSync(path));
    const buffer = readFileSync(path); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(existsSync(resolve(dir, 'evidence', `${application.id}.png`)));
    return { applicationId: application.id, company: application.company, jobTitle: application.jobTitle, resumeId: application.resumeId, receipt, bytes: buffer.length, sha256: digest(buffer) };
  });
  assert.equal(attachments[0].sha256, attachments[1].sha256, 'Both actual uploads must be exactly the same PDF');
  const exported = Buffer.from(await (await fetch(`${base}/api/resumes/${resume.id}/pdf`)).arrayBuffer());
  assert.equal(digest(exported), attachments[0].sha256); assert.deepEqual(state.applications.map(application => application.targetJob), targetsBefore);

  const savedApplications = structuredClone(state.applications);
  await act({ type: 'prepare_applications', resumeId: resume.id, candidateIds });
  assert.deepEqual(state.applications, savedApplications); assert.match(state.events[0].detail, /新增 0.*跳过 2/);
  await act({ type: 'submit_applications', applicationIds, confirmed: true });
  assert.deepEqual(state.applications, savedApplications); assert.match(state.events[0].detail, /成功 0.*跳过 2/);
  assert.equal(JSON.stringify(state.profile), profileSnapshot);
  const savedState = JSON.stringify(state); await stop(); await start(); state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(JSON.stringify(state), savedState);
  for (const application of state.applications) {
    assert.equal(auxiliary(application.id).receipt, application.receipt);
    assert.equal(digest(readFileSync(resolve(dir, 'sandbox-attachments', `${application.id}.pdf`))), attachments[0].sha256);
    assert.deepEqual(application.targetJob, savedApplications.find(saved => saved.id === application.id)!.targetJob);
  }
  const report = { result: 'PASS', actualHttp: true, actualSandboxBrowser: true, actualPdfAttachments: true, isolatedData: true, paidApiCalls: 0, recruitmentWebsiteVisits: 0,
    checks: ['general resume without JD or analysis', 'explicit approval', 'two targets share one resume ID', 'batch fill and explicit confirmed submit', 'two independent verified local receipts', 'correct company and role snapshots', 'byte-identical uploaded PDFs', 'duplicate prepare and submit skipped', 'restart keeps snapshots receipts and files'], attachments, dir };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { writeFileSync(resolve(dir, 'server.log'), logs); throw error; }
finally { await stop(); }
