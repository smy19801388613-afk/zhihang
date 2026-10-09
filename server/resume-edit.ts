import { randomUUID } from 'node:crypto';
import type { Job, Profile, ResumeDocument, ResumeVersion, WorkspaceState } from '../shared/types.ts';
import { toResumeDocument } from '../shared/resume-template.ts';
import { validateExperienceScope, validateNumbers } from './resume-grounding.ts';
import { summarizeResumeChanges } from '../shared/resume-diff.ts';
import { normalizedJobUrl } from '../shared/resume-scope.ts';

export const jobKey = (company: string, title: string) => `${company.trim().toLowerCase().replace(/\s+/g, '')}\n${title.trim().toLowerCase().replace(/\s+/g, '')}`;
export function allocateResumeVersion(state: WorkspaceState): number {
  const previous = Math.max(0, state.resumeVersionCounter || 0, ...state.resumes.map(resume => resume.version));
  if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) throw new Error('简历版本编号已超出范围，请联系维护人员。');
  state.resumeVersionCounter = previous + 1;
  return state.resumeVersionCounter;
}
export function sameTargetJob(left: Pick<Job, 'company' | 'title'> & Partial<Job>, right: Pick<Job, 'company' | 'title'> & Partial<Job>): boolean {
  const city = (value?: string) => (value || '').trim().toLowerCase().replace(/\s+/gu, '');
  if (city(left.location) && city(right.location) && city(left.location) !== city(right.location)) return false;
  const leftUrl = normalizedJobUrl(left.url || ''), rightUrl = normalizedJobUrl(right.url || '');
  if (leftUrl && rightUrl && leftUrl === rightUrl) return true;
  if (left.candidateId && right.candidateId) return left.candidateId === right.candidateId;
  if (leftUrl && rightUrl) return false;
  return jobKey(left.company, left.title) === jobKey(right.company, right.title);
}

export function sameResumeCollection(left: ResumeVersion, right: ResumeVersion): boolean {
  if (left.scope || right.scope) return Boolean(left.scope && right.scope && left.collectionId && left.collectionId === right.collectionId);
  return sameTargetJob(left.job, right.job);
}

export function markSuperseded(state: WorkspaceState, resume: ResumeVersion) {
  const supersededIds = new Set<string>();
  for (const previous of state.resumes) {
    if (previous.id !== resume.id && sameResumeCollection(previous, resume)) { previous.stale = true; supersededIds.add(previous.id); }
  }
  for (const app of state.applications) {
    if (supersededIds.has(app.resumeId) && ['prepared', 'filled'].includes(app.status)) {
      app.status = 'failed'; app.error = '此简历系列已更新，请使用新版本重新准备。'; app.updatedAt = new Date().toISOString();
    }
  }
}

export function documentText(document: ResumeDocument): string {
  return [document.headline, document.summary, ...document.sections.flatMap(section => section.items.flatMap(item => [item.title, item.subtitle, item.date, item.content]))].join('\n');
}

/** Evidence IDs and quantitative claims are checked separately from wording changes. */
export function validateModelEdit(resume: ResumeVersion, document: ResumeDocument) {
  const allowedIds = new Set(resume.profile.facts.filter(f => f.confirmed).map(f => f.id));
  const items = document.sections.flatMap(s => s.items);
  if (items.some(item => item.factIds.some(id => !allowedIds.has(id)))) throw new Error('修改结果引用了未确认经历，已拦截。请先补充并确认相关事实。');
  const original = toResumeDocument(resume);
  const facts = resume.profile.facts.filter(f => f.confirmed);
  const source = `${documentText(original)}\n${facts.map(f => [f.sourceContext,f.text].filter(Boolean).join('\n')).join('\n')}`;
  validateNumbers(source, [document.headline, document.summary, ...document.sections.map(s => s.title)].join('\n'), '修改结果');
  for (const item of items) {
    const previous = original.sections.flatMap(s => s.items).find(i => i.id === item.id);
    const evidence = [previous ? [previous.title, previous.subtitle, previous.date, previous.content].join('\n') : '', ...facts.filter(f => item.factIds.includes(f.id)).map(f => [f.sourceContext,f.text].filter(Boolean).join('\n'))].join('\n');
    const output = [item.title, item.subtitle, item.date, item.content].join('\n');
    validateNumbers(evidence, output, `修改条目“${item.title || item.id}”`);
    validateExperienceScope(evidence, output, `修改条目“${item.title || item.id}”`);
  }
}

export function createEditedVersion(state: WorkspaceState, base: ResumeVersion, document: ResumeDocument, profile: Omit<Profile, 'facts'>, options: { authoredBy: 'user' | 'model'; message: string; instruction?: string; reviewNotes?: string[] }): ResumeVersion {
  const items = document.sections.flatMap(s => s.items).filter(item => item.content.trim());
  if (!items.length) throw new Error('请保留至少一条经历内容，再保存简历。');
  const changedProfile = (['name', 'email', 'phone', 'school', 'education', 'major', 'graduation', 'city', 'availability', 'targetRole'] as const).filter(key => (profile[key] || '') !== (base.profile[key] || ''));
  const rationale = changedProfile.length ? `${summarizeResumeChanges(toResumeDocument(base), document)} 基本资料另有 ${changedProfile.length} 项变更，请核对编辑器内的修改前后内容。` : summarizeResumeChanges(toResumeDocument(base), document);
  const next: ResumeVersion = {
    ...structuredClone(base), id: randomUUID(), version: allocateResumeVersion(state), parentId: base.id,
    createdAt: new Date().toISOString(), approved: false, stale: false,
    profile: { ...structuredClone(base.profile), ...profile }, document: structuredClone(document),
    bullets: items.map(item => ({ text: [item.title, item.subtitle, item.date, item.content].filter(Boolean).join('\n'), factIds: item.factIds })),
    authoredBy: options.authoredBy, rationale,
    reviewNotes: options.reviewNotes || ['这是你在网页中修改的新版本。请核对全部内容后再次确认。'],
    editMessages: [
      ...(base.editMessages || []),
      ...(options.instruction ? [{ role: 'user' as const, content: options.instruction }, { role: 'assistant' as const, content: options.message }] : [])
    ].slice(-30)
  };
  markSuperseded(state, next);
  state.resumes.push(next); state.activeResumeId = next.id;
  return next;
}
