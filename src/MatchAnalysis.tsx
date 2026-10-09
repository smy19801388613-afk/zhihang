import type { Job, JobAnalysis, MatchItem, Profile } from '../shared/types';
import { AgentReviewStatus, FactContext, FactReviewNote, FactSources } from './FactEvidence';

const profileLabels: Record<string, string> = { name: '姓名', school: '学校', education: '学历', major: '专业', graduation: '毕业时间', city: '意向城市', availability: '到岗时间', targetRole: '岗位意向', experienceText: '经历原文' };
const groups = [{ key: 'required', title: '硬门槛', description: '学历、资格、年限与到岗限制，先核对是否满足。' }, { key: 'capability', title: '工作能力', description: '区分已有直接经验与可以迁移的能力。' }, { key: 'preferred', title: '加分项', description: '招聘方明确的优先条件，未具备不等于不能申请。' }, { key: 'responsibility', title: '工作职责', description: '逐项看你的经历能支撑哪些具体任务。' }, { key: 'legacy', title: '待分类的历史分析', description: '重新分析后可按四类条件查看依据。' }];
const presentation = { supported: { label: '有依据支撑', color: 'green' }, partial: { label: '部分支撑', color: 'amber' }, unknown: { label: '信息待确认', color: 'neutral' }, unmet: { label: '明确不满足', color: 'red' } };
const adviceLabels = { consider: '值得考虑', clarify_first: '先核对关键条件', deprioritize: '建议降低优先级' };
const transferLabels = { direct: '直接经验', transferable: '能力可迁移', none: '暂无相关经历证据' };

