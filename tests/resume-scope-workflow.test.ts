import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Action, CompanyCandidate, Job, ModelEngine, ResumeVersion } from '../shared/types.ts';
import { toResumeDocument } from '../shared/resume-template.ts';
import { resolveResumeTargets } from '../shared/resume-scope.ts';
import { Store } from '../server/store.ts';
import { Workflow, exampleProfile, type BrowserTools } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { actionSchema } from '../server/validation.ts';
import { sameTargetJob } from '../server/resume-edit.ts';
import { captureJob } from '../server/browser-capture.ts';
import { candidateJob } from '../shared/job-source.ts';

const factText = '在校园读书会中负责报名表维护。';
const candidate = (index: number, overrides: Partial<CompanyCandidate> = {}): CompanyCandidate => ({
  id: `job-${index}`, name: `合成公司${index}`, industry: '软件', role: '资料整理实习', rationale: '', requirements: [],
  careerUrl: `https://jobs.example.test/detail/${index}`, sourceLabel: '合成公开岗位', checkedAt: '2026-10-01T00:00:00Z', hiringStatus: 'unverified', selected: true,
  sourceKind: 'public_job', jobDescription: '协助整理资料，维护报名表并更新项目文档。', location: '北京', jdComplete: true, ...overrides,
});
function setup(t: TestContext, options: { path?: string; engine?: Partial<ModelEngine>; browser?: Partial<BrowserTools>; close?: boolean } = {}) {
  const store = new Store(options.path || ':memory:');
  if (options.close !== false) t.after(() => store.close());
  const calls: Array<Parameters<ModelEngine['draftResume']>> = [];
  const engine: ModelEngine = { ...createModelEngine({}), draftResume: async (...args) => {
    calls.push(structuredClone(args));
    return { bullets: [{ text: factText, factIds: ['fact-1'] }], rationale: '仅使用已确认事实。' };
  }, ...options.engine };
  const fills: string[] = [], submits: string[] = [];
  const browser: BrowserTools = {
    fill: async ({ application }) => { fills.push(application.id); return { evidence: 'synthetic.png' }; },
    submit: async ({ application }) => { submits.push(application.id); return { receipt: store.createReceipt(application.id), evidence: 'synthetic.png' }; },
    ...options.browser,
  };
  const workflow = new Workflow(store, engine, browser);
  const state = store.read();
  state.profile = { ...exampleProfile, facts: [{ id: 'fact-1', text: factText, source: factText, confirmed: true }] };
  state.exploration!.companies = Array.from({ length: 9 }, (_, index) => candidate(index));
  store.save(state, state.revision);
  const act = (action: Action) => workflow.act({ ...action, expectedRevision: store.read().revision });
  const general = async (name = '通用资料整理简历') => {
    const generated = await act({ type: 'generate_general_resume', name, focus: '资料整理和活动执行' });
    return generated.resumes.at(-1)!;
  };
  const approved = async () => {
    const resume = await general();
    await act({ type: 'approve_resume', resumeId: resume.id }); return resume.id;
  };
  const prepare = async (ids = ['job-0', 'job-1', 'job-2']) => {
    const resumeId = await approved();
    const state = await act({ type: 'prepare_applications', resumeId, candidateIds: ids });
    return { resumeId, ids: [...state.applications].reverse().map(application => application.id) };
  };
  return { store, workflow, act, calls, browser, fills, submits, general, approved, prepare };
}

test('scope and batch action schemas require bounded unique selections and explicit submit confirmation', () => {
  const common = { expectedRevision: 0 };
  assert.equal(actionSchema.safeParse({ type: 'generate_general_resume', name: '通用', focus: '', ...common }).success, true);
  assert.equal(actionSchema.safeParse({ type: 'generate_general_resume', name: '', focus: '', ...common }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'generate_multi_resume', name: '多岗', focus: '', candidateIds: ['a', 'a'], ...common }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'prepare_applications', resumeId: randomUUID(), candidateIds: [], includeCurrentJob: true, ...common }).success, true);
  for (const ids of [[], [randomUUID(), ...Array.from({ length: 20 }, () => randomUUID())], ['bad']]) assert.equal(actionSchema.safeParse({ type: 'fill_applications', applicationIds: ids, ...common }).success, false);
  const id = randomUUID();
  assert.equal(actionSchema.safeParse({ type: 'fill_applications', applicationIds: [id, id], ...common }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'submit_applications', applicationIds: [id], confirmed: false, ...common }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'submit_applications', applicationIds: [id], confirmed: true, ...common }).success, true);
  assert.equal(actionSchema.safeParse({ type: 'submit_applications', applicationIds: [id], confirmed: true, realWebsite: true, ...common }).success, false);
});

