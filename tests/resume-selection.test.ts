import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile } from '../server/store.ts';
import { selectWorkspaceResume } from '../shared/resume-selection.ts';
import type { Job, ResumeVersion } from '../shared/types.ts';

const jobA: Job = { company: '合成甲公司', title: '产品实习生', text: '整理用户访谈资料，维护需求清单。', url: '', sourceKind: 'user_jd', jdComplete: true };
const jobB: Job = { ...jobA, company: '合成乙公司', text: '维护活动报名表，整理活动反馈。' };
const resume = (id: string, job: Job, stale = false): ResumeVersion => ({
  id, version: 1, createdAt: '2026-10-05T00:00:00Z', profile: emptyProfile(), job,
  bullets: [], rationale: '', approved: false, stale,
});

test('saving a different manual target never falls back to another company resume', () => {
  const a = resume('a', jobA);
  assert.equal(selectWorkspaceResume({ job: jobB, resumes: [a], activeResumeId: null }, ''), undefined);
  // Even an outdated active id must not hide the new target preparation screen.
  assert.equal(selectWorkspaceResume({ job: jobB, resumes: [a], activeResumeId: a.id }, ''), undefined);
});

test('automatic selection chooses a current matching version rather than the last global resume', () => {
  const a = resume('a', jobA); const b = resume('b', jobB);
  assert.equal(selectWorkspaceResume({ job: jobA, resumes: [a, b], activeResumeId: null }, ''), a);
});

test('changed JD and stale versions return to preparation, including after reload', () => {
  const a = resume('a', jobA);
  assert.equal(selectWorkspaceResume({ job: { ...jobA, text: '新的完整职责与资格要求。' }, resumes: [a], activeResumeId: a.id }, ''), undefined);
  assert.equal(selectWorkspaceResume({ job: jobA, resumes: [{ ...a, stale: true }], activeResumeId: a.id }, ''), undefined);
});

test('identically named vacancies keep their distinct candidate identities', () => {
  const a = resume('a', { ...jobA, candidateId: 'city-a' });
  assert.equal(selectWorkspaceResume({ job: { ...jobA, candidateId: 'city-b' }, resumes: [a], activeResumeId: a.id }, ''), undefined);
  assert.equal(selectWorkspaceResume({ job: jobA, resumes: [a], activeResumeId: a.id }, ''), undefined);
});

test('explicit version dropdown selection retains access to other targets and history', () => {
  const a = resume('a', jobA, true);
  const state = { job: jobB, resumes: [a], activeResumeId: null };
  assert.equal(selectWorkspaceResume(state, a.id), a);
  // save_job/open_company clear the explicit id, restoring current-target selection.
  assert.equal(selectWorkspaceResume(state, ''), undefined);
});

test('a cleared workspace target stays empty until a historical version is explicitly selected', () => {
  const a = resume('a', jobA);
  const state = { job: { company: '', title: '', text: '', url: '' }, resumes: [a], activeResumeId: null };
  assert.equal(selectWorkspaceResume(state, ''), undefined);
  assert.equal(selectWorkspaceResume({ ...state, activeResumeId: a.id }, ''), undefined);
  assert.equal(selectWorkspaceResume(state, a.id), a);
});

test('active general and multi resumes open without pretending to be the current company', () => {
  const a = { ...resume('general', { company: '', title: '运营通用', text: '', url: '' }), scope: { kind: 'general' as const, name: '运营通用', focus: '运营', targetJobs: [] } };
  const empty = { company: '', title: '', text: '', url: '' };
  assert.equal(selectWorkspaceResume({ job: empty, resumes: [a], activeResumeId: a.id }, ''), a);
  assert.equal(selectWorkspaceResume({ job: jobB, resumes: [a], activeResumeId: a.id }, ''), a);
  assert.equal(selectWorkspaceResume({ job: empty, resumes: [a], activeResumeId: null }, ''), undefined);
  assert.equal(selectWorkspaceResume({ job: empty, resumes: [{ ...a, stale: true }], activeResumeId: a.id }, ''), undefined);
  assert.equal(selectWorkspaceResume({ job: empty, resumes: [{ ...a, scope: { ...a.scope, kind: 'multi', targetJobs: [jobA, jobB] } }], activeResumeId: a.id }, '')?.scope?.kind, 'multi');
});
