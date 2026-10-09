import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { Workflow, exampleProfile, type JobDiscovery } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { actionSchema } from '../server/validation.ts';
import type { Action, CompanyCandidate, JobDiscoveryResult } from '../shared/types.ts';

async function setup(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let unavailable = false; let empty = false;
  let queryCity = '';
  const fetchJobs: JobDiscovery = async ({ companies, profile }) => {
    queryCity = profile.city;
    if (unavailable) throw new Error('private upstream diagnostic');
    const seed = companies.find(company => company.name === '腾讯') || companies[0];
    const candidates: CompanyCandidate[] = empty ? [] : ['上海', '深圳'].map((location, index) => ({
      ...seed, id: `official_job_${index}`, name: '腾讯', role: '业务合规实习生', location,
      salary: '未披露', careerUrl: `https://join.qq.com/post.html?postId=${index}`,
      sourceJobId: String(index), jobType: '实习', hiringStatus: 'listed', sourceKind: 'official_job', jdComplete: true,
      checkedAt: '2026-10-03T00:00:00Z', sourceLabel: '官方测试来源', selected: false,
      jobDescription: `岗位职责：检索法律与业务资料，整理对比表并协助合规研究。工作地点：${location}。任职要求：本科及以上在校生，每周四天。`,
    }));
    return { candidates, sources: [{ id: 'test', label: '官方测试来源', status: 'ok', count: candidates.length }], fetchedAt: '2026-10-03T00:00:00Z' } satisfies JobDiscoveryResult;
  };
  const workflow = new Workflow(store, createModelEngine({}), { fill: async () => ({ evidence: 'test.png' }), submit: async () => ({ receipt: 'TEST', evidence: 'test.png' }) }, createCareerEngine({}), fetchJobs);
  const act = (action: Action) => workflow.act({ ...action, expectedRevision: store.read().revision });
  let state = await act({ type: 'extract_profile', profile: { ...exampleProfile, major: '法学' } });
  for (const fact of state.profile.facts) await act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
  state = await act({ type: 'career_chat', message: '希望考虑互联网合规，上海或深圳，重视成长。' });
  await act({ type: 'select_directions', directionIds: [state.exploration!.directions[0].id] });
  await act({ type: 'recommend_companies' });
  return { store, act, workflow, queryCity: () => queryCity, unavailable: () => { unavailable = true; }, empty: () => { empty = true; } };
}

test('swipes save decisions, undo precisely, and reject stale or unknown actions', async t => {
  const s = await setup(t); const before = s.store.read();
  assert.equal(s.queryCity(), '上海、深圳', 'Latest city preference from career dialogue reaches job filtering');
  assert.equal(before.exploration!.companies[0].selected, false);
  await assert.rejects(s.act({ type: 'activate_company', companyId: 'official_job_0' }), /右滑/);
  let state = await s.act({ type: 'swipe_company', companyId: 'official_job_0', decision: 'like' });
  assert.equal(state.exploration!.companies[0].selected, true);
  await assert.rejects(s.workflow.act({ type: 'swipe_company', companyId: 'official_job_1', decision: 'dislike', expectedRevision: before.revision }), /版本已过期/);
  await s.act({ type: 'swipe_company', companyId: 'official_job_1', decision: 'dislike' });
  state = await s.act({ type: 'undo_company_swipe' });
  assert.equal(state.exploration!.companies[1].decision, undefined);
  assert.equal(state.exploration!.companies[0].decision, 'like');
  await s.act({ type: 'swipe_company', companyId: 'official_job_0', decision: 'dislike' });
  state = await s.act({ type: 'undo_company_swipe' });
  assert.equal(state.exploration!.companies[0].decision, 'like');
  assert.equal(state.exploration!.companies[0].selected, true);
  await assert.rejects(s.act({ type: 'swipe_company', companyId: 'unknown', decision: 'like' }), /卡片已变化/);
  assert.equal(actionSchema.safeParse({ type: 'swipe_company', companyId: 'official_job_0', decision: 'submit', expectedRevision: 1 }).success, false);
  assert.equal(s.store.read().applications.length, 0, 'Liking never submits or prepares an application');
});

