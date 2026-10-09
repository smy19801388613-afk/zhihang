import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Action, ApplicationStatus, ModelEngine, WorkspaceState } from '../shared/types.ts';
import { toResumeDocument } from '../shared/resume-template.ts';
import { Store } from '../server/store.ts';
import { Workflow, exampleJob, exampleProfile, type BrowserTools } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { actionSchema } from '../server/validation.ts';

const neverBrowser: BrowserTools = {
  fill: async () => { throw new Error('Deletion must not fill a form.'); },
  submit: async () => { throw new Error('Deletion must not submit a form.'); },
};
function temporary(t: TestContext, beforeRemove = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'zhihang-record-deletion-'));
  t.after(() => {
    beforeRemove();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhihang-record-deletion-')) throw new Error('Unsafe temporary cleanup');
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}
async function setup(path = ':memory:', hooks: Partial<BrowserTools> = {}) {
  const store = new Store(path);
  const workflow = new Workflow(store, createModelEngine({}), { ...neverBrowser, ...hooks });
  const act = (action: Action) => workflow.act({ ...action, expectedRevision: store.read().revision });
  await workflow.importBrowserCaptures({ protocolVersion: 1, requestId: randomUUID(), jobs: [{ platform: 'boss', sourceUrl: 'https://www.zhipin.com/job_detail/DeleteKeep01.html', capturedAt: '2026-10-01T00:00:00Z', pageKind: 'detail', fields: { company: '保留来源公司', title: '资料整理实习', city: '上海', salary: '180元/天', education: '本科', experience: '不限', jd: '协助整理公开资料并维护项目文档，本科在读。', jdComplete: true } }] });
  const captureId = Object.keys(store.read().browserCaptures!)[0];
  await act({ type: 'swipe_company', companyId: captureId, decision: 'like' });
  const state = store.read();
  state.profile = { ...exampleProfile, facts: [{ id: 'fact', text: '在校园读书会活动中负责报名表维护。', source: '在校园读书会活动中负责报名表维护。', confirmed: true }] };
  state.job = { ...exampleJob };
  state.analysis = { summary: '合成分析', matches: [], questions: [], directionAdvice: [] };
  state.resumes = [3, 7, 12].map(version => ({ id: randomUUID(), version, createdAt: '2026-10-01T00:00:00Z', profile: structuredClone(state.profile), job: structuredClone(state.job), bullets: [{ text: state.profile.facts[0].text, factIds: ['fact'] }], rationale: '合成快照', approved: true, stale: false }));
  state.resumes[2].parentId = state.resumes[1].id;
  state.activeResumeId = state.resumes[2].id;
  state.interview = { resumeId: state.resumes[2].id, messages: [{ role: 'assistant', content: '保留或按关联删除的面试' }] };
  state.applications = [0, 1].map(index => ({ id: randomUUID(), resumeId: state.resumes[index].id, company: state.resumes[index].job.company, jobTitle: state.resumes[index].job.title, status: 'confirmed', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', simulated: true }));
  store.save(state, state.revision);
  const tokens = state.applications.map(application => store.token(application.id));
  const receipts = state.applications.map(application => store.createReceipt(application.id));
  const received = store.read(); received.applications.forEach((application, index) => { application.receipt = receipts[index]; }); store.save(received, received.revision);
  return { store, workflow, act, tokens, receipts };
}
function without(state: WorkspaceState, keys: Array<keyof WorkspaceState>) {
  const copy = structuredClone(state);
  for (const key of ['revision', 'events', ...keys]) delete (copy as unknown as Record<string, unknown>)[key];
  return copy;
}

test('deletion actions require exact IDs, a revision and no cascade flags', () => {
  for (const action of [{ type: 'clear_job' }, { type: 'delete_resume', resumeId: randomUUID() }, { type: 'delete_application', applicationId: randomUUID() }]) {
    assert.equal(actionSchema.safeParse(action).success, false);
    assert.equal(actionSchema.safeParse({ ...action, expectedRevision: 0 }).success, true);
    assert.equal(actionSchema.safeParse({ ...action, expectedRevision: 0, cascade: true }).success, false);
  }
  assert.equal(actionSchema.safeParse({ type: 'delete_application', applicationId: '../outside', expectedRevision: 0 }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'delete_resume', resumeId: '', expectedRevision: 0 }).success, false);
});

test('clear_job empties only current preparation even with zero facts or no resume', async t => {
  for (const noResume of [false, true]) {
    const s = await setup(); t.after(() => s.store.close());
    if (noResume) { const state = s.store.read(); state.profile.facts = []; state.resumes = []; state.applications = []; state.activeResumeId = null; state.interview = null; s.store.save(state, state.revision); }
    const before = s.store.read(); const after = await s.act({ type: 'clear_job' });
    assert.deepEqual(after.job, { company: '', title: '', text: '', url: '' });
    assert.equal(after.analysis, null); assert.equal(after.activeResumeId, null); assert.equal(after.interview, null);
    assert.deepEqual(without(after, ['job', 'analysis', 'activeResumeId', 'interview']), without(before, ['job', 'analysis', 'activeResumeId', 'interview']));
  }
});

test('confirmed application deletion revokes only its credentials and calls cleanup after commit', async t => {
  let s: Awaited<ReturnType<typeof setup>>; const cleaned: string[] = [];
  s = await setup(':memory:', { removeApplication: async id => { cleaned.push(id); assert.equal(s.store.read().applications.some(application => application.id === id), false); assert.equal(s.store.receipt(id), undefined); assert.equal(s.store.validToken(id, s.tokens[0]), false); } });
  t.after(() => s.store.close()); const before = s.store.read(); const id = before.applications[0].id;
  const after = await s.act({ type: 'delete_application', applicationId: id });
  assert.deepEqual(after.applications, before.applications.slice(1)); assert.deepEqual(cleaned, [id]);
  assert.deepEqual(without(after, ['applications']), without(before, ['applications']));
  assert.equal(s.store.validToken(before.applications[1].id, s.tokens[1]), true); assert.equal(s.store.receipt(before.applications[1].id), s.receipts[1]);
  await assert.rejects(s.act({ type: 'verify_application', applicationId: id }), /未找到/);
});

test('prepared, filled, failed and unknown records are removable but active submitting is guarded', async t => {
  for (const status of ['prepared', 'filled', 'failed', 'unknown', 'submitting'] as ApplicationStatus[]) {
    const s = await setup(); t.after(() => s.store.close()); const state = s.store.read(); const application = state.applications[0]; application.status = status; s.store.save(state, state.revision);
    if (status === 'submitting') { const before = s.store.read(); await assert.rejects(s.act({ type: 'delete_application', applicationId: application.id }), /仍在提交中/); assert.deepEqual(s.store.read(), before); assert.equal(s.store.validToken(application.id, s.tokens[0]), true); }
    else { const after = await s.act({ type: 'delete_application', applicationId: application.id }); assert.equal(after.applications.some(item => item.id === application.id), false); assert.equal(s.store.receipt(application.id), undefined); }
  }
});

test('a resume referenced by any application cannot be deleted and has no cleanup side effects', async t => {
  const cleaned: string[] = []; const s = await setup(':memory:', { removeResume: async id => { cleaned.push(id); } }); t.after(() => s.store.close());
  for (const status of ['prepared', 'filled', 'failed', 'unknown', 'confirmed', 'submitting'] as ApplicationStatus[]) {
    const state = s.store.read(); state.applications[0].status = status; s.store.save(state, state.revision); const before = s.store.read();
    await assert.rejects(s.act({ type: 'delete_resume', resumeId: before.applications[0].resumeId }), /先删除对应投递记录/); assert.deepEqual(s.store.read(), before);
  }
  assert.deepEqual(cleaned, []);
});

test('deleting an unreferenced active resume clears only its selection and interview', async t => {
  const cleaned: string[] = []; const s = await setup(':memory:', { removeResume: async id => { cleaned.push(id); } }); t.after(() => s.store.close());
  const before = s.store.read(); const target = before.resumes[2]; const after = await s.act({ type: 'delete_resume', resumeId: target.id });
  assert.deepEqual(after.resumes, before.resumes.slice(0, 2)); assert.equal(after.activeResumeId, null); assert.equal(after.interview, null); assert.deepEqual(cleaned, [target.id]);
  assert.equal(after.resumeVersionCounter, 12);
  assert.deepEqual(without(after, ['resumes', 'activeResumeId', 'interview']), without(before, ['resumes', 'activeResumeId', 'interview']));
});

test('removing an application permits deleting its resume without deleting descendants or other selections', async t => {
  const s = await setup(); t.after(() => s.store.close()); let before = s.store.read();
  await s.act({ type: 'delete_application', applicationId: before.applications[1].id }); before = s.store.read();
  const target = before.resumes[1]; const after = await s.act({ type: 'delete_resume', resumeId: target.id });
  assert.deepEqual(after.resumes, before.resumes.filter(resume => resume.id !== target.id));
  assert.deepEqual(without(after, ['resumes']), without(before, ['resumes']));
});

test('stale, missing and failed deletions leave snapshots, credentials and cleanup hooks untouched', async t => {
  const cleaned: string[] = []; const s = await setup(':memory:', { removeApplication: async id => { cleaned.push(id); }, removeResume: async id => { cleaned.push(id); } }); t.after(() => s.store.close());
  const before = s.store.read();
  const actions: Action[] = [{ type: 'delete_application', applicationId: before.applications[0].id }, { type: 'delete_resume', resumeId: before.resumes[2].id }, { type: 'clear_job' }];
  for (const action of actions) await assert.rejects(s.workflow.act({ ...action, expectedRevision: before.revision - 1 }), /版本已过期/);
  await assert.rejects(s.act({ type: 'delete_application', applicationId: randomUUID() }), /未找到/);
  await assert.rejects(s.act({ type: 'delete_resume', resumeId: randomUUID() }), /未找到/);
  const save = t.mock.method(s.store, 'save', () => { throw new Error('synthetic storage failure'); });
  for (const action of actions) await assert.rejects(s.act(action), /storage failure/); save.mock.restore();
  assert.deepEqual(s.store.read(), before); assert.deepEqual(cleaned, []); assert.equal(s.store.validToken(before.applications[0].id, s.tokens[0]), true); assert.equal(s.store.receipt(before.applications[0].id), s.receipts[0]);
});

test('receipt cleanup failure rolls back both the workspace and token deletion', async t => {
  let s: Awaited<ReturnType<typeof setup>> | undefined; let connection: DatabaseSync | undefined;
  const directory = temporary(t, () => { connection?.close(); s?.store.close(); }); const path = join(directory, 'test.sqlite'); s = await setup(path); const before = s.store.read();
  connection = new DatabaseSync(path);
  connection.exec("CREATE TRIGGER fail_receipt_cleanup BEFORE DELETE ON sandbox_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt cleanup failure'); END");
  await assert.rejects(s.act({ type: 'delete_application', applicationId: before.applications[0].id }), /receipt cleanup failure/);
  assert.deepEqual(s.store.read(), before); assert.equal(s.store.validToken(before.applications[0].id, s.tokens[0]), true); assert.equal(s.store.receipt(before.applications[0].id), s.receipts[0]);
  connection.exec('DROP TRIGGER fail_receipt_cleanup'); await s.act({ type: 'delete_application', applicationId: before.applications[0].id });
  assert.equal(s.store.receipt(before.applications[0].id), undefined);
});

test('only one concurrent deletion commits and an old CAS cannot revoke another application', async t => {
  const cleaned: string[] = []; const s = await setup(':memory:', { removeApplication: async id => { cleaned.push(id); } }); t.after(() => s.store.close());
  const before = s.store.read(); const action = { type: 'delete_application' as const, applicationId: before.applications[0].id, expectedRevision: before.revision };
  const outcomes = await Promise.allSettled([s.workflow.act(action), s.workflow.act(action)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1); assert.equal(cleaned.length, 1);
  const stale = structuredClone(before); stale.applications = []; assert.throws(() => s.store.save(stale, before.revision), /版本已过期/);
  assert.equal(s.store.read().applications.length, 1); assert.equal(s.store.validToken(before.applications[1].id, s.tokens[1]), true); assert.equal(s.store.receipt(before.applications[1].id), s.receipts[1]);
});

test('busy deletion is rejected and old model work cannot resurrect a separately deleted record', async t => {
  const s = await setup(); t.after(() => s.store.close()); const before = s.store.read();
  let release!: () => void; let started!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const running = new Promise<void>(resolve => { started = resolve; });
  const demo = createModelEngine({}); const slow: ModelEngine = { ...demo, extractProfile: async profile => { started(); await gate; return demo.extractProfile(profile); } };
  const busy = new Workflow(s.store, slow, neverBrowser);
  const old = busy.act({ type: 'extract_profile', profile: exampleProfile, expectedRevision: before.revision }); await running;
  await assert.rejects(busy.act({ type: 'delete_application', applicationId: before.applications[0].id, expectedRevision: before.revision }), /上一步还在执行/);
  const after = await s.act({ type: 'delete_application', applicationId: before.applications[0].id }); release(); await assert.rejects(old, /版本已过期/); assert.deepEqual(s.store.read(), after);
});

test('cleanup failures do not undo a committed deletion or expose metadata-selected files', async t => {
  const directory = temporary(t); const outside = join(directory, 'unrelated.txt'); writeFileSync(outside, 'must stay');
  const s = await setup(':memory:', { removeApplication: async () => { throw new Error('private path must not be logged'); }, removeResume: async () => { throw new Error('private path must not be logged'); } }); t.after(() => s.store.close());
  const warnings: unknown[][] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const state = s.store.read(); state.applications[0].evidence = outside; s.store.save(state, state.revision);
  await s.act({ type: 'delete_application', applicationId: state.applications[0].id }); await s.act({ type: 'delete_resume', resumeId: state.resumes[0].id });
  assert.equal(readFileSync(outside, 'utf8'), 'must stay'); assert.equal(warnings.length, 2); assert.doesNotMatch(JSON.stringify(warnings), /private path|unrelated/);
  assert.equal(s.store.read().resumes.some(resume => resume.id === state.resumes[0].id), false);
});

test('resume high watermark migrates without a write and survives deletion, edits and restart', async t => {
  let openStore: Store | undefined; let openConnection: DatabaseSync | undefined;
  const directory = temporary(t, () => { openConnection?.close(); openStore?.close(); }); const path = join(directory, 'test.sqlite'); const s = await setup(path); openStore = s.store;
  const before = s.store.read(); s.store.close(); openStore = undefined;
  const connection = new DatabaseSync(path); openConnection = connection; const row = connection.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string }; const legacy = JSON.parse(row.data); delete legacy.resumeVersionCounter; connection.prepare('UPDATE workspace SET data=? WHERE id=1').run(JSON.stringify(legacy)); const stored = (connection.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string }).data;
  let store = new Store(path); openStore = store; let workflow = new Workflow(store, createModelEngine({}), neverBrowser);
  assert.equal(store.read().resumeVersionCounter, 12); assert.equal(store.read().revision, before.revision); assert.equal((connection.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string }).data, stored); connection.close(); openConnection = undefined;
  for (const application of store.read().applications) await workflow.act({ type: 'delete_application', applicationId: application.id, expectedRevision: store.read().revision });
  for (const resume of store.read().resumes) await workflow.act({ type: 'delete_resume', resumeId: resume.id, expectedRevision: store.read().revision });
  assert.equal(store.read().resumeVersionCounter, 12); store.close(); openStore = undefined;
  store = new Store(path); openStore = store; workflow = new Workflow(store, createModelEngine({}), neverBrowser);
  assert.equal(store.read().resumes.length, 0); assert.equal(store.receipt(before.applications[0].id), undefined); assert.equal(store.validToken(before.applications[0].id, s.tokens[0]), false);
  let state = await workflow.act({ type: 'generate_resume', expectedRevision: store.read().revision }); const generated = state.resumes[0]; assert.equal(generated.version, 13);
  const { facts: _facts, ...profile } = generated.profile;
  state = await workflow.act({ type: 'save_resume_edit', resumeId: generated.id, profile, document: toResumeDocument(generated), expectedRevision: state.revision }); assert.equal(state.resumes.at(-1)!.version, 14);
  for (const resume of state.resumes) await workflow.act({ type: 'delete_resume', resumeId: resume.id, expectedRevision: store.read().revision });
  store.close(); openStore = undefined; store = new Store(path); openStore = store; workflow = new Workflow(store, createModelEngine({}), neverBrowser);
  state = await workflow.act({ type: 'generate_resume', expectedRevision: store.read().revision }); assert.equal(state.resumes[0].version, 15); assert.equal(state.resumeVersionCounter, 15);
  assert.deepEqual(state.browserCaptures, before.browserCaptures); assert.deepEqual(state.exploration, before.exploration); assert.deepEqual(state.profile, before.profile);
});
