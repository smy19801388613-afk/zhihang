import { useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BriefcaseBusiness, Check, Heart, MapPin, RefreshCw, RotateCcw, Sparkles, Undo2, Wallet, X } from 'lucide-react';
import CompanyResearchPanel from './CompanyResearchPanel';
import { candidateSourceKind, sourceName } from '../shared/job-source';
import type { Action, CompanyCandidate, SwipeDecision, WorkspaceState } from '../shared/types';

type Props = { state: WorkspaceState; busy: string; blocked: boolean; act: (action: Action, message?: string) => Promise<WorkspaceState | null>; onEditCapture?: (id: string) => void };
const isHttp = (url?: string) => { try { return !!url && ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; } };
const decisionOf = (company: CompanyCandidate) => company.decision || (company.selected ? 'like' : undefined);
const when = (date?: string) => date && !Number.isNaN(Date.parse(date)) ? new Date(date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '时间未提供';
const hasJd = (company: CompanyCandidate) => !!company.jobDescription?.trim();
const isCapture = (company: CompanyCandidate) => company.sourceKind === 'browser_capture';
const incomplete = (company: CompanyCandidate) => isCapture(company) && company.jdComplete !== true;
const isHistorical = (company: CompanyCandidate) => !isCapture(company) && company.hiringStatus === 'unverified' && hasJd(company);

function CompanyLogo({ company }: { company: CompanyCandidate }) {
  const [failed, setFailed] = useState(false);
  return <span className="discovery-logo" aria-hidden="true">{!failed && isHttp(company.logoUrl) ? <img src={company.logoUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} draggable={false} /> : company.name.slice(0, 2)}</span>;
}

export default function JobDiscovery({ state, busy, blocked, act, onEditCapture }: Props) {
  const companies = state.exploration?.companies || [];
  const liked = companies.filter(company => decisionOf(company) === 'like');
  const [sourceFilter, setSourceFilter] = useState('all');
  const visibleCompanies = companies.filter(company => sourceFilter === 'all' || candidateSourceKind(company) === sourceFilter);
  const skipped = visibleCompanies.filter(company => decisionOf(company) === 'dislike');
  const pending = visibleCompanies.filter(company => !decisionOf(company));
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const [researchId, setResearchId] = useState('');
  const researchCompany = companies.find(company => company.id === researchId);
  const [drag, setDrag] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const inFlight = useRef(false);
  const deckRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; horizontal: boolean; cancelled: boolean } | null>(null);
  const currentReview = reviewIds.map(id => companies.find(company => company.id === id)).find(Boolean);
  const current = currentReview || pending[0];
  const disabled = !!busy || blocked || requesting;
  const viewed = visibleCompanies.length - pending.length;

  async function decide(company: CompanyCandidate, decision: SwipeDecision) {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setRequesting(true);
    try {
      const next = await act({ type: 'swipe_company', companyId: company.id, decision });
      if (next) setReviewIds(ids => ids.filter(id => id !== company.id));
    } finally { setDrag(0); setRequesting(false); inFlight.current = false; }
  }
  function review(ids: string[]) {
    setSourceFilter('all'); setReviewIds(ids); setDrag(0);
    deckRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    deckRef.current?.focus({ preventScroll: true });
  }
  async function undo() {
    const previousId = state.exploration?.swipeHistory?.at(-1)?.companyId;
    if (disabled || !previousId) return;
    const next = await act({ type: 'undo_company_swipe' });
    if (next) { setReviewIds([previousId]); setDrag(0); }
  }
  function pointerStart(event: PointerEvent<HTMLElement>) {
    if (disabled || !current || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest('button,a,input,textarea,select,summary,details,[data-no-swipe]')) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false, cancelled: false };
  }
  function pointerMove(event: PointerEvent<HTMLElement>) {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId || start.cancelled) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.horizontal && Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { start.cancelled = true; return; }
    if (!start.horizontal && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) { start.horizontal = true; event.currentTarget.setPointerCapture(event.pointerId); }
    if (start.horizontal) { event.preventDefault(); setDrag(Math.max(-170, Math.min(170, dx))); }
  }
  function pointerEnd(event: PointerEvent<HTMLElement>) {
    const start = gesture.current;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (start && start.id === event.pointerId && start.horizontal && !start.cancelled && Math.abs(event.clientX - start.x) >= 85 && current) void decide(current, event.clientX > start.x ? 'like' : 'dislike');
    else setDrag(0);
  }

  return <section className="job-discovery" aria-labelledby="discovery-title" data-testid="job-discovery">
    <div className="discovery-heading"><div><h2 id="discovery-title">发现岗位</h2><p>右滑喜欢，左滑略过。</p></div><button className="button secondary" disabled={disabled || !state.exploration?.selectedDirectionIds.length} onClick={() => void act({ type: 'refresh_jobs' }, '已刷新公开岗位，保留了你的选择。')} data-testid="refresh-jobs"><RefreshCw size={14} className={busy === 'refresh_jobs' ? 'spin' : ''} />刷新岗位</button></div>
    <div className="source-switch" role="group" aria-label="按岗位来源筛选">{[['all', '全部'], ['official_job', '企业官网'], ['jobspy', 'JobSpy'], ['browser_capture', '浏览器扩展'], ['exploration', '公司探索']].map(([key, label]) => <button key={key} className="source-option" aria-pressed={sourceFilter === key} onClick={() => { setSourceFilter(key); setReviewIds([]); }}>{label}<span>{companies.filter(company => key === 'all' || candidateSourceKind(company) === key).length}</span></button>)}</div>
    <div className="discovery-layout"><div className="discovery-main">
      <div className="discovery-progress"><span>{currentReview ? '正在回看' : '为你发现'}<strong>{companies.length}</strong>个机会</span><span data-testid="discovery-progress">已看 {viewed} / {visibleCompanies.length}<i />喜欢 {liked.length}</span></div>
      <div className="discovery-progress-track"><span style={{ width: `${visibleCompanies.length ? viewed / visibleCompanies.length * 100 : 0}%` }} /></div>
      <div className="discovery-deck" ref={deckRef} tabIndex={-1}>
        {current ? <article key={current.id} className={`opportunity-card ${drag ? 'dragging' : ''}`} data-testid="job-swipe-card" data-candidate-id={current.id} tabIndex={0} aria-label={`${current.name} · ${current.role}，左右方向键选择`} aria-describedby="swipe-hint" style={{ transform: `translateX(${drag}px) rotate(${drag / 22}deg)` }} onPointerDown={pointerStart} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={() => { gesture.current = null; setDrag(0); }} onKeyDown={event => {
          if (event.target !== event.currentTarget || disabled || event.repeat || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault(); void decide(current, event.key === 'ArrowRight' ? 'like' : 'dislike');
        }}>
          {Math.abs(drag) > 25 && <span className={`swipe-stamp ${drag > 0 ? 'like' : 'dislike'}`} aria-hidden="true">{drag > 0 ? 'LIKE' : 'PASS'}</span>}
          <div className="opportunity-topline"><span className="job-source-badge" data-testid="job-source">{sourceName(candidateSourceKind(current), current.capturePlatform)}</span><span className={`opportunity-badge ${current.hiringStatus === 'listed' ? 'listed' : ''}`}>{isCapture(current) ? '招聘状态待核对' : current.hiringStatus === 'listed' ? '公开招聘职位' : isHistorical(current) ? '待重新核验 · 历史职位' : '未获取具体职位'}</span></div>
          <div className="opportunity-company"><CompanyLogo key={`${current.id}:${current.logoUrl}`} company={current} /><div><h3>{current.name}</h3><p>{[current.industry, current.jobType].filter(Boolean).join(' · ')}</p></div>{decisionOf(current) && <span className="opportunity-prior">{decisionOf(current) === 'like' ? <Heart size={15} fill="currentColor" /> : <X size={15} />}{decisionOf(current) === 'like' ? '已喜欢' : '已略过'}</span>}</div>
          <h4 className="opportunity-role">{current.role}</h4>
          <div className="opportunity-meta"><span><MapPin size={15} />{current.location || '地点待核实'}</span><span><Wallet size={15} />{current.salary || '薪资未披露'}</span></div>
          <div className="opportunity-reason"><Sparkles size={16} /><div><strong>为什么值得了解</strong><p>{current.rationale || '结合你选择的行业与岗位方向，进一步核对具体工作内容和资格要求。'}</p></div></div>
          {hasJd(current) ? <details className="opportunity-jd" data-no-swipe open><summary>{incomplete(current) ? '页面摘要 · 详情待补充' : isHistorical(current) ? '历史岗位描述 · JD' : '岗位描述 · JD'}</summary>{incomplete(current) && <p className="browser-capture-jd-note">当前是已展示摘要，尚不足以生成岗位简历。请打开详情再次导入，或补充完整 JD。</p>}{isHistorical(current) && <p className="opportunity-reference">以下为此前获取的招聘原文，是否仍开放需重新核验。</p>}<div className="opportunity-jd-scroll" tabIndex={0} aria-label="岗位描述，可滚动阅读">{current.jobDescription}</div></details> : <div className="opportunity-reference" data-no-swipe><strong>{isCapture(current) ? '详情待补充' : current.hiringStatus === 'listed' ? '招聘详情待补充' : '方向参考 · 尚未获取招聘原文'}</strong><p>{isCapture(current) ? '请打开原始岗位详情，再次导入完整 JD；也可以手动补充。' : current.hiringStatus === 'listed' ? '请打开招聘来源，查看完整职责、资格要求及截止时间。' : '目前只有官网入口，没有采集到具体职位或 JD。请找到真实岗位后补充。'}</p>{current.requirements.length > 0 && <ul>{current.requirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul>}</div>}
          {isCapture(current) && <><div className="opportunity-meta"><span>{current.education || '学历未提供'}</span><span>{current.experience || '经验未提供'}</span></div>{onEditCapture && <button className="button quiet" data-no-swipe disabled={disabled} onClick={() => onEditCapture(current.id)}>{incomplete(current) ? '补充岗位详情' : '查看采集原文 / 修正信息'}</button>}</>}<div className="opportunity-source"><div><span>{current.sourceLabel}</span><small>{isHistorical(current) ? '历史获取于' : '获取于'} {when(current.checkedAt)}{current.publishedAt ? ` · 发布于 ${when(current.publishedAt)}` : ''}</small></div>{isHttp(current.careerUrl) && <a href={current.careerUrl} target="_blank" rel="noreferrer">{isCapture(current) || current.hiringStatus === 'listed' || hasJd(current) ? '查看招聘来源' : '官方招聘入口'}<ArrowUpRight size={14} /></a>}</div>
        </article> : <div className="discovery-complete" data-testid="discovery-complete"><span className="discovery-complete-icon">{liked.length ? <Check size={30} /> : <BriefcaseBusiness size={29} />}</span><h3>{liked.length ? '喜欢的机会，已经为你留下。' : '还没遇到心动的，也没关系。'}</h3><p>{liked.length ? `已留下 ${liked.length} 个机会。核对清单后，选择一个岗位进入简历准备。` : '可以回看略过的卡片，或继续和顾问聊聊偏好，再寻找新的方向。'}</p>{skipped.length > 0 && <button className="button secondary" disabled={disabled} onClick={() => review(skipped.map(company => company.id))} data-testid="review-skipped"><RotateCcw size={14} />重新看看略过的 {skipped.length} 个</button>}</div>}
      </div>
      {current && <><div className="swipe-actions"><button className="swipe-action pass" data-testid="swipe-dislike" disabled={disabled} onClick={() => void decide(current, 'dislike')} aria-label="跳过这个岗位"><X size={24} /><span>略过</span><kbd>←</kbd></button><button className="swipe-undo" data-testid="undo-swipe" disabled={disabled || !state.exploration?.swipeHistory?.length} onClick={() => void undo()} aria-label="撤销上一次选择"><Undo2 size={21} /><span>撤销</span></button><button className="swipe-action like" data-testid="swipe-like" disabled={disabled} onClick={() => void decide(current, 'like')} aria-label="喜欢这个岗位"><Heart size={22} /><span>喜欢</span><kbd>→</kbd></button></div><p id="swipe-hint" className="swipe-hint">拖动卡片 / 点击按钮 · 聚焦卡片后也可用左右键</p></>}
      <div className="discovery-secondary-actions">{!current && <button className="button quiet" disabled={disabled || !state.exploration?.swipeHistory?.length} onClick={() => void undo()} data-testid="undo-swipe" aria-label="撤销上一次选择"><Undo2 size={14} />撤销上一次</button>}{currentReview && <button className="button quiet" disabled={disabled} onClick={() => setReviewIds([])}><ArrowLeft size={14} />结束回看</button>}{!!current && !currentReview && skipped.length > 0 && <button className="button quiet" disabled={disabled} onClick={() => review(skipped.map(company => company.id))} data-testid="review-skipped"><RotateCcw size={13} />回看已略过 · {skipped.length}</button>}</div>
      {state.exploration?.jobSearch && <details className="discovery-sources"><summary>岗位来源与获取状态 · {when(state.exploration.jobSearch.fetchedAt)}</summary><p>公开页面展示的职位仍需在投递前核对；未披露的信息不会由模型补写。</p>{state.exploration.jobSearch.sources.map(source => <div key={source.id}><strong>{source.label}</strong><span className={source.status === 'ok' ? 'source-ok' : ''}>{source.status === 'ok' ? `获取 ${source.count} 个职位` : source.status === 'unsupported' ? '暂未接入' : '本次获取失败'}</span>{source.message && <small>{source.message}</small>}</div>)}</details>}
    </div><aside className="liked-opportunities" aria-labelledby="liked-title" data-testid="liked-jobs"><div className="liked-heading"><span><Heart size={19} /></span><div><h3 id="liked-title">喜欢的岗位</h3></div><b data-testid="liked-count">{liked.length}</b></div>
      {liked.length ? <div className="liked-list">{liked.map(company => { const resume = [...state.resumes].reverse().find(item => item.job.candidateId === company.id && !item.stale); return <article className="liked-item" key={company.id} data-testid="liked-job" data-candidate-id={company.id}><div className="liked-item-head"><CompanyLogo key={`${company.id}:${company.logoUrl}`} company={company} /><div><strong>{company.name}</strong><span>{company.industry}</span></div><button className="liked-remove" disabled={disabled} aria-label={`移除 ${company.name} · ${company.role}`} onClick={() => void decide(company, 'dislike')}><X size={14} /></button></div><h4>{company.role}</h4><span className="job-source-badge">{sourceName(candidateSourceKind(company), company.capturePlatform)}</span><p>{company.location || '地点待核实'} · {company.salary || '薪资未披露'}</p>{isCapture(company) && <p>{incomplete(company) ? '详情待补充' : '招聘状态待核对'}</p>}{isHistorical(company) && <p>待重新核验 · 历史职位 · {when(company.checkedAt)}</p>}<button className="button quiet liked-research-button" disabled={disabled} onClick={() => setResearchId(company.id)} data-testid="research-liked-company">了解这家公司<ArrowUpRight size={13} /></button><div className="liked-item-actions"><button className="button quiet" disabled={disabled} onClick={() => review([company.id])}>回看</button>{incomplete(company) && onEditCapture ? <button className="button secondary" disabled={disabled} onClick={() => onEditCapture(company.id)}>补充岗位详情<ArrowRight size={13} /></button> : <button className="button secondary" disabled={disabled || incomplete(company)} onClick={() => void act({ type: 'open_company', companyId: company.id }, '已打开岗位简历工作区。')} data-testid="prepare-liked-resume">{resume ? `查看简历 V${resume.version}` : hasJd(company) ? '准备岗位简历' : '补充 JD 并准备'}<ArrowRight size={13} /></button>}</div></article>; })}</div> : <div className="liked-empty"><Heart size={30} strokeWidth={1.2} /><strong>遇见合适的，向右滑。</strong><p>喜欢的岗位会自动保存在这里，刷新页面也不会丢失。</p></div>}
      
    </aside></div>
    {researchCompany && <CompanyResearchPanel key={researchCompany.id} company={researchCompany} research={state.companyResearch?.[researchCompany.id]} busy={busy} blocked={blocked} act={act} onClose={() => setResearchId('')} />}
  </section>;
}
