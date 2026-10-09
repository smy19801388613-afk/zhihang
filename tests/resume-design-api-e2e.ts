import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Action, ResumeVersion, WorkspaceState } from '../shared/types.ts';

// Real routes, SQLite, renderer and export. Isolated synthetic profile; no paid API calls.
const root = process.cwd();
mkdirSync(resolve(root, 'test-results'), { recursive: true });
const dir = mkdtempSync(resolve(root, 'test-results', 'design-api-'));
const port = await new Promise<number>(done => {
  const server = createServer(); server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port; server.close(() => done(port));
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
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/api/status`)).ok) return; } catch { /* Wait for this isolated child. */ }
    await sleep(150);
  }
  throw new Error('Isolated design server did not start');
}
async function stop() {
  if (child?.connected) child.send('shutdown');
  for (let i = 0; i < 40 && child?.exitCode === null; i++) await sleep(150);
  if (child?.exitCode === null) child.kill();
}
async function request(action: Action | Record<string, unknown>, revision = state.revision, origin = base) {
  return fetch(`${base}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ ...action, expectedRevision: revision }) });
}
async function act(action: Action) {
  const response = await request(action); const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); state = body;
}
async function verifyExport(resume: ResumeVersion) {
  assert.ok(['passed', 'warning'].includes(resume.quality?.status || ''), JSON.stringify(resume.quality));
  assert.equal(resume.quality?.textComplete, true); assert.equal(resume.quality?.overflow, false);
  const response = await fetch(`${base}/api/resumes/${resume.id}/pdf`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') || '', /application\/pdf/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    assert.equal(pdf.numPages, resume.quality?.pageCount);
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join('');
    const normalize = (value: string) => value.replace(/\s+/gu, '');
    for (const section of resume.document!.sections) for (const item of section.items) {
      for (const line of item.content.split(/\n+/u).filter(Boolean)) assert.ok(normalize(text).includes(normalize(line.replace(/^[-•]\s*/u, ''))), 'Export must retain each paragraph');
    }
    writeFileSync(resolve(dir, `resume-v${resume.version}.pdf`), bytes);
  } finally { await task.destroy(); }
}
try {
  await start(); state = await (await fetch(`${base}/api/state`)).json();
  await act({ type: 'load_example' });
  const { facts: _facts, ...profile } = state.profile;
  await act({ type: 'extract_profile', profile });
  for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  await act({ type: 'analyze_job' });
  const profileBefore = JSON.stringify(state.profile), analysisBefore = JSON.stringify(state.analysis);
  await act({ type: 'preview_resume_design', name: '测试一页规则', instructions: '黑白配色，尽量一页，教育背景放最后。', preset: 'compact' });
  assert.equal(state.resumeDesign?.preview?.mode, 'demo');
  assert.equal(state.resumeDesign?.preview?.design.pageGoal, 1);
  assert.equal(state.resumeDesign?.preview?.design.educationPosition, 'last');
  assert.equal(state.resumeDesign?.skills.length, 0, 'Preview cannot silently become an applied skill');
  await act({ type: 'save_resume_design', setDefault: true });
  const firstSkill = state.resumeDesign!.skills[0];
  assert.equal(state.resumeDesign?.currentSkillId, firstSkill.id); assert.equal(state.resumeDesign?.defaultSkillId, firstSkill.id);
  await act({ type: 'generate_resume' });
  const first = structuredClone(state.resumes.at(-1)!);
  assert.deepEqual(first.designSkill, firstSkill); assert.equal(first.document?.design?.educationPosition, 'last');
  await verifyExport(first);
  await act({ type: 'preview_resume_design', name: '经典测试', instructions: '使用衬线字体，教育背景放前面。', preset: 'classic' });
  await act({ type: 'save_resume_design', setDefault: false });
  const secondSkill = state.resumeDesign!.skills.at(-1)!;
  assert.equal(state.resumeDesign?.defaultSkillId, firstSkill.id);
  assert.equal((await request({ type: 'apply_resume_design', resumeId: first.id }, state.revision - 1)).status, 409);
  assert.equal((await request({ type: 'apply_resume_design', resumeId: first.id }, state.revision, 'https://untrusted.example')).status, 403);
  const bad = await request({ type: 'preview_resume_design', name: 'oversize', instructions: 'x'.repeat(12001), preset: 'clean' });
  assert.equal(bad.status, 400);
  await act({ type: 'apply_resume_design', resumeId: first.id });
  const second = structuredClone(state.resumes.at(-1)!);
  assert.equal(second.parentId, first.id); assert.deepEqual(second.document!.sections, first.document!.sections);
  assert.equal(second.document!.summary, first.document!.summary); assert.deepEqual(second.profile, first.profile);
  assert.equal(second.designSkill?.id, secondSkill.id); assert.equal(second.document!.design?.fontFamily, 'serif');
  assert.deepEqual(state.resumes[0].document, first.document); assert.deepEqual(state.resumes[0].designSkill, firstSkill);
  await verifyExport(second);
  await act({ type: 'delete_resume_design', skillId: secondSkill.id });
  assert.equal(state.resumeDesign!.skills.some(item => item.id === secondSkill.id), false);
  assert.deepEqual(state.resumes.at(-1)!.designSkill, second.designSkill, 'Deleting saved rules cannot mutate historical snapshots');
  const savedJob = structuredClone(state.job);
  await act({ type: 'clear_job' }); assert.equal(state.resumeDesign?.currentSkillId, firstSkill.id);
  assert.equal(JSON.stringify(state.profile), profileBefore); assert.equal(state.resumes.length, 2);
  await act({ type: 'save_job', job: savedJob });
  const beforeRestart = JSON.stringify(state);
  await stop(); await start(); state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(JSON.stringify(state), beforeRestart);
  assert.ok(analysisBefore.length > 10); // Analysis was present for initial generation.
  await verifyExport(state.resumes[1]);
  const report = { result: 'PASS', actualHttp: true, actualChromiumPdf: true, isolatedData: true, paidApiCalls: 0,
    checks: ['preview and explicit save', 'default and current job selection', 'generation snapshot', 'rendered PDF text and page count',
      'style-only new version', 'immutable historical styles', 'stale revision, origin, size rejection', 'library deletion', 'job switch default', 'restart persistence'], dir };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { writeFileSync(resolve(dir, 'server.log'), logs); throw error; }
finally { await stop(); }
