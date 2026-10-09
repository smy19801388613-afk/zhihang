import type { Application, Job, ResumeVersion, WorkspaceState } from './types.ts';
import { candidateJob, jobText } from './job-source.ts';

export interface ResumeScope {
  kind: 'general' | 'multi'; name: string; focus: string; targetJobs: Job[];
}
export const MAX_SHARED_RESUME_JOBS = 8;
export const MAX_BATCH_APPLICATIONS = 20;
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/gu, '');
export function normalizedJobUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|ka$|from$|source$|spm$|ref$)/iu.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString().replace(/\/$/u, '');
  } catch { return ''; }
}
export function jobTargetKey(job: Job): string {
  const url = normalizedJobUrl(job.url);
  if (url) return `url:${url}|${normalize(job.location || '')}`;
  if (job.candidateId) return `candidate:${job.candidateId}`;
  return `manual:${normalize(job.company)}|${normalize(job.title)}|${normalize(job.location || '')}`;
}
export function resumeLabel(resume: ResumeVersion): string {
  return resume.scope ? `${resume.scope.name} · ${resume.scope.kind === 'general' ? '通用简历' : `${resume.scope.targetJobs.length} 个岗位共用`}` : `${resume.job.company} · ${resume.job.title}`;
}
export function applicationTarget(application: Application, resume?: ResumeVersion): Job {
  return application.targetJob || resume?.job || { company: application.company, title: application.jobTitle, text: '', url: '' };
}
export interface ResumeTargetOption { id: string; job: Job; selected: boolean }
export function reusableTargetOptions(state: WorkspaceState): ResumeTargetOption[] {
  const options = new Map<string, ResumeTargetOption>();
  for (const candidate of state.exploration?.companies || []) {
    const saved = state.companyJobs?.[candidate.id];
    const job = saved || { ...candidateJob(candidate), location: candidate.location || '' };
    options.set(candidate.id, { id: candidate.id, job, selected: candidate.selected });
  }
  for (const capture of Object.values(state.browserCaptures || {})) {
    options.set(capture.id, { id: capture.id, selected: capture.selected, job: {
      candidateId: capture.id, company: capture.fields.company, title: capture.fields.title,
      text: jobText([capture.fields.industry ? `行业：${capture.fields.industry}` : '', capture.fields.city ? `地点：${capture.fields.city}` : '', capture.fields.salary ? `薪资：${capture.fields.salary}` : '', capture.fields.education ? `学历要求：${capture.fields.education}` : '', capture.fields.experience ? `经验要求：${capture.fields.experience}` : ''], capture.fields.jd), url: capture.sourceUrl, location: capture.fields.city,
      sourceKind: 'browser_capture', sourceLabel: `浏览器扩展 · ${capture.platform === 'boss' ? 'BOSS直聘' : '58同城'}`,
      jdComplete: capture.fields.jdComplete, industry: capture.fields.industry, roleFamily: capture.fields.title,
    } });
  }
  return [...options.values()];
}
export function resolveResumeTargets(state: WorkspaceState, candidateIds: string[], includeCurrentJob = false, options: { requireComplete?: boolean } = {}): Job[] {
  if (candidateIds.length > MAX_BATCH_APPLICATIONS || new Set(candidateIds).size !== candidateIds.length) throw new Error('请选择不重复的岗位，每次最多 20 个。');
  const available = new Map(reusableTargetOptions(state).map(option => [option.id, option.job]));
  const targets = candidateIds.map(id => {
    const job = available.get(id);
    if (!job) throw new Error('部分岗位已不可用，请刷新清单后重新选择。');
    return structuredClone(job);
  });
  if (includeCurrentJob) targets.unshift(structuredClone(state.job));
  const unique = new Map<string, Job>();
  for (const job of targets) {
    if (!job.company.trim() || !job.title.trim()) throw new Error('请先补全所选岗位的公司和名称。');
    if (job.sourceKind === 'exploration') throw new Error(`${job.company}仍是公司探索入口，请先补充具体岗位与真实 JD。`);
    if (options.requireComplete && (job.jdComplete === false || job.text.trim().length < 10)) throw new Error(`${job.company} · ${job.title} 的详情待补充，请先补全 JD；也可选择生成通用简历。`);
    unique.set(jobTargetKey(job), job);
  }
  if (!unique.size || unique.size > MAX_BATCH_APPLICATIONS) throw new Error('请选择 1 至 20 个具体岗位。');
  return [...unique.values()];
}
