import type { AgentRun, Fact } from '../shared/types';

const kinds = { work: '工作', internship: '实习', project: '项目', campus: '校园', volunteer: '志愿服务', education: '教育', skill: '技能', other: '其他经历' };

export function FactContext({ fact }: { fact: Fact }) {
  const experience = fact.experience;
  if (!experience) return fact.sourceContext ? <p className="fact-context-legacy">{fact.sourceContext}</p> : null;
  return <div className={`fact-experience-context ${experience.parentTitle ? 'is-child' : ''}`}>
    {experience.parentTitle && <p className="fact-parent-title"><span>所属经历</span>{experience.parentTitle}</p>}
    <div className="fact-experience-title"><h3>{experience.title}</h3><span>{kinds[experience.kind]}</span></div>
    {(experience.role || experience.date) && <p className="fact-experience-meta">{[experience.role, experience.date].filter(Boolean).join(' · ')}</p>}
  </div>;
}

export function FactSources({ fact, label = '查看经历原文' }: { fact: Fact; label?: string }) {
  const quotes = fact.sourceQuotes?.filter(quote => quote.trim()) || [];
  if (!quotes.length && !fact.source) return null;
  return <details className="fact-source fact-source-quotes"><summary>{label}{quotes.length ? ` · ${quotes.length} 段引用` : ''}</summary>
    {(quotes.length ? quotes : [fact.source]).map((quote,index) => <blockquote key={index}>{quote}</blockquote>)}
  </details>;
}

export function FactReviewNote({ fact }: { fact: Fact }) {
  return fact.reviewNote ? <p className="fact-review-note"><strong>待核对</strong>{fact.reviewNote}</p> : null;
}

export function AgentReviewStatus({ run, kind = 'experience' }: { run?: AgentRun; kind?: 'experience' | 'job_analysis' }) {
  if (!run) return null;
  const demo = /demo|规则|演示|local/iu.test(run.model);
  const label = demo ? '规则演示' : kind === 'experience' ? 'Agent 已整理经历' : 'Agent 已分析岗位';
  return <div className={`agent-review-status ${demo ? 'is-demo' : ''}`}>
    <div><span>{label}</span><span>{!demo && run.reviewed ? '已检查依据' : '待你核对'}</span></div>
    <details><summary>{run.warnings.length ? `查看需核对项 · ${run.warnings.length}` : '关于这次整理'}</summary>
      <p>{demo ? '当前是规则演示结果，请逐项确认内容与所属经历。' : '检查仅依据本次提供的材料。经历是否真实、岗位是否适合，仍需你确认。'}</p>
      {run.warnings.length > 0 && <ul>{run.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul>}
    </details>
  </div>;
}
