import { useState } from 'react';
import { ArrowUpRight, FileText, LoaderCircle, Sparkles } from 'lucide-react';
import type { Action, Job, WorkspaceState } from '../shared/types';
import { sourceName } from '../shared/job-source';
import MatchAnalysis from './MatchAnalysis';
import ClearInputControl from './ClearInputControl';

type Props = { state: WorkspaceState; job: Job; onChange: (job: Job) => void; busy: string; dirty: boolean; blocked?: boolean;
  act: (action: Action, message?: string) => Promise<WorkspaceState | null>; onProfile: () => void };
export default function ResumePreparation({ state, job, onChange, busy, dirty, blocked = false, act, onProfile }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const confirmed = state.profile.facts.filter(fact => fact.confirmed).length;
  const incomplete = !state.job.text.trim() || state.job.jdComplete === false;
  const disabled = !!busy || dirty || blocked || !confirmed || incomplete;
  async function generate() {
    if (disabled) return;
    const analyzed = state.analysis?.agentRun?.version === 1 || state.analysis?.curation?.mode === 'rules' ? state : await act({ type: 'analyze_job' });
    if (analyzed) await act({ type: 'generate_resume' }, '简历已生成，可以对话修改或直接编辑。');
  }
  return <section className="card resume-preparation" data-testid="resume-preparation">
    <header className="resume-preparation-heading"><FileText size={24} /><div><h2>{state.job.company} · {state.job.title}</h2><span className="job-source-badge">{sourceName(state.job.sourceKind)}</span></div>{/^https?:\/\//.test(state.job.url) && <a className="button quiet" href={state.job.url} target="_blank" rel="noreferrer">查看来源<ArrowUpRight size={14} /></a>}</header>
    <div className="resume-preparation-status">{incomplete ? '还缺完整招聘 JD。补充后就能为这个岗位生成简历。' : `岗位资料已就绪 · ${confirmed} 条经历已确认`}</div>
    <details className="resume-preparation-jd" open={incomplete || dirty || detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>{incomplete ? '补充岗位 JD' : '查看或修改岗位资料'}</summary>
      <div className="form-grid"><label className="field"><span>公司名称</span><input value={job.company} maxLength={200} onChange={event => onChange({ ...job, company: event.target.value })} /></label><label className="field"><span>岗位名称</span><input value={job.title} maxLength={200} onChange={event => onChange({ ...job, title: event.target.value })} /></label></div>
      <label className="field"><span>岗位描述 / JD</span><textarea aria-label="简历工作区岗位 JD" value={job.text} maxLength={16000} rows={10} placeholder="粘贴具体岗位的职责和任职要求" onChange={event => onChange({ ...job, text: event.target.value })} /></label>
      <ClearInputControl value={job.text} onChange={text => onChange({ ...job, text })} label="简历工作区岗位 JD" disabled={!!busy} resetKey={state.revision} />
      <button type="button" className="button secondary" disabled={!!busy || blocked || !job.company.trim() || !job.title.trim() || job.text.trim().length < 10 || !dirty && !incomplete} onClick={() => void act({ type: 'save_job', job }, '岗位资料已保存。')}>保存完整 JD</button>
    </details>
    {state.analysis && <details className="resume-match-details"><summary>查看匹配分析</summary><MatchAnalysis analysis={state.analysis} profile={state.profile} job={state.job} /></details>}
    <div className="form-footer"><span>{!confirmed ? '先确认经历，再生成简历。' : dirty ? '先保存修改后的 JD。' : '生成后可在网页中编辑，也可以用对话修改。'}</span><div className="inline-buttons">{!confirmed && <button className="button secondary" onClick={onProfile}>确认我的经历</button>}<button className="button primary" disabled={disabled} onClick={() => void generate()}>{busy === 'generate_resume' || busy === 'analyze_job' ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{busy === 'analyze_job' ? '正在分析岗位…' : busy === 'generate_resume' ? '正在生成简历…' : '生成岗位简历'}</button></div></div>
  </section>;
}
