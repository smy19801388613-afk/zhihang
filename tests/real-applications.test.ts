import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RealApplications, extensionApplicationRouter } from '../server/real-applications.ts';
import { bytedanceTarget, type RealApplicationRun } from '../shared/real-application.ts';
import { BrowserConnections } from '../server/browser-connections.ts';
import { Store } from '../server/store.ts';
import { Workflow, type BrowserTools } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import type { ResumeVersion } from '../shared/types.ts';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
const targetId = '7246662982998313277';
const otherId = '7246662982998313288';
const url = (id = targetId) => `https://jobs.bytedance.com/campus/position/${id}/detail`;
const bytes = Buffer.from('%PDF-1.7\nSYNTHETIC TEST ONLY\n%%EOF');

function setup(t: TestContext, pdf?: (resume: ResumeVersion) => Promise<Buffer>) {
  const directory = mkdtempSync(join(tmpdir(), 'zhihang-real-applications-'));
  const path = join(directory, 'test.sqlite');
  const store = new Store(path); let now = Date.parse('2026-10-09T00:00:00Z');
  const state = store.read();
  state.profile = { name: '虚构测试人', email: 'synthetic@example.invalid', phone: '13800000000', school: '合成大学', education: '本科', graduation: '2027-06', city: '北京', availability: '每周四天', targetRole: '资料实习', experienceText: 'PRIVATE-SYNTHETIC-SOURCE', facts: [{ id: 'fact-1', text: 'PRIVATE-SYNTHETIC-FACT', source: 'PRIVATE-SYNTHETIC-SOURCE', confirmed: true }] };
  state.resumes = [{ id: randomUUID(), version: 1, createdAt: '2026-10-01T00:00:00Z', profile: structuredClone(state.profile), job: { company: '', title: '通用简历', text: '', url: '' }, scope: { kind: 'general', name: '通用简历', focus: '资料整理', targetJobs: [] }, collectionId: randomUUID(), bullets: [{ text: 'PRIVATE-SYNTHETIC-FACT', factIds: ['fact-1'] }], rationale: '', approved: true, stale: false }];
  store.save(state, state.revision);
  const render = pdf || (async () => Buffer.from(bytes));
  const runs = new RealApplications(path, store, render, () => now);
  const extras: Array<{ close(): void }> = [];
  t.after(() => { for (const extra of extras.reverse()) extra.close(); runs.close(); store.close(); const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhihang-real-applications-')) throw new Error('Unsafe cleanup'); rmSync(target, { recursive: true, force: true }); });
  const input = () => ({ resumeId: state.resumes[0].id, expectedRevision: store.read().revision, targetUrls: [url()] });
  const create = () => runs.create(input());
  const claim = async () => { const created = await create(); return { ...created, ...runs.claim(created.code, origin) }; };
  return { directory, path, store, runs, render, extras, input, create, claim, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('Bytedance targets accept only exact campus detail/apply paths on the official HTTPS origin', () => {
  const parsed = bytedanceTarget(`${url()}?source=synthetic#anchor`)!;
  assert.equal(parsed.id, targetId); assert.equal(parsed.url, url()); assert.equal(parsed.applyUrl, `https://jobs.bytedance.com/campus/resume/${targetId}/apply`);
  assert.deepEqual(bytedanceTarget(parsed.applyUrl), parsed);
  for (const invalid of [
    url().replace('https:', 'http:'), url().replace('jobs.bytedance.com', 'jobs.bytedance.com.attacker.test'), url().replace('jobs.bytedance.com', 'jobs.bytedance.com:444'),
    url().replace('https://', 'https://name:secret@'), url().replace('/campus/', '/experienced/'), url().replace('/detail', '/resume'),
    'https://jobs.bytedance.com/campus/position/123/detail', 'javascript:void(0)', 'https://jobs.bytedance.com/',
  ]) assert.equal(bytedanceTarget(invalid), undefined, invalid);
});

test('a workspace operation starting during PDF render prevents a new run from bypassing resume deletion checks', async t => {
  let busy = false; const s = setup(t, async () => { busy = true; return bytes; });
  await assert.rejects(s.runs.create(s.input(), () => { if (busy) throw new Error('工作区正在更新'); }), /工作区正在更新/);
  assert.deepEqual(s.runs.list(), []);
  assert.equal(s.store.read().resumes.length, 1);
});

test('one-use authorization codes expire and never expose plaintext secrets through list or storage', async t => {
  const s = setup(t); const created = await s.create(); const claimed = s.runs.claim(created.code.toLowerCase(), origin);
  assert.equal(claimed.token.length, 43); assert.equal(claimed.run.fields.major, '');
  assert.throws(() => s.runs.claim(created.code, origin), /已使用|无效/);
  assert.throws(() => s.runs.authorized(claimed.token, otherOrigin), /无效/);
  for (const invalid of ['', 'https://localhost:4340', 'null', 'chrome-extension://abc']) assert.throws(() => s.runs.authorized(claimed.token, invalid), /来源/);
  const db = new DatabaseSync(s.path); s.extras.push(db); const row = db.prepare('SELECT * FROM real_application_runs').get();
  assert.doesNotMatch(JSON.stringify(row), new RegExp(claimed.token)); assert.doesNotMatch(JSON.stringify(row), new RegExp(created.code));
  assert.doesNotMatch(JSON.stringify(s.runs.list()), /fields|PRIVATE-SYNTHETIC|synthetic@example/);
  s.advance(60 * 60_000); assert.throws(() => s.runs.authorized(claimed.token, origin), /过期/);
  const expired = setup(t); const second = await expired.create(); expired.advance(5 * 60_000);
  assert.throws(() => expired.runs.claim(second.code, origin), /过期/);
});

test('import-only and real-application credentials cannot access each other and fields remain narrowly scoped', async t => {
  const s = setup(t); const captures = new BrowserConnections(s.path, s.now); s.extras.push(captures);
  const paired = captures.pair(captures.createPairingCode().code, origin, '合成扩展');
  assert.throws(() => s.runs.authorized(paired.token, origin), /采集凭证|无效/);
  const claimed = await s.claim(); assert.throws(() => captures.authorize(claimed.token, origin), /凭证/);
  const authorized = s.runs.authorized(claimed.token, origin);
  assert.deepEqual(Object.keys(authorized.fields).sort(), ['name', 'email', 'phone', 'school', 'education', 'major', 'graduation', 'city', 'availability'].sort());
  assert.doesNotMatch(JSON.stringify(authorized), /PRIVATE-SYNTHETIC|experienceText|facts|document|MODEL_API_KEY/);
  assert.deepEqual(await s.runs.resumePdf(claimed.token, origin), bytes);
});

test('unauthorized or stale snapshots and invalid PDFs cannot create a run', async t => {
  const s = setup(t); const input = s.input();
  await assert.rejects(s.runs.create({ ...input, expectedRevision: input.expectedRevision - 1 }), /版本已过期/);
  await assert.rejects(s.runs.create({ ...input, targetUrls: ['https://www.zhipin.com/job_detail/test.html'] }), /字节|bytedance/);
  await assert.rejects(s.runs.create({ ...input, targetUrls: [] }), /1 至 20/);
  let state = s.store.read(); state.resumes[0].approved = false; s.store.save(state, state.revision);
  await assert.rejects(s.create(), /审核/);
  state = s.store.read(); state.resumes[0].approved = true; state.resumes[0].stale = true; s.store.save(state, state.revision);
  await assert.rejects(s.create(), /有效简历/); assert.equal(s.runs.list().length, 0);
  for (const invalid of [Buffer.from('not PDF'), Buffer.alloc(8 * 1024 * 1024 + 1, 'X')]) {
    const broken = setup(t, async () => invalid); await assert.rejects(broken.create(), /PDF 无效/); assert.equal(broken.runs.list().length, 0);
  }
});

test('workspace changes during awaited PDF rendering prevent authorization creation', async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { started = resolve; });
  const s = setup(t, async () => { started(); await gate; return bytes; }); const creating = s.create(); await running;
  const state = s.store.read(); state.resumes[0].stale = true; s.store.save(state, state.revision); release();
  await assert.rejects(creating, /版本已过期/); assert.equal(s.runs.list().length, 0);
});

test('authorization creation checks workspace CAS inside the write transaction, not before its lock', async t => {
  const s = setup(t); const privateRuns = s.runs as unknown as { db: DatabaseSync }; const exec = privateRuns.db.exec.bind(privateRuns.db);
  let injected = false;
  t.mock.method(privateRuns.db, 'exec', (sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !injected) {
      injected = true; const state = s.store.read(); state.questions = ['另一个写入者恰在加锁前更新']; s.store.save(state, state.revision);
    }
    return exec(sql);
  });
  await assert.rejects(s.create(), /版本已过期/); assert.equal(s.runs.list().length, 0);
  assert.deepEqual(s.store.read().questions, ['另一个写入者恰在加锁前更新']);
});

test('two concurrent creates for one target commit only one scoped run', async t => {
  const s = setup(t); const results = await Promise.allSettled([s.create(), s.create()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(s.runs.list().length, 1);
  assert.match((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message, /已有网申记录/);
  const active = s.runs.list()[0]; s.runs.revoke(active.id); await s.create(); assert.equal(s.runs.list().length, 2);
});

test('a changed approved snapshot invalidates claim, fields and PDF even if its ID is unchanged', async t => {
  for (const change of ['stale', 'unapproved', 'content', 'deleted']) {
    const s = setup(t); const claimed = await s.claim(); const state = s.store.read();
    if (change === 'stale') state.resumes[0].stale = true;
    if (change === 'unapproved') state.resumes[0].approved = false;
    if (change === 'content') state.resumes[0].bullets[0].text = '另一次手工修订';
    if (change === 'deleted') state.resumes = [];
    s.store.save(state, state.revision);
    assert.throws(() => s.runs.authorized(claimed.token, origin), /变更或失效/);
    await assert.rejects(s.runs.resumePdf(claimed.token, origin), /变更或失效/);
  }
});

test('PDF download rechecks revocation and snapshot integrity after rendering yields', async t => {
  for (const change of ['revoke', 'stale', 'bytes']) {
    let renders = 0, release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { started = resolve; });
    const s = setup(t, async () => { if (++renders === 1) return bytes; started(); await gate; return change === 'bytes' ? Buffer.from('%PDF-1.7\nDIFFERENT') : bytes; });
    const claimed = await s.claim(); const download = s.runs.resumePdf(claimed.token, origin); await running;
    if (change === 'revoke') s.runs.revoke(claimed.run.id);
    if (change === 'stale') { const state = s.store.read(); state.resumes[0].stale = true; s.store.save(state, state.revision); }
    release(); await assert.rejects(download, /撤销|失效|不一致/);
  }
});

test('checkpoints enforce exact authorized target, current page, revision and explicit final confirmation', async t => {
  const s = setup(t); const claimed = await s.claim(); const checkpoint = (patch: Record<string, unknown>) => s.runs.checkpoint(claimed.token, origin, { expectedRevision: 0, targetId, pageUrl: url(), status: 'filled', ...patch });
  assert.throws(() => checkpoint({ targetId: otherId, pageUrl: url(otherId) }), /不在本次授权/);
  assert.throws(() => checkpoint({ pageUrl: url(otherId) }), /岗位与授权目标不一致/);
  assert.throws(() => checkpoint({ pageUrl: 'https://evil.example/campus/position/7246662982998313277/detail' }), /不一致/);
  assert.throws(() => checkpoint({ expectedRevision: 1 }), /版本已过期/);
  assert.throws(() => checkpoint({ status: 'submitting', confirmed: true }), /核对表单/);
  assert.throws(() => checkpoint({ status: 'submitted', evidence: '投递成功' }), /没有可识别/);
  const filled = checkpoint({ pageUrl: `${url()}?account=private-secret#anchor` }); assert.equal(filled.revision, 1); assert.equal(filled.targets[0].pageUrl, url());
  assert.throws(() => checkpoint({ expectedRevision: 1, status: 'submitting', confirmed: false }), /明确确认/);
  const submitting = checkpoint({ expectedRevision: 1, status: 'submitting', confirmed: true }); assert.equal(submitting.revision, 2);
  assert.throws(() => checkpoint({ expectedRevision: 2, status: 'filled' }), /不能重新填写/);
  assert.throws(() => checkpoint({ expectedRevision: 2, status: 'submitted', evidence: '页面上好像成功了' }), /没有可识别/);
  const submitted = checkpoint({ expectedRevision: 2, status: 'submitted', evidence: '投递成功' }); assert.equal(submitted.targets[0].status, 'submitted');
  assert.throws(() => checkpoint({ expectedRevision: 3, status: 'filled' }), /请勿重复/);
  assert.doesNotMatch(JSON.stringify(s.runs.list()), /private-secret/);
});

test('unknown submissions cannot restart or silently become failed, even after expiration or revocation', async t => {
  const s = setup(t); const claimed = await s.claim();
  let run = s.runs.checkpoint(claimed.token, origin, { expectedRevision: 0, targetId, pageUrl: url(), status: 'filled' });
  run = s.runs.checkpoint(claimed.token, origin, { expectedRevision: run.revision, targetId, pageUrl: url(), status: 'submitting', confirmed: true });
  run = s.runs.checkpoint(claimed.token, origin, { expectedRevision: run.revision, targetId, pageUrl: url(), status: 'unknown' });
  for (const status of ['filled', 'needs_user', 'failed', 'submitting']) assert.throws(() => s.runs.checkpoint(claimed.token, origin, { expectedRevision: run.revision, targetId, pageUrl: url(), status, confirmed: true }), /不能重新填写/);
  s.runs.revoke(run.id); s.advance(61 * 60_000);
  await assert.rejects(s.create(), /已有网申记录/);
});

test('compare-and-swap prevents a stale checkpoint from undoing revocation by another connection', async t => {
  const s = setup(t); const claimed = await s.claim(); const other = new RealApplications(s.path, s.store, s.render, s.now); s.extras.push(other);
  const privateRuns = s.runs as unknown as { save(run: RealApplicationRun): void }; const save = privateRuns.save.bind(s.runs);
  t.mock.method(privateRuns, 'save', (run: RealApplicationRun) => { other.revoke(run.id); save(run); });
  assert.throws(() => s.runs.checkpoint(claimed.token, origin, { expectedRevision: 0, targetId, pageUrl: url(), status: 'filled' }), /版本已过期/);
  assert.equal(s.runs.list()[0].targets[0].status, 'pending'); assert.ok(s.runs.list()[0].revokedAt);
  assert.throws(() => other.authorized(claimed.token, origin), /撤销/);
});

test('restart retains tokens and records while converting only interrupted submitting targets to unknown', async t => {
  const s = setup(t); const created = await s.runs.create({ ...s.input(), targetUrls: [url(), url(otherId)] }); const claimed = s.runs.claim(created.code, origin);
  let run = s.runs.checkpoint(claimed.token, origin, { expectedRevision: 0, targetId, pageUrl: url(), status: 'filled' });
  s.runs.checkpoint(claimed.token, origin, { expectedRevision: run.revision, targetId, pageUrl: url(), status: 'submitting', confirmed: true });
  const reopened = new RealApplications(s.path, s.store, s.render, s.now); s.extras.push(reopened);
  run = reopened.authorized(claimed.token, origin); assert.equal(run.targets[0].status, 'unknown'); assert.equal(run.targets[1].status, 'pending'); assert.equal(run.revision, 3);
  assert.deepEqual(await reopened.resumePdf(claimed.token, origin), bytes);
  const db = new DatabaseSync(s.path); s.extras.push(db); const before = db.prepare('SELECT data FROM real_application_runs').get();
  const again = new RealApplications(s.path, s.store, s.render, s.now); s.extras.push(again); assert.deepEqual(db.prepare('SELECT data FROM real_application_runs').get(), before);
});

test('revoke/remove honor revisions and protect resume deletion until local run removal', async t => {
  const s = setup(t); const created = await s.create(); const claimed = s.runs.claim(created.code, origin);
  const browser: BrowserTools = { fill: async () => { throw new Error('never'); }, submit: async () => { throw new Error('never'); }, resumeInUse: id => s.runs.hasResume(id) };
  const workflow = new Workflow(s.store, createModelEngine({}), browser);
  const removeResume = () => workflow.act({ type: 'delete_resume', resumeId: created.run.resume.id, expectedRevision: s.store.read().revision });
  await assert.rejects(removeResume(), /真实网申记录/);
  assert.throws(() => s.runs.remove(created.run.id), /先撤销/); assert.throws(() => s.runs.revoke(created.run.id, 999), /版本已过期/);
  const revoked = s.runs.revoke(created.run.id, 0); assert.ok(revoked.revokedAt);
  assert.throws(() => s.runs.authorized(claimed.token, origin), /撤销/); await assert.rejects(s.runs.resumePdf(claimed.token, origin), /撤销/);
  await assert.rejects(removeResume(), /真实网申记录/); assert.throws(() => s.runs.remove(revoked.id, 0), /版本已过期/);
  s.runs.remove(revoked.id, revoked.revision); assert.equal(s.runs.hasResume(created.run.resume.id), false); assert.throws(() => s.runs.authorized(claimed.token, origin), /无效/);
  await removeResume(); assert.equal(s.store.read().resumes.length, 0);
});

test('revoking or deleting an unclaimed run makes its code permanently unusable', async t => {
  const s = setup(t); const created = await s.create(); s.runs.revoke(created.run.id);
  assert.throws(() => s.runs.claim(created.code, origin), /撤销/); s.runs.remove(created.run.id);
  assert.throws(() => s.runs.claim(created.code, origin), /无效/);
  const fresh = await s.create(); assert.notEqual(fresh.code, created.code); assert.equal(s.runs.list().length, 1);
});

async function router(t: TestContext, runs: RealApplications) {
  const app = express(); app.use('/extension/applications/v1', extensionApplicationRouter(runs));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}/extension/applications/v1`;
  return (path: string, body: unknown = {}, headers: Record<string, string> = {}, method = 'POST') => fetch(`${base}${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' || method === 'OPTIONS' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}

test('extension router permits only narrow POST JSON/CORS scope and never reflects secrets in errors', async t => {
  const s = setup(t); const request = await router(t, s.runs); const created = await s.create();
  assert.equal((await request('/run', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/run', {}, { Origin: '' })).status, 403);
  assert.equal((await request('/anything')).status, 403);
  assert.equal((await request('/run', {}, {}, 'GET')).status, 405);
  assert.equal((await request('/run', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('/run', '{invalid-json')).status, 400);
  assert.equal((await request('/claim', { code: created.code, extra: true })).status, 400);
  const large = await request('/claim', { code: 'private-secret'.repeat(1000) }); assert.equal(large.status, 413); assert.doesNotMatch(await large.text(), /private-secret/);
  const preflight = await request('/resume.pdf', {}, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true' }, 'OPTIONS');
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin); assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'), 'true');
  assert.equal((await request('/run', {}, { 'Access-Control-Request-Method': 'GET' }, 'OPTIONS')).status, 403);
  assert.equal((await request('/run', {}, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'cookie' }, 'OPTIONS')).status, 403);
  const claimedResponse = await request('/claim', { code: created.code }); assert.equal(claimedResponse.status, 200); const claimed = await claimedResponse.json();
  const header = { Authorization: `Bearer ${claimed.token}` };
  const authorized = await request('/run', {}, header); assert.equal(authorized.status, 200); assert.equal(authorized.headers.get('Cache-Control'), 'no-store'); assert.doesNotMatch(await authorized.text(), /PRIVATE-SYNTHETIC/);
  assert.equal((await request('/run', {}, { Authorization: claimed.token })).status, 401);
  assert.equal((await request('/run', {}, { ...header, Origin: otherOrigin })).status, 401);
  const pdf = await request('/resume.pdf', {}, header); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('Content-Type')!, /application\/pdf/); assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), bytes);
  assert.equal((await request('/checkpoint', { expectedRevision: 0, targetId, pageUrl: url(), status: 'submitted', evidence: '投递成功' }, header)).status, 409);
  s.runs.revoke(created.run.id); assert.equal((await request('/resume.pdf', {}, header)).status, 401);
});

test('authorization code guessing is bounded per router', async t => {
  const s = setup(t); const request = await router(t, s.runs);
  for (let i = 0; i < 12; i++) assert.equal((await request('/claim', { code: 'AAAAAAAAAAAAAAAA' })).status, 401);
  assert.equal((await request('/claim', { code: 'AAAAAAAAAAAAAAAA' })).status, 429);
});
