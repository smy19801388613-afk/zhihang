import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { Store } from '../server/store.ts';
import { Workflow, exampleProfile, exampleJob, type BrowserTools } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import type { Action, WorkspaceState } from '../shared/types.ts';

function setup() {
  const store = new Store(':memory:');
  let submissionCount = 0;
  let timeoutAfterReceipt = false;
  const browser: BrowserTools = {
    fill: async () => ({ evidence: 'test.png' }),
    submit: async ({ application }) => {
      submissionCount++;
      const receipt = store.createReceipt(application.id);
      if (timeoutAfterReceipt) throw new Error('simulated timeout');
      return { receipt, evidence: 'test.png' };
    }
  };
  const workflow = new Workflow(store, createModelEngine({}), browser);
  const act = (action: Action) => workflow.act({ ...action, expectedRevision: store.read().revision });
  const ready = async () => {
    let state = await act({ type: 'extract_profile', profile: exampleProfile });
    for (const fact of state.profile.facts) state = await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
    await act({ type: 'save_job', job: exampleJob });
    await act({ type: 'analyze_job' });
    state = await act({ type: 'generate_resume' });
    state = await act({ type: 'approve_resume', resumeId: state.activeResumeId! });
    return state;
  };
  return { store, workflow, act, ready, get submissions() { return submissionCount; }, timeout: () => { timeoutAfterReceipt = true; } };
}

test('reject stale requests rather than overwrite newer facts', async () => {
  const s = setup();
  await s.act({ type: 'load_example' });
  await assert.rejects(s.workflow.act({ type: 'load_example', expectedRevision: 0 }), /页面版本已过期/);
  s.store.close();
});
test('pending facts cannot enter analysis or resume', async () => {
  const s = setup();
  await s.act({ type: 'extract_profile', profile: exampleProfile });
  await s.act({ type: 'save_job', job: exampleJob });
  await assert.rejects(s.act({ type: 'analyze_job' }), /确认至少一条/);
  assert.equal(s.store.read().resumes.length, 0);
  s.store.close();
});
test('editing facts invalidates pending application without rewriting past resume', async () => {
  const s = setup();
  let state = await s.ready();
  const original = structuredClone(state.resumes[0]);
  state = await s.act({ type: 'prepare_application', resumeId: original.id });
  const appId = state.applications[0].id;
  const fact = state.profile.facts[0];
  state = await s.act({ type: 'update_fact', factId: fact.id, text: '用户修订的真实经历', confirmed: true });
  assert.equal(state.activeResumeId, null);
  assert.deepEqual(state.resumes[0], { ...original, stale: true });
  assert.equal(state.applications[0].status, 'failed');
  await assert.rejects(s.act({ type: 'fill_application', applicationId: appId }), /不是当前草稿/);
  s.store.close();
});
test('submission requires filled form and cannot be submitted twice', async () => {
  const s = setup();
  const state = await s.ready();
  const app = (await s.act({ type: 'prepare_application', resumeId: state.activeResumeId! })).applications[0];
  await assert.rejects(s.act({ type: 'submit_application', applicationId: app.id, confirmed: true }), /填写并核对/);
  await s.act({ type: 'fill_application', applicationId: app.id });
  const result = await s.act({ type: 'submit_application', applicationId: app.id, confirmed: true });
  assert.equal(result.applications[0].status, 'confirmed');
  assert.ok(result.applications[0].receipt?.startsWith('DEMO-'));
  await assert.rejects(s.act({ type: 'submit_application', applicationId: app.id, confirmed: true }));
  await assert.rejects(s.act({ type: 'prepare_application', resumeId: state.activeResumeId! }), /已有申请记录/);
  assert.equal(s.submissions, 1);
  s.store.close();
});
test('timeout after receipt stays unknown until verified and never retries submit', async () => {
  const s = setup(); s.timeout();
  const state = await s.ready();
  const app = (await s.act({ type: 'prepare_application', resumeId: state.activeResumeId! })).applications[0];
  await s.act({ type: 'fill_application', applicationId: app.id });
  const unknown = await s.act({ type: 'submit_application', applicationId: app.id, confirmed: true });
  assert.equal(unknown.applications[0].status, 'unknown');
  await assert.rejects(s.act({ type: 'fill_application', applicationId: app.id }), /不能重复填写/);
  const checked = await s.act({ type: 'verify_application', applicationId: app.id });
  assert.equal(checked.applications[0].status, 'confirmed');
  assert.equal(s.submissions, 1);
  s.store.close();
});
test('failed application cannot be revived alongside another active application to the same job', async () => {
  const s = setup();
  const ready = await s.ready();
  const first = (await s.act({ type: 'prepare_application', resumeId: ready.activeResumeId! })).applications[0];
  const state = s.store.read();
  state.applications[0].status = 'failed';
  s.store.save(state, state.revision);
  const second = (await s.act({ type: 'prepare_application', resumeId: ready.activeResumeId! })).applications[0];
  await assert.rejects(s.act({ type: 'fill_application', applicationId: first.id }), /另一条有效申请/);
  await s.act({ type: 'fill_application', applicationId: second.id });
  await s.act({ type: 'submit_application', applicationId: second.id, confirmed: true });
  await assert.rejects(s.act({ type: 'fill_application', applicationId: first.id }), /另一条有效申请/);
  assert.equal(s.submissions, 1);
  s.store.close();
});
test('SQLite keeps snapshots and recovery checkpoints after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zhihang-test-'));
  try {
    let store = new Store(join(dir, 'state.sqlite'));
    const state = store.read();
    state.profile.name = '保存的资料';
    state.applications.push({ id: 'test', resumeId: 'test', company: '测试', jobTitle: '测试', simulated: true, status: 'submitting', createdAt: '', updatedAt: '' });
    store.save(state, state.revision); store.close();
    store = new Store(join(dir, 'state.sqlite'));
    assert.equal(store.read().profile.name, '保存的资料');
    assert.equal(store.read().applications[0].status, 'unknown');
    store.close();
  } finally {
    const target = resolve(dir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhihang-test-')) throw new Error('Unexpected cleanup path');
    rmSync(target, { recursive: true });
  }
});
