import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureBatch, CaptureJob } from '../shared/browser-capture.ts';
import type { WorkspaceState } from '../shared/types.ts';

const root = process.cwd(); mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results/capture-api-'));
const port = await new Promise<number>(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const n = (server.address() as { port: number }).port; server.close(() => done(n)); }); });
const base = `http://127.0.0.1:${port}`; const origin = 'chrome-extension://' + 'a'.repeat(32); const other = 'chrome-extension://' + 'b'.repeat(32);
let logs = ''; let child: ReturnType<typeof spawn>;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(port), DATA_DIR: dir, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', JOB_DISCOVERY_ENABLED: 'false', JOBSPY_ENABLED: 'false' } });
  child.stdout?.on('data', c => { logs += String(c); }); child.stderr?.on('data', c => { logs += String(c); });
  for (let i = 0; i < 60; i++) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(base + '/api/status')).ok) return; } catch {} await sleep(150); }
  throw Error('test service did not start');
}
async function stop() { if (child && child.exitCode === null) { const exited = new Promise<void>(done => child.once('exit', () => done())); child.send!('shutdown'); await exited; } }
async function json(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, body: await response.json().catch(() => null) };
}
const job: CaptureJob = { platform: 'boss', sourceUrl: 'https://www.zhipin.com/job_detail/synthetic001.html?from=tracking', capturedAt: new Date().toISOString(), pageKind: 'list', fields: { company: '合成公司', title: '产品运营实习生', city: '北京', salary: '200元/天', education: '本科', experience: '在校生', jd: '协助团队整理用户反馈。', jdComplete: false } };
const batch = (jobs: CaptureJob[] = [structuredClone(job)]): CaptureBatch => ({ protocolVersion: 1, requestId: randomUUID(), jobs });
const checks: string[] = [];
try {
  await start();
  for (const path of ['/api/state', '/api/model-settings', '/api/browser-connections']) {
    const denied = await json(path, 'GET', undefined, { Origin: origin }); assert.equal(denied.response.status, 403); assert.equal(denied.response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await json('/api/actions', 'POST', { type: 'load_example' }, { Origin: origin })).response.status, 403);
  assert.equal((await json('/extension/v1/state', 'GET', undefined, { Origin: origin })).response.status, 403);
  assert.equal((await json('/extension/v1/pair', 'POST', { code: 'BAD', clientName: 'Fixture' }, { Origin: 'https://www.zhipin.com' })).response.status, 403);
  assert.equal((await json('/api/browser-connections/pairing-code', 'POST', {})).response.status, 403);
  const preflight = await fetch(base + '/extension/v1/import', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  checks.push('extension-only narrow CORS; personal state, settings and actions remain denied');
  const code = await json('/api/browser-connections/pairing-code', 'POST', {}, { Origin: base }); assert.equal(code.response.status, 200);
  const paired = await json('/extension/v1/pair', 'POST', { code: code.body.code, clientName: 'Synthetic Edge' }, { Origin: origin }); assert.equal(paired.response.status, 200);
  const token = paired.body.token; const authorized = { Origin: origin, Authorization: `Bearer ${token}` };
  assert.equal((await json('/extension/v1/pair', 'POST', { code: code.body.code, clientName: 'Replay' }, { Origin: origin })).response.status, 401);
  assert.equal((await json('/extension/v1/status', 'POST', {}, authorized)).body.connected, true);
  assert.equal((await json('/extension/v1/import', 'POST', batch(), { Origin: origin })).response.status, 401);
  assert.equal((await json('/extension/v1/import', 'POST', batch(), { ...authorized, Origin: other })).response.status, 403);
  checks.push('single-use pairing; invalid credential and wrong extension origin rejected');
  assert.equal((await json('/extension/v1/import', 'POST', { ...batch(), revision: 0 }, authorized)).response.status, 400);
  assert.equal((await json('/extension/v1/import', 'POST', batch(Array.from({ length: 21 }, () => structuredClone(job))), authorized)).response.status, 400);
  assert.equal((await json('/extension/v1/import', 'POST', { blob: 'x'.repeat(530_000) }, authorized)).response.status, 413);
  const badSource = await json('/extension/v1/import', 'POST', batch([{ ...job, sourceUrl: 'https://example.com/job_detail/synthetic001.html' }]), authorized);
  assert.ok(badSource.response.status === 400 || badSource.body.imported === 0 && badSource.body.errors.length > 0);
  checks.push('strict fields, platform URL validation, batch count and payload size limits');
  const legacy58: CaptureJob = { ...job, platform: '58', sourceUrl: 'https://sh.58.com/lvshi/12345678901234x.shtml' };
  const beforeRetiredSource = (await json('/api/state')).body;
  for (const jobs of [[legacy58], [job, legacy58]]) {
    const retired = await json('/extension/v1/import', 'POST', batch(jobs), authorized);
    assert.equal(retired.response.status, 400); assert.match(retired.body.error, /仅支持 BOSS直聘/);
    assert.deepEqual((await json('/api/state')).body, beforeRetiredSource);
  }
  checks.push('authenticated old-extension 58 imports and mixed batches rejected atomically');
  const first = batch(); const imported = await json('/extension/v1/import', 'POST', first, authorized); assert.equal(imported.response.status, 200); assert.equal(imported.body.imported, 1);
  assert.deepEqual(Object.keys(imported.body).sort(), ['requestId', 'imported', 'updated', 'duplicates', 'errors'].sort());
  assert.deepEqual((await json('/extension/v1/import', 'POST', first, authorized)).body, imported.body);
  assert.equal((await json('/extension/v1/import', 'POST', { ...first, jobs: [{ ...job, fields: { ...job.fields, salary: '300元/天' } }] }, authorized)).response.status, 409);
  const duplicate = await json('/extension/v1/import', 'POST', batch(), authorized); assert.equal(duplicate.body.duplicates, 1);
  let state = (await json('/api/state')).body as WorkspaceState;
  const id = Object.keys(state.browserCaptures!)[0]; assert.equal(state.browserCaptures![id].fields.jdComplete, false);
  async function act(action: Record<string, unknown>) { const result = await json('/api/actions', 'POST', { ...action, expectedRevision: state.revision }); assert.equal(result.response.status, 200, result.body?.error); state = result.body; return state; }
  await act({ type: 'save_browser_capture', captureId: id, edits: { salary: '用户核实：200元/天', company: '合成公司（已核对）' } });
  const full = { ...job, pageKind: 'detail' as const, fields: { ...job.fields, salary: '999元/天', jdComplete: true, jd: '岗位职责：协助整理用户反馈和需求，参与内容运营与活动执行，使用 Excel 整理数据。任职要求：本科及以上在校生，表达清晰，有校园活动或课程项目经历优先。每周至少4天，连续3个月。' } };
  assert.equal((await json('/extension/v1/import', 'POST', batch([full]), authorized)).body.updated, 1);
  state = (await json('/api/state')).body;
  assert.equal(state.browserCaptures![id].fields.salary, '用户核实：200元/天'); assert.equal(state.browserCaptures![id].fields.company, '合成公司（已核对）'); assert.equal(state.browserCaptures![id].fields.jdComplete, true);
  checks.push('deduplication, request replay safety, partial detail completion, and user edits protected');
  const two = [2, 3].map(n => batch([{ ...full, sourceUrl: `https://www.zhipin.com/job_detail/synthetic00${n}.html` }]));
  const results = await Promise.all(two.map(body => json('/extension/v1/import', 'POST', body, authorized)));
  for (let i = 0; i < results.length; i++) { if (results[i].response.status === 409) results[i] = await json('/extension/v1/import', 'POST', two[i], authorized); assert.equal(results[i].response.status, 200); }
  state = (await json('/api/state')).body; assert.equal(Object.keys(state.browserCaptures!).length, 3);
  await act({ type: 'load_example' });
  const { facts: _facts, ...profile } = state.profile;
  await act({ type: 'extract_profile', profile });
  for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  await act({ type: 'swipe_company', companyId: id, decision: 'like' });
  await act({ type: 'activate_company', companyId: id });
  assert.equal(state.resumes.at(-1)!.job.sourceKind, 'browser_capture'); assert.ok(state.analysis); assert.equal(state.resumes.at(-1)!.job.candidateId, id);
  checks.push('concurrent imports preserved; captured job uses existing swipe, matching and resume pipeline in demo mode');
  const profileBefore = structuredClone(state.profile); const resumesBefore = structuredClone(state.resumes);
  await stop(); await start(); state = (await json('/api/state')).body;
  assert.deepEqual(state.profile, profileBefore); assert.deepEqual(state.resumes, resumesBefore); assert.equal(Object.keys(state.browserCaptures!).length, 3); assert.equal(state.browserCaptures![id].decision, 'like');
  assert.equal((await json('/extension/v1/status', 'POST', {}, authorized)).response.status, 200);
  const revoked = await json('/api/browser-connections/' + paired.body.connectionId, 'DELETE', undefined, { Origin: base }); assert.equal(revoked.response.status, 200);
  assert.equal((await json('/extension/v1/import', 'POST', batch(), authorized)).response.status, 401);
  checks.push('restart preserves imported records, swipe decisions, resumes and connection; revoke takes effect');
  const report = { result: 'PASS', websiteVerification: 'synthetic API and local fixtures only; no live website verification', checks, artifacts: dir };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { writeFileSync(resolve(dir, 'server.log'), logs); throw error; }
finally { await stop(); }
