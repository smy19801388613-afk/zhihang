import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { Action, CompanyCandidate, CompanyResearch, WorkspaceState } from '../shared/types';

type Props = { company: CompanyCandidate; research?: CompanyResearch; busy: string; blocked: boolean; onClose: () => void; act: (action: Action) => Promise<WorkspaceState | null> };
const when = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN') : '未提供';
const isHttps = (value: string) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const topics = [{ key: 'business', label: '公司与业务' }, { key: 'recent', label: '近期变化' }, { key: 'role', label: '岗位与准备' }];

export default function CompanyResearchPanel({ company, research, busy, blocked, onClose, act }: Props) {
  const [links, setLinks] = useState(() => (research?.userSourceUrls || []).join('\n'));
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(false);
  const started = useRef(false);
  const inFlight = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const disabled = !!busy || blocked || requesting;
  async function researchCompany(refresh = false) {
    if (busy || blocked || inFlight.current) return;
    const urls = [...new Set(links.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    if (urls.length > 3 || urls.some(url => !isHttps(url))) { setError('请填写最多 3 个有效的 HTTPS 链接，每行一个。'); return; }
    inFlight.current = true; setRequesting(true); setError('');
    try {
      const result = await act({ type: 'research_company', companyId: company.id, refresh, sourceUrls: urls });
      if (!result) setError('本次公司研究未完成。请查看页面上的错误说明，稍后重试；已保存的研究仍然保留。');
    } finally { inFlight.current = false; setRequesting(false); }
  }
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!started.current) { started.current = true; void researchCompany(); }
  }, []);
  return <section ref={panel} className="company-research-panel card" data-testid="company-research" aria-labelledby="company-research-title" aria-busy={requesting}>
    <div className="research-heading"><BookOpen size={21} /><div><p className="eyebrow">KNOW THE COMPANY</p><h2 id="company-research-title">了解 {company.name}</h2><p>{company.role} · 为投递和面试多做一步准备</p></div><button className="button quiet" aria-label="收起公司研究" disabled={requesting} onClick={onClose}><X size={18} /></button></div>
    {requesting && <div className="research-loading" role="status"><LoaderCircle size={18} className="spin" /><span>{research ? '正在核对已保存研究是否仍适用于当前岗位与来源。下方暂时显示此前的研究结果…' : '正在阅读可用来源、整理公司与岗位信息…'}</span></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {research ? <><div className="research-meta"><span className={`tag ${research.status === 'ready' ? 'green' : 'amber'}`}>{research.status === 'ready' ? '已有可查来源' : research.status === 'partial' ? '部分信息待补充' : '暂无可用研究结果'}</span><span>{research.mode === 'live' ? '基于来源整理' : '网页原文整理'} · 整理于 {when(research.generatedAt)}</span></div><p className="research-summary">{research.summary}</p>
      {research.warnings.length > 0 && <div className="research-warnings"><strong>还需要确认的信息</strong><ul>{research.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      <div className="research-grid">{topics.map(topic => { const findings = research.findings.filter(finding => finding.topic === topic.key); return <section className="research-topic" key={topic.key}><h3>{topic.label}</h3>{findings.length ? findings.map(finding => { const source = research.sources.find(item => item.id === finding.sourceId); return <article key={finding.id}><p>{finding.text}</p>{source ? <details className="research-citation"><summary>核对来源 · {source.title}</summary>{finding.quote && <blockquote>{finding.quote}</blockquote>}<span>{source.readMethod === 'search_snippet' ? '仅检索摘要，未读取网页全文' : '已获取网页内容'} · 发布日期：{when(source.publishedAt)} · 获取日期：{when(source.fetchedAt)}</span>{isHttps(source.url) && <a href={source.url} target="_blank" rel="noreferrer">打开来源<ArrowUpRight size={12} /></a>}</details> : <small>该条来源不可核对，请暂不据此判断。</small>}</article>; }) : <p className="research-unknown">现有来源未能确认，暂不推测。</p>}</section>; })}</div>
      {research.questions.length > 0 && <section className="research-questions"><h3>带着这些问题继续了解</h3><ul>{research.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></section>}
      <details className="research-all-sources"><summary>本次参考来源 · {research.sources.length} 条</summary>{research.sources.length ? research.sources.map(source => <div key={source.id}><strong>{source.title}</strong><span>{source.readMethod === 'search_snippet' ? '仅检索摘要，未读取网页全文' : '已获取网页内容'}</span><small>发布日期：{when(source.publishedAt)} · 获取日期：{when(source.fetchedAt)}</small>{isHttps(source.url) && <a href={source.url} target="_blank" rel="noreferrer">{source.url}<ArrowUpRight size={12} /></a>}<p>{source.excerpt}</p></div>) : <p>未取得可引用来源，可在下方补充公司官网或官方新闻链接。</p>}</details>
    </> : !requesting && !error ? <p className="research-summary">还没有这家公司的研究记录，点击下方按钮开始。</p> : null}
    <div className="research-form"><label className="field"><span>公司官网或新闻链接（选填，每行一个，最多 3 个）</span><textarea aria-label="公司研究补充链接" value={links} disabled={disabled} maxLength={6000} rows={3} onChange={event => setLinks(event.target.value)} placeholder="https://公司官网…" /></label><div><p>优先查看官方来源；没有查到的信息会保留为未知。</p><button className="button secondary" disabled={disabled} onClick={() => void researchCompany(!!research)}><RefreshCw size={14} />{error ? '重试公司研究' : research ? '更新公司研究' : '开始公司研究'}</button></div></div>
  </section>;
}
