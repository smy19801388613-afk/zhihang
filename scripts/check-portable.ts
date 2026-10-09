import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { WorkspaceState } from '../shared/types.ts';
import { EXTENSION_PACKAGE_FILES } from '../server/extension-package.ts';

// Run only after build-portable completed. All writes stay in a newly extracted
// copy; no original data, credentials, paired browsers, or live API is used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.platform, 'win32', 'The portable launcher check requires Windows');
const build = JSON.parse(await readFile(join(root, 'releases/latest-build.json'), 'utf8')) as { zipPath: string; version: string; sha256: string };
const zipPath = resolve(process.argv[2] || build.zipPath);
const bytes = await readFile(zipPath);
const zipHash = createHash('sha256').update(bytes).digest('hex');
if (!process.argv[2]) assert.equal(zipHash, build.sha256, 'Archive must match the completed build report');
await mkdir(join(root, 'test-results'), { recursive: true });
const reportDir = await mkdtemp(join(root, 'test-results', 'portable-'));
const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
const entries = Object.values(archive.files).filter(entry => !entry.dir);
const prefixes = [...new Set(entries.map(entry => entry.name.split('/')[0]))];
assert.equal(prefixes.length, 1, 'One self-contained release root is required');
const prefix = prefixes[0];
assert.match(prefix, /^zhihang-[\d.]+-windows-x64$/u);
const allowedDirectories = new Set(['server', 'shared', 'dist', 'scripts', 'extensions', 'runtime', 'node_modules']);
const allowedRootFiles = new Set(['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.txt', '启动职航.cmd', '停止职航.cmd', '使用说明.txt', 'RELEASE.json']);
for (const entry of entries) {
  const original = entry.unsafeOriginalName || entry.name;
  assert.ok(original === entry.name && !original.includes('\\') && !original.split('/').includes('..'), 'ZIP traversal rejected');
  const name = entry.name.slice(prefix.length + 1);
  const top = name.split('/')[0];
  assert.ok(allowedDirectories.has(top) || allowedRootFiles.has(name) || /^zhihang-capture-v[\d.]+\.zip$/u.test(name), `Unexpected release entry: ${name}`);
  assert.ok(!/^(?:data|models|cookies|test-results|\.git|\.codex|\.venv-jobspy)(?:\/|$)|^\.env(?:$|\.)/u.test(name), 'User/runtime data must not enter the archive');
  assert.ok(!(typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0xf000) === 0xa000), 'ZIP symlinks rejected');
}
async function extract(folder: string) {
  await mkdir(folder, { recursive: true });
  for (const entry of entries) {
    const name = entry.name.slice(prefix.length + 1);
    const target = resolve(folder, name); const inside = relative(folder, target);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Extraction must remain inside the new copy');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'));
  }
  return folder;
}
const copy = await extract(join(reportDir, '新的目录 中文 空格', prefix));
const otherCopy = join(reportDir, '另一份副本 空格', prefix);
const runtime = join(copy, 'runtime/node.exe');
await access(runtime); await access(join(copy, 'node_modules/tsx/dist/loader.mjs'));
const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
const powershell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const cleanEnvironment: NodeJS.ProcessEnv = {};
for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'ProgramFiles(x86)', 'CommonProgramFiles']) {
  const match = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase());
  if (match && process.env[match]) cleanEnvironment[key] = process.env[match];
}
cleanEnvironment.PATH = [join(systemRoot, 'System32'), join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';');
cleanEnvironment.JOB_DISCOVERY_ENABLED = 'false'; cleanEnvironment.JOBSPY_ENABLED = 'false';
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const checks: string[] = [];
const port = await new Promise<number>(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const value = (server.address() as { port: number }).port; server.close(() => done(value)); }); });
const base = `http://127.0.0.1:${port}`;
const expectedInstallationId = createHash('sha256').update(copy.toLowerCase()).digest('hex').slice(0, 16);
let direct: ChildProcess | undefined; let launcherStarted = false; let logs = '';