export default function MatchAnalysis({ analysis, profile, job }: { analysis: JobAnalysis; profile: Profile; job: Job }) {
  const metadata = analysis.metadata, advice = analysis.applicationAdvice;
  const requiredUnmet = analysis.matches.filter(match => match.category === 'required' && match.evidenceState === 'unmet');
  function evidence(match: MatchItem) {
    const facts = match.factIds.map(id => profile.facts.find(fact => fact.id === id));
    const fields = (match.profileFields || []).filter(key => typeof profile[key as keyof Profile] === 'string');
    if (!facts.length && !fields.length) return <p className="evidence-empty">暂无可核对的个人资料或经历依据。</p>;
    return <details className="evidence-details"><summary>查看个人资料与经历依据 · {facts.length + fields.length} 项</summary><div>
      {fields.map(key => <div className="evidence-entry" key={`profile-${key}`}><strong>个人资料 · {profileLabels[key] || key}</strong><blockquote>{String(profile[key as keyof Profile] || '尚未填写')}</blockquote></div>)}
      {facts.map((fact, index) => <div className="evidence-entry" key={match.factIds[index]}>{fact ? <><span className="evidence-confirmation">{fact.confirmed ? '已确认经历' : '尚未确认的经历'}</span><FactContext fact={fact} /><blockquote>{fact.text}</blockquote><FactReviewNote fact={fact} /><FactSources fact={fact} label="查看来源原文" /></> : <p>这条经历已不在当前资料中，请重新分析。</p>}</div>)}
    </div></details>;
  }
  return <div className="match-analysis" data-testid="match-analysis">
    <section className="match-overview" aria-label="岗位理解"><h3>这个岗位主要做什么</h3><p className="analysis-summary">{analysis.roleOverview || analysis.summary}</p>
      {!!analysis.coreTasks?.length && <ol className="match-core-tasks">{analysis.coreTasks.map((item,index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><div><p>{item.task}</p>{!!item.sourceQuotes.length && <details className="jd-source-details"><summary>招聘原文依据</summary>{item.sourceQuotes.map((quote,quoteIndex) => <blockquote key={quoteIndex}>{quote}</blockquote>)}</details>}</div></li>)}</ol>}
      {!!analysis.contextNotes?.length && <details className="jd-source-details" data-testid="job-context-notes"><summary>岗位补充说明</summary>{analysis.contextNotes.map((item,index) => <div key={index}><p>{item.note}</p>{item.sourceQuotes.map((quote,quoteIndex) => <blockquote key={quoteIndex}>{quote}</blockquote>)}</div>)}</details>}
    </section>
    {advice && <section className={`match-application-advice ${advice.recommendation}`} aria-label="申请建议" data-testid="application-advice"><div className="match-advice-heading"><h3>申请建议</h3><span>{adviceLabels[advice.recommendation]}</span></div><p className="match-advice-reason">{advice.reason}</p>
      <div className="match-advice-columns"><div><h4>能带去的优势</h4>{advice.strengths.length ? <ul>{advice.strengths.map((item,index) => <li key={index}>{item}</li>)}</ul> : <p>现有材料还不足以判断。</p>}</div><div><h4>需要补足或核对</h4>{advice.gaps.length ? <ul>{advice.gaps.map((item,index) => <li key={index}>{item}</li>)}</ul> : <p>继续核对具体岗位条件。</p>}</div></div>
      {!!advice.nextSteps.length && <div className="match-next-steps"><h4>下一步</h4><ol>{advice.nextSteps.map((item,index) => <li key={index}>{item}</li>)}</ol></div>}
    </section>}
    <AgentReviewStatus run={analysis.agentRun} kind="job_analysis" />
    {!analysis.agentRun && (analysis.curation ? <details className="match-method" aria-label="条件提炼说明"><summary>{analysis.curation.mode === 'model' ? 'AI 已提炼岗位条件' : '规则提炼 · 演示结果'}</summary><p>下方分别列出招聘原文与个人证据，请逐项核对。</p>{analysis.curation.warnings.length > 0 && <ul>{analysis.curation.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul>}</details> : <p className="editor-hint" role="note">旧版分析，可重新分析获得任务解读与申请建议。</p>)}
    {requiredUnmet.length > 0 && <div className="match-blocker" role="note"><strong>有 {requiredUnmet.length} 项硬门槛明确不满足</strong><p>先核对招聘方的限制，再决定是否继续准备。</p></div>}
    <div className="match-evidence-heading"><h3>逐项核对证据</h3><p>招聘要求与经历依据分开查看。</p></div>
    {groups.map(group => { const matches = analysis.matches.filter(match => (match.category || 'legacy') === group.key); return matches.length ? <section className="match-group" data-testid={`match-${group.key}`} key={group.key}><header><h3>{group.title}<span>{matches.length}</span></h3><p>{group.description}</p></header><div className="match-list">{matches.map((match,index) => { const state = match.evidenceState || (match.status === 'missing' ? 'unknown' : match.status); const display = presentation[state]; return <article className="match-item" key={index}><div className="match-item-heading"><h3>{match.requirement}</h3><span className={`tag ${display.color}`}>{display.label}</span></div>{match.transferability && match.category !== 'required' && <span className={`match-transferability ${match.transferability}`}>{transferLabels[match.transferability]}</span>}<p>{match.evidence}</p>{match.gap && <p className="match-gap"><strong>还需补充</strong>{match.gap}</p>}{match.sourceQuotes?.length ? <details className="jd-source-details"><summary>查看招聘原文依据 · {match.sourceQuotes.length} 段</summary>{match.sourceQuotes.map((quote,quoteIndex) => <blockquote key={quoteIndex}>{quote}</blockquote>)}</details> : null}{evidence(match)}</article>; })}</div></section> : null; })}
    {!analysis.matches.length && <p className="editor-hint">本次没有可评估的要求，请补充完整招聘原文后重新分析。</p>}
    <details className="match-job-info match-job-context" aria-label="岗位信息"><summary>行业、地点与薪资</summary><dl><div><dt>行业</dt><dd>{metadata?.industry || job.industry || '未披露'}</dd></div><div><dt>地点</dt><dd>{metadata?.location || '未披露'}</dd></div><div><dt>薪资</dt><dd>{metadata?.salary || '未披露'}</dd></div></dl>{metadata?.other?.length ? <ul>{metadata.other.map((item,index) => <li key={index}>{item}</li>)}</ul> : null}</details>
    {analysis.directionAdvice.length > 0 && <details className="advice-box" open={!advice}><summary>补充准备建议</summary><ul>{analysis.directionAdvice.map((item,index) => <li key={index}>{item}</li>)}</ul></details>}
    {analysis.questions.length > 0 && <div className="advice-box"><strong>进一步确认</strong><ul>{analysis.questions.map((item,index) => <li key={index}>{item}</li>)}</ul></div>}
  </div>;
}