test('general resumes need no current JD or analysis and create separate persistent collections', async t => {
  const s = setup(t); const before = s.store.read(); const first = await s.general(); const second = await s.general();
  assert.deepEqual(first.scope, { kind: 'general', name: '通用资料整理简历', focus: '资料整理和活动执行', targetJobs: [] });
  assert.ok(first.collectionId); assert.notEqual(first.collectionId, second.collectionId);
  assert.equal(first.job.company, ''); assert.equal(s.calls[0][1].company, ''); assert.deepEqual(s.calls[0][4], first.scope);
  assert.deepEqual(s.store.read().job, before.job); assert.equal(s.store.read().analysis, null);
  assert.ok(s.store.read().resumes.every(resume => !resume.stale));
  assert.equal(first.quality?.status, 'not_checked'); assert.equal(first.approved, false);
});

test('generation still refuses unconfirmed facts or invented quantitative claims', async t => {
  const s = setup(t); const state = s.store.read(); state.profile.facts[0].confirmed = false; s.store.save(state, state.revision);
  await assert.rejects(s.general(), /确认至少一条/); assert.equal(s.calls.length, 0);
  const bad = setup(t, { engine: { draftResume: async () => ({ bullets: [{ text: '累计服务9999名报名者。', factIds: ['fact-1'] }], rationale: '' }) } });
  const before = bad.store.read(); await assert.rejects(bad.general()); assert.deepEqual(bad.store.read(), before);
});

test('multi resume snapshots contain 2 to 8 complete distinct JDs and do not truncate oversized source', async t => {
  const s = setup(t); const multi = (ids: string[]) => s.act({ type: 'generate_multi_resume', name: '多个资料岗位', focus: '共用经历', candidateIds: ids });
  await assert.rejects(multi(['job-0']), /2 至 8/);
  await assert.rejects(multi(Array.from({ length: 9 }, (_, index) => `job-${index}`)), /2 至 8/);
  let state = s.store.read(); state.exploration!.companies[1].jdComplete = false; s.store.save(state, state.revision);
  await assert.rejects(multi(['job-0', 'job-1']), /详情待补充/);
  state = s.store.read(); state.exploration!.companies[1].jdComplete = true;
  for (const company of state.exploration!.companies.slice(0, 4)) company.jobDescription = '岗位要求末尾完整保留'.repeat(1400);
  s.store.save(state, state.revision); await assert.rejects(multi(['job-0', 'job-1', 'job-2', 'job-3']), /48000/); assert.equal(s.calls.length, 0);
  state = s.store.read(); for (const company of state.exploration!.companies) company.jobDescription = `${company.id}：协助整理完整资料。最后条件需本人核实。`; s.store.save(state, state.revision);
  state = await multi(['job-0', 'job-1']); const resume = state.resumes.at(-1)!;
  assert.equal(resume.scope!.targetJobs.length, 2); assert.ok(resume.scope!.targetJobs.every(job => job.text.endsWith('最后条件需本人核实。')));
  assert.deepEqual(s.calls[0][4], resume.scope); assert.equal(s.calls[0][1].company, '');
  const saved = structuredClone(resume.scope); state.companyJobs!['job-0'] = { ...resume.scope!.targetJobs[0], text: '后来变化的岗位文本' }; s.store.save(state, state.revision);
  assert.deepEqual(s.store.read().resumes.at(-1)!.scope, saved);
});

test('matching target identity retains same company and role in different cities', () => {
  const a: Job = { company: '同名公司', title: '同名岗位', text: '', url: '', location: '北京' };
  assert.equal(sameTargetJob(a, { ...a, location: '上海' }), false);
  assert.equal(sameTargetJob({ ...a, candidateId: 'a' }, { ...a, candidateId: 'b' }), false);
  assert.equal(sameTargetJob({ ...a, url: 'https://jobs.example/a?utm_source=x' }, { ...a, url: 'https://jobs.example/a#details' }), true);
  assert.equal(sameTargetJob({ ...a, url: 'https://jobs.example/a' }, { ...a, url: 'https://jobs.example/b' }), false);
});

