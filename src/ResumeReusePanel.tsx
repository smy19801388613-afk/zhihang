import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Send } from 'lucide-react';
import type { Action, Job, ResumeVersion, WorkspaceState } from '../shared/types';
import { resumeLabel } from '../shared/resume-scope';
import ResumeTargetPicker, { jobLabel, selectedTargets } from './ResumeTargetPicker';

export type RealApplicationSlotProps = { resume: ResumeVersion; candidateIds: string[]; includeCurrentJob: boolean; targets: Job[]; busy: boolean; blocked: boolean };
export default function ResumeReusePanel({ state, resume, busy, blocked, open, onOpen, act, renderReal }: {
  state: WorkspaceState; resume: ResumeVersion; busy: boolean; blocked: boolean; open: boolean; onOpen: (open: boolean) => void;
  act: (action: Action, message?: string) => Promise<WorkspaceState | null>;
  renderReal?: (props: RealApplicationSlotProps) => ReactNode;
}) {
  const [ids, setIds] = useState<string[]>([]), [includeCurrent, setIncludeCurrent] = useState(false);
  const selected = selectedTargets(state, ids, includeCurrent);
  const disabled = busy || blocked || !resume.approved || !!resume.stale;
  return <details className="card resume-reuse-panel" id="resume-reuse" open={open} onToggle={event => onOpen(event.currentTarget.open)} data-testid="resume-reuse-panel"><summary><Send size={19} /><span><strong>选择投递岗位</strong><small>同一份已审核 PDF，可复用到多个岗位</small></span></summary>
    <p className="reuse-version">当前材料：<strong>V{resume.version} · {resumeLabel(resume)}</strong></p>
    {!resume.approved && <p className="inline-error">请先确认这版简历内容准确，再准备投递。</p>}{resume.stale && <p className="inline-error">这份是历史版本，请选择仍有效的已审核简历。</p>}
    <ResumeTargetPicker state={state} ids={ids} includeCurrent={includeCurrent} onChange={(next, current) => { setIds(next); setIncludeCurrent(current); }} disabled={busy || blocked} label="复用投递目标" />
    {selected.error && <p className="inline-error">{selected.error}</p>}
    <section className="reuse-simulation"><div><h3>批量模拟投递</h3><p>为所选岗位共用 V{resume.version}，在本机测试站准备、填写并逐项核验。</p></div><button type="button" className="button primary" disabled={disabled || !!selected.error || !selected.targets.length} onClick={() => void act({ type: 'prepare_applications', resumeId: resume.id, candidateIds: ids, includeCurrentJob: includeCurrent }, '已为所选岗位准备模拟申请，共用同一简历版本。请继续填写与核对。')}>{selected.targets.length ? `准备 ${selected.targets.length} 个岗位的模拟申请` : '选择岗位后准备模拟申请'}</button></section>
    {renderReal ? renderReal({ resume, candidateIds: ids, includeCurrentJob: includeCurrent, targets: selected.targets, busy, blocked: blocked || !resume.approved || !!resume.stale }) : <section className="reuse-real-links"><h3>前往真实招聘网站</h3><p>打开官网后可使用同一份 PDF。页面跳转与下载不会被记录为已投递。</p><a className={`button secondary ${blocked ? 'link-disabled' : ''}`} aria-disabled={blocked} href={blocked ? undefined : `/api/resumes/${resume.id}/pdf`} target="_blank" rel="noreferrer">下载 V{resume.version} PDF</a><ul>{selected.targets.filter(job => /^https?:\/\//.test(job.url)).map((job, index) => <li key={index}><span>{jobLabel(job)}</span><a href={job.url} target="_blank" rel="noreferrer">打开招聘页面<ArrowUpRight size={13} /></a><small>未执行真实投递</small></li>)}</ul></section>}
  </details>;
}
