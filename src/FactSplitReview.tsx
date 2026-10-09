import { Scissors, LoaderCircle } from 'lucide-react';
import type { Action, WorkspaceState } from '../shared/types';
import { AgentReviewStatus, FactContext, FactReviewNote, FactSources } from './FactEvidence';
type Props = { state: WorkspaceState; busy: string; act: (action: Action, message?: string) => Promise<WorkspaceState | null> };
export default function FactSplitReview({ state, busy, act }: Props) {
  if (!state.profile.facts.length && !state.factPreview) return null;
  return <section className="card fact-split-review">
    <div className="card-heading"><Scissors size={20} /><div><h2>让 Agent 理清经历</h2><p>按经历归属提炼事实，先预览，再决定是否采用。</p></div><button className="button secondary" disabled={!!busy} onClick={() => void act({ type: 'preview_fact_split' })}>{busy === 'preview_fact_split' ? <LoaderCircle size={15} className="spin" /> : <Scissors size={15} />}重新检查分段</button></div>
    {state.factPreview && <div data-testid="fact-split-preview"><AgentReviewStatus run={state.factPreview.agentRun} /><p className="fact-preview-notice">以下 {state.factPreview.facts.length} 条是整理预览，尚未替换现有事实。采用后需要重新确认，旧简历快照保留。</p><div className="fact-split-items">{state.factPreview.facts.map((fact,index) => <article key={fact.id}><span className="fact-preview-index">事实 {String(index + 1).padStart(2, '0')}</span><FactContext fact={fact} /><p className="fact-distilled-text">{fact.text}</p><FactReviewNote fact={fact} /><FactSources fact={fact} label="查看原文引用" /></article>)}</div><div className="inline-buttons"><button className="button secondary" disabled={!!busy} onClick={() => void act({ type: 'discard_fact_split' })}>保留现有事实</button><button className="button primary" disabled={!!busy || !state.factPreview.facts.length} onClick={() => void act({ type: 'apply_fact_split' }, '已替换分段，请重新检查并确认事实。')}>确认替换，重新审核</button></div></div>}
  </section>;
}