test('edits retain scope and only invalidate applications of the same resume collection', async t => {
  const s = setup(t); const firstId = await s.approved();
  await s.act({ type: 'prepare_applications', resumeId: firstId, candidateIds: ['job-0', 'job-1'] });
  let state = s.store.read(); state.applications[0].status = 'confirmed'; state.applications[0].receipt = s.store.createReceipt(state.applications[0].id); s.store.save(state, state.revision);
  const otherId = await s.approved(); await s.act({ type: 'prepare_applications', resumeId: otherId, candidateIds: ['job-2'] });
  state = s.store.read(); const base = state.resumes.find(resume => resume.id === firstId)!; const { facts: _facts, ...profile } = base.profile;
  state = await s.act({ type: 'save_resume_edit', resumeId: base.id, profile, document: toResumeDocument(base) }); const edited = state.resumes.at(-1)!;
  assert.equal(edited.collectionId, base.collectionId); assert.deepEqual(edited.scope, base.scope);
  assert.equal(state.resumes.find(resume => resume.id === base.id)!.stale, true); assert.equal(state.resumes.find(resume => resume.id === otherId)!.stale, false);
  assert.equal(state.applications.find(application => application.resumeId === otherId)!.status, 'prepared');
  assert.equal(state.applications.find(application => application.resumeId === base.id && application.jobTitle && application.company === '合成公司0')!.status, 'failed');
  assert.equal(state.applications.find(application => application.resumeId === base.id && application.company === '合成公司1')!.status, 'confirmed');
});

test('JD changes invalidate included multi or single snapshots but not general or other series', async t => {
  const s = setup(t); const general = await s.general();
  await s.act({ type: 'generate_multi_resume', name: '多岗', focus: '', candidateIds: ['job-0', 'job-1'] });
  let state = s.store.read(); const multi = state.resumes.at(-1)!; const target = multi.scope!.targetJobs[0];
  const single: ResumeVersion = { ...structuredClone(multi), id: randomUUID(), version: 10, job: structuredClone(target) }; delete single.scope; delete single.collectionId;
  state.resumes.push(single); s.store.save(state, state.revision);
  state = await s.act({ type: 'save_job', job: { ...target, text: `${target.text}\n新增明确职责：维护公开文档。` } });
  assert.equal(state.resumes.find(resume => resume.id === general.id)!.stale, false);
  assert.equal(state.resumes.find(resume => resume.id === multi.id)!.stale, true); assert.equal(state.resumes.find(resume => resume.id === single.id)!.stale, true);
  assert.equal(state.activeResumeId, null);
});

test('batch preparation binds independent targets, skips duplicates and permits clearly incomplete target details', async t => {
  const s = setup(t); const resumeId = await s.approved();
  let state = s.store.read(); state.exploration!.companies[1] = candidate(1, { name: '合成公司0', jobDescription: '', jdComplete: false, location: '上海' }); s.store.save(state, state.revision);
  await assert.rejects(s.act({ type: 'prepare_application', resumeId }), /明确选择/);
  state = await s.act({ type: 'prepare_applications', resumeId, candidateIds: ['job-0', 'job-1'] });
  assert.equal(state.applications.length, 2); assert.ok(state.applications.every(application => application.simulated && application.targetJob));
  assert.deepEqual(new Set(state.applications.map(application => application.targetJob!.location)), new Set(['北京', '上海']));
  assert.ok(state.events.some(event => event.detail.includes('详情待补充')));
  const snapshots = structuredClone(state.applications);
  state = await s.act({ type: 'prepare_applications', resumeId, candidateIds: ['job-0', 'job-1'] }); assert.deepEqual(state.applications, snapshots);
  assert.match(state.events[0].detail, /跳过 2/);
  await s.act({ type: 'clear_job' }); assert.deepEqual(s.store.read().applications, snapshots);
});

