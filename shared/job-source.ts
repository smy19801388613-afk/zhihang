import type { CompanyCandidate, Job } from './types.ts';

export type JobSourceKind = 'user_jd' | 'exploration' | 'official_job' | 'jobspy' | 'browser_capture' | 'public_job';
/** Keep every character of the JD. Optional metadata yields to the original text. */
export function jobText(metadata: string[], description: string): string {
  const lines = metadata.filter(Boolean);
  while (lines.length && [...lines, description].join('\n').length > 16000) lines.pop();
  return [...lines, description].join('\n');
}
export function candidateSourceKind(company: CompanyCandidate): JobSourceKind {
  if (company.sourceKind) return company.sourceKind;
  // Legacy cards recorded their producer in an id/label before sourceKind existed.
  if (company.id.startsWith('jobspy_') || /JobSpy/i.test(company.sourceLabel)) return 'jobspy';
  if (company.id.startsWith('capture-') || /浏览器导入/.test(company.sourceLabel)) return 'browser_capture';
  if (!company.jobDescription?.trim()) return 'exploration';
  if (company.id.startsWith('official_') || /官网/.test(company.sourceLabel) && company.hiringStatus === 'listed') return 'official_job';
  return 'public_job';
}
export function sourceName(kind?: JobSourceKind, platform?: 'boss' | '58') {
  return kind === 'browser_capture' ? `浏览器扩展${platform ? ` · ${platform === 'boss' ? 'BOSS直聘' : '58同城'}` : ''}`
    : kind === 'jobspy' ? 'JobSpy · 第三方招聘平台' : kind === 'official_job' ? '企业官网 · 具体职位'
      : kind === 'exploration' ? '公司探索 · 官网入口' : kind === 'user_jd' ? '手动添加 JD' : '公开岗位 · 来源待核对';
}
export function candidateJob(company: CompanyCandidate): Job {
  const sourceKind = candidateSourceKind(company);
  const description = company.jobDescription?.trim() || '';
  return { company: company.name, title: company.role, industry: company.industry, roleFamily: company.role, location: company.location || '',
    candidateId: company.id, url: company.careerUrl, sourceKind, sourceLabel: company.sourceLabel,
    jdComplete: !!description && company.jdComplete !== false,
    text: description ? jobText([`行业：${company.industry}`, company.location ? `地点：${company.location}` : '', company.salary ? `薪资：${company.salary}` : '', company.jobType ? `招聘类型：${company.jobType}` : '', `来源：${company.sourceLabel}；获取时间：${company.checkedAt}。`], description) : '',
  };
}
