import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { Workflow, exampleProfile } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { candidateJob, candidateSourceKind, sourceName } from '../shared/job-source.ts';
import { actionSchema } from '../server/validation.ts';
import type { CompanyCandidate } from '../shared/types.ts';

const company = (overrides: Partial<CompanyCandidate> = {}): CompanyCandidate => ({ id: 'jobspy_test', name: '合成招聘公司', role: '法务实习生', industry: '互联网', rationale: '方向匹配', requirements: [], careerUrl: 'https://example.com/job/1', sourceLabel: 'LinkedIn 公开岗位 · JobSpy', checkedAt: '2026-10-05T00:00:00Z', hiringStatus: 'listed', selected: true, decision: 'like', jobDescription: '岗位职责：检索法律资料，整理对比表。任职条件：本科在读，能够使用 Excel。', ...overrides });
test('producer types distinguish JobSpy, official postings, imported jobs and company-only entrances', () => {
  assert.equal(candidateSourceKind(company()), 'jobspy');
  assert.equal(candidateSourceKind(company({ id: 'official_tencent_1', sourceLabel: '腾讯校园招聘官网' })), 'official_job');
  assert.equal(candidateSourceKind(company({ id: 'capture-1', sourceLabel: 'BOSS直聘 · 浏览器导入' })), 'browser_capture');
  const seed = company({ id: 'deloitte-direction', sourceLabel: '官方招聘入口 / 候选企业（岗位待核验）', jobDescription: undefined, hiringStatus: 'unverified' });
  assert.equal(candidateSourceKind(seed), 'exploration'); assert.equal(candidateJob(seed).text, ''); assert.equal(candidateJob(seed).jdComplete, false);
  assert.equal(candidateJob(company()).sourceKind, 'jobspy'); assert.match(sourceName('exploration'), /公司探索/);
});
test('opening a liked company saves the correct workspace even when generation is unavailable', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const initial = store.read(); initial.profile = { ...exampleProfile, facts: [] };
  initial.exploration!.companies = [company(), company({ id: 'deloitte-direction', name: '合成德勤方向', jobDescription: undefined, sourceLabel: '官方招聘入口', hiringStatus: 'unverified' })];
  store.save(initial, initial.revision);
  let calls = 0;
  const engine = { ...createModelEngine({}), analyzeJob: async () => { calls++; throw new Error('模型暂不可用'); }, draftResume: async () => { calls++; throw new Error('模型暂不可用'); } };
  const workflow = new Workflow(store, engine, { fill: async () => ({ evidence: '' }), submit: async () => ({ receipt: '', evidence: '' }) });
  assert.equal(actionSchema.safeParse({ type: 'open_company', companyId: 'jobspy_test', expectedRevision: store.read().revision }).success, true);
  let state = await workflow.act({ type: 'open_company', companyId: 'jobspy_test', expectedRevision: store.read().revision });
  assert.equal(state.job.candidateId, 'jobspy_test'); assert.equal(state.job.sourceKind, 'jobspy'); assert.equal(state.activeResumeId, null); assert.equal(calls, 0);
  state = await workflow.act({ type: 'open_company', companyId: 'deloitte-direction', expectedRevision: state.revision });
  assert.equal(state.job.text, ''); assert.equal(state.job.jdComplete, false); assert.equal(state.job.sourceKind, 'exploration'); assert.equal(calls, 0);
  await assert.rejects(workflow.act({ type: 'analyze_job', expectedRevision: state.revision }), /招聘要求/);
  assert.equal(store.read().job.company, '合成德勤方向');
});
test('elaborating the same career direction preserves chosen directions and liked cards', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const initial = store.read(); initial.profile = { ...exampleProfile, facts: [] };
  const direction = { id: 'old-id', industry: '互联网', role: '法务实习生', rationale: '旧说明', transferableSkills: ['检索'], gaps: [], entryRequirements: '本科', salaryContext: '待核实' };
  initial.exploration = { messages: [], directions: [direction], selectedDirectionIds: [direction.id], companies: [company()], stage: 'companies', swipeHistory: [] };
  store.save(initial, initial.revision);
  const career = { ...createCareerEngine({}), chat: async () => ({ message: '展开解释工作日常。', directions: [{ ...direction, id: 'new-stable-id', rationale: '新的详细说明' }] }) };
  const workflow = new Workflow(store, createModelEngine({}), { fill: async () => ({ evidence: '' }), submit: async () => ({ receipt: '', evidence: '' }) }, career);
  const state = await workflow.act({ type: 'career_chat', message: '请展开解释日常工作，不要重复问我偏好', expectedRevision: store.read().revision });
  assert.deepEqual(state.exploration!.selectedDirectionIds, ['new-stable-id']); assert.equal(state.exploration!.companies[0].selected, true); assert.equal(state.exploration!.stage, 'companies');
});