async function command(file: string, args: string[], cwd: string, env = cleanEnvironment, timeoutMs = 60000) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Owned test command timed out')); }, timeoutMs);
    child.stdout.on('data', value => { stdout += String(value); }); child.stderr.on('data', value => { stderr += String(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
async function json(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(15000), headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, 200, value.error || path); return value;
}
async function ready() {
  for (let count = 0; count < 100; count++) {
    if (direct && direct.exitCode !== null) throw new Error('Portable server exited before readiness');
    try { const status = await json('/api/status'); if (status.installationId === expectedInstallationId) return status; } catch {}
    await sleep(150);
  }
  throw new Error('Portable server did not start');
}
async function startDirect() {
  direct = spawn(runtime, ['--import', 'tsx', 'server/index.ts'], { cwd: copy, env: { ...cleanEnvironment, PORT: String(port), DATA_DIR: join(copy, 'data') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  direct.stdout?.on('data', value => { logs += String(value); }); direct.stderr?.on('data', value => { logs += String(value); });
  return await ready();
}
async function stopDirect() {
  if (direct && direct.exitCode === null) {
    if (direct.connected) direct.send('shutdown');
    for (let count = 0; count < 50 && direct.exitCode === null; count++) await sleep(100);
    if (direct.exitCode === null) direct.kill();
  }
  direct = undefined;
}
async function stopLauncher() {
  if (!launcherStarted) return;
  const stopped = await command(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(copy, 'scripts/stop.ps1')], copy);
  assert.equal(stopped.code, 0, 'Only the test copy must be stopped'); launcherStarted = false;
  for (let count = 0; count < 30; count++) { try { await fetch(base + '/api/status', { signal: AbortSignal.timeout(300) }); } catch { return; } await sleep(100); }
  throw new Error('Test copy did not stop');
}

try {
  const resolution = await command(runtime, ['--input-type=module', '-e', "console.log(JSON.stringify({node:process.execPath,tsx:import.meta.resolve('tsx')}))"], copy);
  assert.equal(resolution.code, 0); const modulePaths = JSON.parse(resolution.stdout);
  assert.equal(resolve(modulePaths.node), runtime);
  assert.ok(fileURLToPath(modulePaths.tsx).startsWith(join(copy, 'node_modules')), 'Dependencies must resolve inside the extracted copy');
  checks.push('ZIP extracted under a new Chinese-and-space path; bundled runtime and bundled dependencies verified');

  const status = await startDirect();
  assert.equal(status.mode, 'demo'); assert.equal(status.modelConfigured, false); assert.equal(status.version, build.version);
  let state = await json('/api/state') as WorkspaceState;
  assert.deepEqual(state.profile.facts, []); assert.ok(Object.values(state.profile).every(value => Array.isArray(value) ? value.length === 0 : value === ''));
  assert.equal(state.resumes.length, 0); assert.equal(state.applications.length, 0);
  const settings = await json('/api/model-settings'); assert.equal(settings.mode, 'demo'); assert.equal(settings.hasApiKey, false);
  assert.deepEqual((await json('/api/browser-connections')).connections, []);
  const extensionResponse = await fetch(base + '/api/browser-extension/download', { headers: { Origin: base } }); assert.equal(extensionResponse.status, 200);
  const extension = await JSZip.loadAsync(await extensionResponse.arrayBuffer());
  assert.deepEqual(Object.keys(extension.files).sort(), EXTENSION_PACKAGE_FILES.map(name => `zhihang-capture/${name}`).sort());
  checks.push('Fresh blank profile, demo mode, no API key, no browser connections, extension ZIP download verified');

  const act = async (action: Record<string, unknown>) => { state = await json('/api/actions', 'POST', { ...action, expectedRevision: state.revision }); };
  await act({ type: 'load_example' });
  const { facts: _facts, ...profile } = state.profile;
  await act({ type: 'extract_profile', profile });
  for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  await act({ type: 'analyze_job' });
  await act({ type: 'preview_resume_design', name: '便携版设计测试', preset: 'classic', instructions: '采用衬线字体，教育背景放最后，尽量一页。' });
  assert.equal(state.resumeDesign?.preview?.mode, 'demo');
  await act({ type: 'save_resume_design', setDefault: true });
  await act({ type: 'generate_resume' });
  assert.ok(state.analysis); assert.ok(state.resumes.length > 0);
  const designed = state.resumes.at(-1)!;
  assert.equal(designed.document?.design?.fontFamily, 'serif');
  assert.equal(designed.designSkill?.id, state.resumeDesign?.defaultSkillId);
  assert.ok(['passed', 'warning'].includes(designed.quality?.status || ''), JSON.stringify(designed.quality));
  assert.equal(designed.quality?.textComplete, true);
  const exported = await fetch(`${base}/api/resumes/${designed.id}/pdf`);
  assert.equal(exported.status, 200); assert.ok((await exported.arrayBuffer()).byteLength > 1000);
  await act({ type: 'generate_general_resume', name: '便携通用简历', focus: '展示真实校园实践' });
  assert.equal(state.resumes.at(-1)!.scope?.kind, 'general');
  assert.equal(state.resumes.at(-1)!.job.company, '');
  assert.equal(state.resumes.at(-1)!.quality?.textComplete, true);
  const persisted = JSON.stringify(state); const resumeCount = state.resumes.length, factCount = state.profile.facts.length;
  await stopDirect(); await startDirect();
  assert.equal(JSON.stringify(await json('/api/state')), persisted);
  await stopDirect();
  checks.push('Synthetic example extraction, rule matching, design parsing/library/default, real serif PDF QA/export and SQLite restart persistence verified');

  await writeFile(join(copy, '.env'), `PORT=${port}\nJOB_DISCOVERY_ENABLED=false\nJOBSPY_ENABLED=false\n`);
  const noNode = await command(powershell, ['-NoProfile', '-NonInteractive', '-Command', "if ((Get-Command node.exe -ErrorAction SilentlyContinue) -or (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { exit 9 }; exit 0"], copy);
  assert.equal(noNode.code, 0, 'The launcher test PATH must contain neither Node nor npm');
  const launched = await command(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(copy, 'scripts/start.ps1'), '-NoOpenBrowser'], copy);
  await writeFile(join(reportDir, 'launcher.log'), launched.stdout + '\n' + launched.stderr);
  // A pid file is created only by this freshly extracted test copy, never production.
  launcherStarted = true;
  assert.equal(launched.code, 0, 'PowerShell portable launch failed; inspect local test logs');
  assert.equal((await ready()).installationId, expectedInstallationId);
  assert.equal(JSON.stringify(await json('/api/state')), persisted);
  checks.push('PowerShell -NoProfile -NoOpenBrowser starts the copy without Node/npm in PATH');

  await extract(otherCopy);
  await writeFile(join(otherCopy, '.env'), `PORT=${port}\nJOB_DISCOVERY_ENABLED=false\nJOBSPY_ENABLED=false\n`);
  const conflict = await command(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(otherCopy, 'scripts/start.ps1'), '-NoOpenBrowser'], otherCopy);
  assert.notEqual(conflict.code, 0, 'A second copy must reject the occupied port');
  assert.match(conflict.stderr + conflict.stdout, /another installation|occupied|端口|其他副本/iu);
  assert.equal((await json('/api/status')).installationId, expectedInstallationId);
  assert.equal(JSON.stringify(await json('/api/state')), persisted);
  checks.push('Second extracted copy rejects an occupied port and leaves the first workspace untouched');
  await stopLauncher();
  const report = { result: 'PASS', version: build.version, zipSha256: zipHash, archiveFiles: entries.length, checks, sample: { factCount, resumeCount }, realModelCalls: 0, productionDataAccessed: false, browserOpened: false, artifactDirectory: reportDir };
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(join(reportDir, 'server.log'), logs);
  await writeFile(join(reportDir, 'report.json'), JSON.stringify({ result: 'FAIL', checks, error: error instanceof Error ? error.message : 'Portable validation failed', realModelCalls: 0, productionDataAccessed: false, artifactDirectory: reportDir }, null, 2));
  throw error;
} finally {
  await stopDirect();
  await stopLauncher();
  // Leave only the isolated extracted copies and synthetic artifacts for review.
  // Never recursively delete a path derived from a release or original workspace.
}