test('refresh keeps choices and marks missing saved postings unverified without fabricating freshness', async t => {
  const s = await setup(t);
  await s.act({ type: 'swipe_company', companyId: 'official_job_0', decision: 'like' });
  await s.act({ type: 'swipe_company', companyId: 'official_job_1', decision: 'dislike' });
  let state = await s.act({ type: 'refresh_jobs' });
  assert.equal(state.exploration!.companies.find(c => c.id === 'official_job_0')!.selected, true);
  assert.equal(state.exploration!.companies.find(c => c.id === 'official_job_1')!.decision, 'dislike');
  s.empty(); state = await s.act({ type: 'refresh_jobs' });
  const saved = state.exploration!.companies.find(c => c.id === 'official_job_0')!;
  assert.equal(saved.selected, true); assert.equal(saved.hiringStatus, 'unverified');
  assert.equal(saved.checkedAt, '2026-10-03T00:00:00Z');
  assert.match(saved.sourceLabel, /本次未重新获取/);
  assert.equal(state.exploration!.companies.find(c => c.id === 'official_job_1')!.decision, 'dislike', 'Temporary source absence must not erase a skip decision');
  s.unavailable(); state = await s.act({ type: 'refresh_jobs' });
  assert.equal(state.exploration!.jobSearch!.sources[0].status, 'error');
  assert.ok(!JSON.stringify(state).includes('private upstream'));
});

test('real JD and stable posting ID bind resumes, including two same-title jobs at one company', async t => {
  const s = await setup(t);
  await s.act({ type: 'swipe_company', companyId: 'official_job_0', decision: 'like' });
  await s.act({ type: 'swipe_company', companyId: 'official_job_1', decision: 'like' });
  let state = await s.act({ type: 'activate_company', companyId: 'official_job_0' });
  const first = state.resumes.at(-1)!;
  assert.equal(first.job.sourceKind, 'official_job'); assert.match(first.job.text, /工作地点：上海/);
  await s.act({ type: 'approve_resume', resumeId: first.id });
  await s.act({ type: 'prepare_application', resumeId: first.id });
  state = await s.act({ type: 'activate_company', companyId: 'official_job_1' });
  const second = state.resumes.at(-1)!;
  assert.match(second.job.text, /工作地点：深圳/);
  assert.equal(state.resumes.find(r => r.id === first.id)!.stale, false);
  assert.equal(state.applications[0].status, 'prepared');
  await s.act({ type: 'approve_resume', resumeId: second.id });
  state = await s.act({ type: 'prepare_application', resumeId: second.id });
  assert.equal(state.applications.length, 2);
  state = await s.act({ type: 'activate_company', companyId: 'official_job_0' });
  assert.equal(state.activeResumeId, first.id);
});

test('manual job corrections survive source refresh and profile changes prevent stale swipes', async t => {
  const s = await setup(t);
  await s.act({ type: 'swipe_company', companyId: 'official_job_0', decision: 'like' });
  let state = await s.act({ type: 'activate_company', companyId: 'official_job_0' });
  const edited = { ...state.job, text: '用户核对后的真实岗位描述：研究业务规则，维护法规资料库，协助整理比较分析。' };
  await s.act({ type: 'save_job', job: edited });
  await s.act({ type: 'refresh_jobs' });
  state = await s.act({ type: 'activate_company', companyId: 'official_job_0' });
  assert.equal(state.job.text, edited.text); assert.equal(state.job.sourceKind, 'user_jd');
  const fact = state.profile.facts[0];
  await s.act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: false });
  await assert.rejects(s.act({ type: 'swipe_company', companyId: 'official_job_1', decision: 'like' }), /重新评估/);
  await assert.rejects(s.act({ type: 'refresh_jobs' }), /先对话/);
});
