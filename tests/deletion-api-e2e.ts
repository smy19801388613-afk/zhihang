import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Action, WorkspaceState } from '../shared/types.ts';

// Actual HTTP routes and local sandbox browser, isolated data, no model or recruiting service.
const root = process.cwd();
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'deletion-api-'));
const port = await new Promise<number>(done => {
  const socket = createServer(); socket.listen(0, '127.0.0.1', () => {
    const value = (socket.address() as { port: number }).port; socket.close(() => done(value));
  });
});
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined, logs = '', state: WorkspaceState;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir,
      MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false' } });
  child.stdout?.on('data', chunk => { logs += chunk; }); child.stderr?.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/api/status`)).ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('Isolated deletion server did not start');
}
async function stop() {
  if (child?.connected) child.send('shutdown');
  for (let count = 0; count < 40 && child?.exitCode === null; count++) await sleep(150);
  if (child?.exitCode === null) child.kill();
}
async function request(action: Action, expected = state.revision, origin = base) {
  return fetch(`${base}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ ...action, expectedRevision: expected }) });
}
async function act(action: Action) {
  const response = await request(action); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); state = body as WorkspaceState;
}
function auxiliary(applicationId: string) {
  const db = new DatabaseSync(resolve(dir, 'zhihang.sqlite'), { readOnly: true });
  try { return { token: (db.prepare('SELECT token FROM sandbox_tokens WHERE application_id=?').get(applicationId) as { token: string } | undefined)?.token,
    receipt: db.prepare('SELECT receipt FROM sandbox_receipts WHERE application_id=?').get(applicationId) }; }
  finally { db.close(); }
}
try {
  await start();
  assert.equal((await (await fetch(`${base}/api/status`)).json()).mode, 'demo');
  state = await (await fetch(`${base}/api/state`)).json();
  await act({ type: 'load_example' });
  const { facts: _facts, ...profile } = state.profile;
  await act({ type: 'extract_profile', profile });
  for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  await act({ type: 'analyze_job' }); await act({ type: 'generate_resume' });
  const resume = state.resumes.at(-1)!; const job = structuredClone(state.job);
  await act({ type: 'approve_resume', resumeId: resume.id });
  const profileSnapshot = JSON.stringify(state.profile);
  await act({ type: 'prepare_application', resumeId: resume.id });
  const filledId = state.applications[0].id;
  await act({ type: 'fill_application', applicationId: filledId });
  assert.equal(state.applications[0].status, 'filled', state.applications[0].error);
  const filledToken = auxiliary(filledId).token!;
  await act({ type: 'delete_application', applicationId: filledId });
  assert.equal((await fetch(`${base}/api/sandbox/context?applicationId=${filledId}&token=${filledToken}`)).status, 403);
  assert.equal(existsSync(resolve(dir, 'evidence', `${filledId}.png`)), false);
  await act({ type: 'prepare_application', resumeId: resume.id });
  const app = state.applications[0];
  await act({ type: 'fill_application', applicationId: app.id });
  assert.equal(state.applications[0].status, 'filled', state.applications[0].error);
  await act({ type: 'submit_application', applicationId: app.id, confirmed: true });
  assert.equal(state.applications[0].status, 'confirmed', state.applications[0].error);
  const savedAuth = auxiliary(app.id); assert.ok(savedAuth.token && savedAuth.receipt);
  const evidence = resolve(dir, 'evidence', `${app.id}.png`), attachment = resolve(dir, 'sandbox-attachments', `${app.id}.pdf`);
  assert.ok(existsSync(evidence) && existsSync(attachment));
  assert.equal((await request({ type: 'delete_resume', resumeId: resume.id })).status, 409);
  assert.equal((await request({ type: 'delete_application', applicationId: app.id }, state.revision - 1)).status, 409);
  assert.equal((await request({ type: 'delete_application', applicationId: app.id }, state.revision, 'https://untrusted.example')).status, 403);
  assert.ok(existsSync(evidence) && existsSync(attachment)); assert.deepEqual(auxiliary(app.id), savedAuth);
  await act({ type: 'clear_job' });
  assert.equal(state.job.title, ''); assert.equal(state.activeResumeId, null);
  assert.ok(state.resumes.some(item => item.id === resume.id)); assert.ok(state.applications.some(item => item.id === app.id));
  await act({ type: 'delete_application', applicationId: app.id });
  assert.equal(state.applications.length, 0); assert.equal(state.resumes.length, 1);
  assert.deepEqual(auxiliary(app.id), { token: undefined, receipt: undefined });
  assert.equal(existsSync(evidence), false); assert.equal(existsSync(attachment), false);
  assert.equal((await fetch(`${base}/api/applications/${app.id}/evidence`)).status, 404);
  assert.equal((await fetch(`${base}/api/sandbox/context?applicationId=${app.id}&token=${savedAuth.token}`)).status, 403);
  assert.equal((await fetch(`${base}/api/resumes/${resume.id}/pdf`)).status, 200);
  await act({ type: 'delete_resume', resumeId: resume.id });
  assert.equal((await fetch(`${base}/api/resumes/${resume.id}/pdf`)).status, 404);
  assert.equal(state.resumes.length, 0); assert.equal(JSON.stringify(state.profile), profileSnapshot);
  const after = JSON.stringify(state);
  await stop(); await start(); state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(JSON.stringify(state), after);
  await act({ type: 'save_job', job }); await act({ type: 'analyze_job' }); await act({ type: 'generate_resume' });
  assert.ok(state.resumes[0].version > resume.version, 'Version numbers cannot be reused after deletion and restart');
  const report = { result: 'PASS', actualHttp: true, actualSandboxBrowser: true, isolatedData: true, paidApiCalls: 0,
    checks: ['filled and confirmed application deletion', 'token and receipt revocation', 'only generated evidence and PDF removed', 'resume dependency rejection',
      'stale revision and cross-origin rejection preserve data', 'cleared current job retains history', 'deleted PDF and evidence return 404', 'profile preserved', 'restart persistence', 'monotonic resume versions'], dir };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { writeFileSync(resolve(dir, 'server.log'), logs); throw error; }
finally { await stop(); }
