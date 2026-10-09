import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Job, WorkspaceState } from '../shared/types';
import { jobTargetKey, reusableTargetOptions, resolveResumeTargets } from '../shared/resume-scope';
import { sourceName } from '../shared/job-source';

export function selectedTargets(state: WorkspaceState, ids: string[], current: boolean, requireComplete = false): { targets: Job[]; error: string } {
  if (!ids.length && !current) return { targets: [], error: '' };
  try { return { targets: resolveResumeTargets(state, ids, current, { requireComplete }), error: '' }; }
  catch (error) { return { targets: [], error: error instanceof Error ? error.message : '请重新选择岗位。' }; }
}
const validLink = (value: string) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
export const jobLabel = (job: Job) => [job.company, job.title, job.location].filter(Boolean).join(' · ');

export default function ResumeTargetPicker({ state, ids, includeCurrent, onChange, disabled, max = 20, requireComplete = false, label }: {
  state: WorkspaceState; ids: string[]; includeCurrent: boolean; onChange: (ids: string[], includeCurrent: boolean) => void;
  disabled: boolean; max?: number; requireComplete?: boolean; label: string;
}) {
  const [likedOnly, setLikedOnly] = useState(true);
  const options = reusableTargetOptions(state), visible = options.filter(option => !likedOnly || option.selected || ids.includes(option.id));
  const currentAvailable = !!state.job.company.trim() && !!state.job.title.trim();
  const problem = (job: Job) => !job.company.trim() || !job.title.trim() ? '公司或岗位名待补充' : job.sourceKind === 'exploration' ? '公司探索，需补充具体岗位' : requireComplete && (job.jdComplete === false || job.text.trim().length < 10) ? '详情待补充' : '';
  const count = ids.length + (includeCurrent ? 1 : 0);
  function row(job: Job, selected: boolean, toggle: () => void, key: string, current = false) {
    const reason = problem(job), unavailable = !selected && (!!reason || count >= max);
    return <article className={`resume-target-option ${selected ? 'selected' : ''}`} key={key} data-target-key={jobTargetKey(job)} data-target-id={key}>
      <label><input type="checkbox" aria-label={`${label}：${jobLabel(job)}${current ? '（当前岗位）' : ''}`} checked={selected} disabled={disabled || unavailable} onChange={toggle} /><span><strong>{job.company || '公司待补充'} · {job.title || '岗位待补充'}{current && <em>当前岗位</em>}</strong><span>{job.location || '城市未提供'} · {sourceName(job.sourceKind)}</span><small>{reason || (job.jdComplete === false || !job.text.trim() ? '详情待补充 · 可使用通用简历' : '已有岗位描述')} · 招聘状态以来源页面为准</small></span></label>
      {validLink(job.url) && <a href={job.url} target="_blank" rel="noreferrer">招聘来源<ArrowUpRight size={13} /></a>}
    </article>;
  }
  return <section className="resume-target-picker" aria-label={label}>
    <div className="resume-target-toolbar"><label><input type="checkbox" checked={likedOnly} disabled={disabled} onChange={event => setLikedOnly(event.target.checked)} />仅看喜欢的岗位</label><span>已勾选 {count} 项 · 最多 {max} 项</span><button type="button" className="button quiet" disabled={disabled || !count} onClick={() => onChange([], false)}>清除岗位选择</button></div>
    <div className="resume-target-options">
      {currentAvailable && row(state.job, includeCurrent, () => onChange(ids, !includeCurrent), 'current', true)}
      {visible.map(option => row(option.job, ids.includes(option.id), () => onChange(ids.includes(option.id) ? ids.filter(id => id !== option.id) : [...ids, option.id], includeCurrent), option.id))}
      {!visible.length && <p className="subtle-text">{options.length ? '当前没有已喜欢的岗位，可取消筛选查看已有岗位。' : '还没有可选岗位。先在“方向与公司”喜欢岗位，或用浏览器扩展导入。'}</p>}
    </div>
    {requireComplete && <p className="subtle-text">多岗位简历需要完整 JD。详情待补充的岗位可先打开来源补全，也可以改为生成通用简历。</p>}
  </section>;
}