test('batch fill persists each independent failure and continues remaining entries', async t => {
  const s = setup(t, { browser: { fill: async ({ application }) => {
    if (application.company === '合成公司1') throw new Error('合成填写失败');
    if (application.company === '合成公司2') assert.equal(s.store.read().applications.find(item => item.company === '合成公司1')!.status, 'failed');
    return { evidence: 'synthetic.png' };
  } } });
  const { ids } = await s.prepare(); const state = await s.act({ type: 'fill_applications', applicationIds: ids });
  assert.equal(state.applications.find(application => application.id === ids[0])!.status, 'filled');
  assert.equal(state.applications.find(application => application.id === ids[1])!.status, 'failed');
  assert.equal(state.applications.find(application => application.id === ids[2])!.status, 'filled');
  assert.match(state.events[0].detail, /成功 2，未完成 1/); assert.equal(s.submits.length, 0);
});

test('batch submit checkpoints every item, preserves uncertain result and never retries confirmed or unknown', async t => {
  const submitted: string[] = [];
  const s = setup(t, { browser: { submit: async ({ application }) => {
    assert.equal(s.store.read().applications.find(item => item.id === application.id)!.status, 'submitting');
    submitted.push(application.id); const receipt = s.store.createReceipt(application.id);
    if (application.company === '合成公司1') throw new Error('合成接收后超时');
    return { receipt, evidence: 'synthetic.png' };
  } } });
  const { ids } = await s.prepare(); await s.act({ type: 'fill_applications', applicationIds: ids });
  await assert.rejects(s.act({ type: 'submit_applications', applicationIds: ids, confirmed: false }), /明确确认/);
  let state = await s.act({ type: 'submit_applications', applicationIds: ids, confirmed: true });
  assert.equal(state.applications.find(application => application.id === ids[1])!.status, 'unknown'); assert.match(state.events[0].detail, /成功 2，待核验 1/);
  state = await s.act({ type: 'submit_applications', applicationIds: ids, confirmed: true }); assert.equal(submitted.length, 3); assert.match(state.events[0].detail, /跳过 3/);
  await s.act({ type: 'fill_applications', applicationIds: ids }); assert.equal(s.fills.length, 3);
  state = await s.act({ type: 'verify_application', applicationId: ids[1] }); assert.ok(state.applications.every(application => application.status === 'confirmed'));
});

test('busy batches reject overlapping work and CAS conflicts stop before the next item', async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const running = new Promise<void>(resolve => { started = resolve; }); let calls = 0;
  const s = setup(t, { browser: { fill: async () => { calls++; started(); await gate; return { evidence: 'synthetic.png' }; } } });
  const { ids } = await s.prepare(); const revision = s.store.read().revision;
  const filling = s.workflow.act({ type: 'fill_applications', applicationIds: ids, expectedRevision: revision }); await running;
  await assert.rejects(s.workflow.act({ type: 'clear_job', expectedRevision: revision }), /还在执行/);
  const external = s.store.read(); external.questions = ['外部更新']; const saved = s.store.save(external, external.revision); release();
  await assert.rejects(filling, /版本已过期/); assert.equal(calls, 1); assert.deepEqual(s.store.read(), saved); assert.equal(s.workflow.isBusy, false);
});

test('batch preparation partial commits survive a later storage failure and retry skips saved targets', async t => {
  const s = setup(t); const resumeId = await s.approved(); const originalSave = s.store.save.bind(s.store); let saves = 0;
  const mock = t.mock.method(s.store, 'save', (...args: Parameters<Store['save']>) => { if (++saves === 2) throw new Error('synthetic disk failure'); return originalSave(...args); });
  await assert.rejects(s.act({ type: 'prepare_applications', resumeId, candidateIds: ['job-0', 'job-1', 'job-2'] }), /disk failure/); mock.mock.restore();
  assert.equal(s.store.read().applications.length, 1);
  const state = await s.act({ type: 'prepare_applications', resumeId, candidateIds: ['job-0', 'job-1', 'job-2'] }); assert.equal(state.applications.length, 3); assert.match(state.events[0].detail, /新增 2.*跳过 1/);
});

test('failed submit checkpoint cannot call browser or downgrade a state conflict to unknown', async t => {
  const s = setup(t); const { ids } = await s.prepare(); await s.act({ type: 'fill_applications', applicationIds: ids }); const before = s.store.read();
  const mock = t.mock.method(s.store, 'save', () => { throw new Error('synthetic checkpoint failure'); });
  await assert.rejects(s.act({ type: 'submit_applications', applicationIds: ids, confirmed: true }), /checkpoint failure/); mock.mock.restore();
  assert.equal(s.submits.length, 0); assert.deepEqual(s.store.read(), before);
});

test('scope and target snapshots survive restart; incomplete submit becomes unknown and numbering is retained', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhihang-scope-')); let store: Store | undefined; let db: DatabaseSync | undefined;
  t.after(() => { db?.close(); store?.close(); const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhihang-scope-')) throw new Error('Unsafe cleanup'); rmSync(target, { recursive: true, force: true }); });
  const path = join(directory, 'test.sqlite'); const s = setup(t, { path, close: false }); store = s.store;
  const { ids } = await s.prepare(); let state = store.read(); state.applications[0].status = 'submitting'; const scope = structuredClone(state.resumes[0].scope); const targetJobs = state.applications.map(application => structuredClone(application.targetJob)); store.save(state, state.revision); store.close(); store = undefined;
  store = new Store(path); state = store.read(); assert.equal(state.applications[0].status, 'unknown'); assert.deepEqual(state.resumes[0].scope, scope); assert.deepEqual(state.applications.map(application => application.targetJob), targetJobs);
  const workflow = new Workflow(store, createModelEngine({}), s.browser); await workflow.act({ type: 'fill_applications', applicationIds: [ids.at(-1)!], expectedRevision: state.revision }); assert.equal(store.read().applications[0].status, 'unknown');
  const revision = store.read().revision; store.close(); store = undefined;
  db = new DatabaseSync(path); const rowBefore = db.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string };
  store = new Store(path); assert.equal(store.read().revision, revision); assert.deepEqual((db.prepare('SELECT data FROM workspace WHERE id=1').get() as { data: string }).data, rowBefore.data); assert.equal(store.read().resumeVersionCounter, 1);
});

test('general generation failures leave existing series, numbering, approval and design snapshots unchanged', async t => {
  const s = setup(t); await s.approved(); const before = s.store.read();
  const workflow = new Workflow(s.store, createModelEngine({}), { ...s.browser, prepareResume: async () => { throw new Error('synthetic PDF QA failure'); } });
  await assert.rejects(workflow.act({ type: 'generate_general_resume', name: '不能保存', focus: '', expectedRevision: before.revision }), /QA failure/);
  assert.deepEqual(s.store.read(), before);
});

test('explicit target resolution rejects unknown IDs or exploration stubs without mutating the workspace', async t => {
  const s = setup(t); const state = s.store.read(); state.exploration!.companies[0].sourceKind = 'exploration'; s.store.save(state, state.revision);
  const before = s.store.read(); assert.throws(() => resolveResumeTargets(before, ['missing']), /不可用/); assert.throws(() => resolveResumeTargets(before, ['job-0']), /探索入口/);
  assert.deepEqual(s.store.read(), before);
});

test('an imported JD change invalidates its multi snapshot while preserving general and unrelated histories', async t => {
  const s = setup(t);
  await s.workflow.importBrowserCaptures({ protocolVersion: 1, requestId: randomUUID(), jobs: [{ platform: 'boss', pageKind: 'detail', sourceUrl: 'https://www.zhipin.com/job_detail/MultiScopeTest01.html', capturedAt: '2026-10-01T00:00:00Z', fields: {
    company: '合成导入公司', title: '资料实习', city: '北京', salary: '200元/天', education: '本科', experience: '不限', industry: '软件', jd: '协助整理资料与报名表，核对活动执行情况。', jdComplete: true,
  } }] });
  const captureId = Object.keys(s.store.read().browserCaptures!)[0];
  const general = await s.general();
  let state = await s.act({ type: 'generate_multi_resume', name: '有导入岗位', focus: '', candidateIds: [captureId, 'job-0'] }); const multi = state.resumes.at(-1)!;
  state = await s.act({ type: 'generate_multi_resume', name: '无导入岗位', focus: '', candidateIds: ['job-1', 'job-2'] }); const other = state.resumes.at(-1)!;
  state = await s.act({ type: 'save_browser_capture', captureId, edits: { jd: '协助整理资料与报名表，核对活动执行情况。新增职责：更新公开文档。' } });
  assert.equal(state.resumes.find(resume => resume.id === multi.id)!.stale, true);
  assert.equal(state.resumes.find(resume => resume.id === other.id)!.stale, false);
  assert.equal(state.resumes.find(resume => resume.id === general.id)!.stale, false);
  assert.ok(multi.scope!.targetJobs.some(job => job.candidateId === captureId && !job.text.includes('新增职责')));
});

test('a conflict after successful browser submission retains the persisted checkpoint and stops the batch', async t => {
  let submissions = 0;
  const s = setup(t, { browser: { submit: async ({ application }) => {
    submissions++; const receipt = s.store.createReceipt(application.id);
    const external = s.store.read(); external.questions = ['独立事务已更新']; s.store.save(external, external.revision);
    return { receipt, evidence: 'synthetic.png' };
  } } });
  const { ids } = await s.prepare(); await s.act({ type: 'fill_applications', applicationIds: ids });
  await assert.rejects(s.act({ type: 'submit_applications', applicationIds: ids, confirmed: true }), /版本已过期/);
  let state = s.store.read(); assert.equal(submissions, 1); assert.equal(state.applications.find(application => application.id === ids[0])!.status, 'submitting');
  assert.deepEqual(state.questions, ['独立事务已更新']); assert.equal(state.applications.find(application => application.id === ids[1])!.status, 'filled');
  state = await s.act({ type: 'verify_application', applicationId: ids[0] }); assert.equal(state.applications.find(application => application.id === ids[0])!.status, 'confirmed');
  await s.act({ type: 'submit_applications', applicationIds: [ids[0]], confirmed: true }); assert.equal(submissions, 1);
});

test('a resume referenced by an independent real application is not deleted or cleaned up', async t => {
  const cleaned: string[] = []; const s = setup(t, { browser: { resumeInUse: () => true, removeResume: async id => { cleaned.push(id); } } });
  const resume = await s.general(); const before = s.store.read();
  await assert.rejects(s.act({ type: 'delete_resume', resumeId: resume.id }), /先删除对应真实网申记录/);
  assert.deepEqual(s.store.read(), before); assert.deepEqual(cleaned, []);
});

test('16000-character JD endings survive metadata assembly and multi scope accepts exactly 48000 characters', async t => {
  const s = setup(t); const original = `${'任'.repeat(15989)}仅末尾的硬性要求须保留`;
  assert.equal(original.length, 16000);
  assert.equal(candidateJob(candidate(0, { jobDescription: original })).text, original);
  await s.workflow.importBrowserCaptures({ protocolVersion: 1, requestId: randomUUID(), jobs: [{ platform: 'boss', pageKind: 'detail', sourceUrl: 'https://www.zhipin.com/job_detail/LongScopeTest01.html', capturedAt: '2026-10-01T00:00:00Z', fields: {
    company: '长文合成公司', title: '资料实习', city: '北京', salary: '200元/天', education: '本科', experience: '不限', industry: '软件', jd: original, jdComplete: true,
  } }] });
  let state = s.store.read(); const record = Object.values(state.browserCaptures!)[0];
  assert.equal(captureJob(record).text, original); assert.equal(resolveResumeTargets(state, [record.id])[0].text, original);
  for (const company of state.exploration!.companies.filter(company => ['job-0', 'job-1'].includes(company.id))) company.jobDescription = original;
  s.store.save(state, state.revision);
  state = await s.act({ type: 'generate_multi_resume', name: '保留完整末尾', focus: '', candidateIds: [record.id, 'job-0', 'job-1'] });
  assert.equal(state.resumes.at(-1)!.scope!.targetJobs.reduce((sum, job) => sum + job.text.length, 0), 48000);
  assert.ok(state.resumes.at(-1)!.scope!.targetJobs.every(job => job.text.endsWith('仅末尾的硬性要求须保留')));
});

test('current job and candidate aliases deduplicate by normalized URL while different cities stay separate', async t => {
  const s = setup(t); const state = s.store.read();
  state.exploration!.companies[1] = candidate(1, { careerUrl: state.exploration!.companies[0].careerUrl, location: '上海' });
  state.job = { ...candidateJob(state.exploration!.companies[0]), url: `${state.exploration!.companies[0].careerUrl}?utm_source=test` }; delete state.job.candidateId;
  assert.equal(resolveResumeTargets(state, ['job-0'], true).length, 1);
  assert.equal(resolveResumeTargets(state, ['job-0', 'job-1'], true).length, 2);
});
