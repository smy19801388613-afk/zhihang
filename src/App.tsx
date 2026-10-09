import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, BriefcaseBusiness, Check, CheckCheck,
  ChevronRight, CircleAlert, CircleCheck, Clock3, FileText, FlaskConical,
  FolderHeart, Leaf, LoaderCircle, MessageCircle, RefreshCw,
  Send, Settings2, ShieldCheck, Sparkles, UserRound, X, Puzzle,
} from 'lucide-react';
import type { Action, AppStatus, Application, Job, Profile, WorkspaceState } from '../shared/types';
import ResumeImportPanel from './ResumeImportPanel';
import CareerExplorer from './CareerExplorer';
import ResumeStudio from './ResumeStudio';
import ResumeDesignPanel from './ResumeDesignPanel';
import ResumePurposePanel from './ResumePurposePanel';
import ResumeReusePanel from './ResumeReusePanel';
import ApplicationBatchPanel from './ApplicationBatchPanel';
import RealApplicationPanel, { RealApplicationRecords } from './components/RealApplicationPanel';
import { applicationTarget, resumeLabel } from '../shared/resume-scope';
import MatchAnalysis from './MatchAnalysis';
import ModelSettingsPanel from './ModelSettingsPanel';
import BrowserConnectionsPanel from './BrowserConnectionsPanel';
import CapturedJobsPanel from './CapturedJobsPanel';
import ResumePreparation from './ResumePreparation';
import FactSplitReview from './FactSplitReview';
import ClearInputControl, { ClearDraftControl } from './ClearInputControl';
import InlineRemovalConfirm from './InlineRemovalConfirm';
import CurrentJobRemoval from './CurrentJobRemoval';
import { AgentReviewStatus, FactContext, FactReviewNote, FactSources } from './FactEvidence';
import { sourceName } from '../shared/job-source';
import { selectWorkspaceResume } from '../shared/resume-selection';
import type { ModelSettingsPublic } from '../shared/model-config';

type Tab = 'profile' | 'job' | 'resume' | 'applications' | 'interview' | 'settings' | 'browser';
type ProfileDraft = Omit<Profile, 'facts'>;
const tabs = [
  { id: 'profile' as Tab, label: '我的经历', caption: '梳理真实的你', icon: UserRound },
  { id: 'job' as Tab, label: '方向与公司', caption: '先探索，再做选择', icon: BriefcaseBusiness },
  { id: 'resume' as Tab, label: '岗位简历', caption: '让经历被看见', icon: FileText },
  { id: 'applications' as Tab, label: '投递记录', caption: '每一步都有记录', icon: Send },
  { id: 'interview' as Tab, label: '面试练习', caption: '准备下一场对话', icon: MessageCircle },
];
const emptyProfile: ProfileDraft = { name: '', email: '', phone: '', school: '', education: '', major: '', graduation: '', city: '', availability: '', targetRole: '', experienceText: '' };
const emptyJob = { company: '', title: '', text: '', url: '' };
const dateLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const getDraft = ({ facts: _facts, ...profile }: Profile): ProfileDraft => profile;
const statusLabels: Record<Application['status'], string> = { prepared: '待填写', filled: '待确认提交', submitting: '提交中', confirmed: '已核验提交', unknown: '结果待核验', failed: '执行失败' };

function Button({ children, onClick, disabled, variant = 'primary', className = '', type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'quiet'; className?: string; type?: 'button' | 'submit' }) {
  return <button type={type} className={`button ${variant} ${className}`} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Empty({ icon: Icon = FileText, title, description, action }: { icon?: typeof FileText; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={30} strokeWidth={1.4} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}
function Field({ label, value, onChange, placeholder, type = 'text', wide = false, maxLength = 200 }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; wide?: boolean; maxLength?: number }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span><input type={type} value={value} maxLength={maxLength} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

export default function App() {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [tab, setTab] = useState<Tab>(() => { const view = new URLSearchParams(window.location.search).get('view'); return view === 'settings' || view === 'browser' ? view : 'profile'; });
  const [profile, setProfile] = useState<ProfileDraft>(emptyProfile);
  const [job, setJob] = useState<Job>(emptyJob);
  const [resumeDirty, setResumeDirty] = useState(false);
  const [designDirty, setDesignDirty] = useState(false);
  const [purposeDirty, setPurposeDirty] = useState(false);
  const [purposeResetToken, setPurposeResetToken] = useState(0);
  const [reuseOpen, setReuseOpen] = useState(false);
  const [designResetToken, setDesignResetToken] = useState(0);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [captureDirty, setCaptureDirty] = useState(false);
  const [captureEditId, setCaptureEditId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [factEdits, setFactEdits] = useState<Record<string, string>>({});
  const [resumeId, setResumeId] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmApplication, setConfirmApplication] = useState<Application | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmClearProfile, setConfirmClearProfile] = useState(false);
  const [deleteApplicationId, setDeleteApplicationId] = useState('');
  const busyRef = useRef(false);
  const refreshingRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const chatEnd = useRef<HTMLDivElement>(null);
  const tabInfo = tab === 'settings' ? { label: '模型设置' } : tab === 'browser' ? { label: '浏览器扩展' } : tabs.find(item => item.id === tab)!;

  async function bootstrap() {
    setError('');
    try {
      const responses = await Promise.all([fetch('/api/state'), fetch('/api/status')]);
      if (responses.some(response => !response.ok)) throw new Error('暂时无法连接工作台，请确认服务已经启动。');
      const [next, nextStatus] = await Promise.all(responses.map(response => response.json())) as [WorkspaceState, AppStatus];
      setState(next); setStatus(nextStatus); setProfile(getDraft(next.profile)); setJob(next.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败，请重试。'); }
  }
  useEffect(() => { void bootstrap(); }, []);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [tab]);
  async function refreshWorkspace(announce = false) {
    if (busyRef.current || refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true);
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('岗位暂时无法刷新，请确认本机职航仍在运行。');
      const next = await response.json() as WorkspaceState;
      const previous = stateRef.current;
      // Imports happen outside this tab. Update the revision and saved records while
      // retaining every unsaved input, including editors owned by child components.
      if (!busyRef.current && previous && next.revision > previous.revision) {
        setProfile(draft => JSON.stringify(draft) === JSON.stringify(getDraft(previous.profile)) ? getDraft(next.profile) : draft);
        setJob(draft => JSON.stringify(draft) === JSON.stringify(previous.job) ? next.job : draft);
        setState(next); stateRef.current = next;
        if (announce) setNotice('已刷新工作台和导入岗位，你的未保存输入仍保留。');
      } else if (announce) setNotice('已是最新保存记录。');
    } finally { refreshingRef.current = false; setRefreshing(false); }
  }
  useEffect(() => {
    const update = () => { if (!document.hidden) void refreshWorkspace().catch(reason => setError(reason instanceof Error ? reason.message : '刷新失败。')); };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => { if (error) document.querySelector('[role=alert]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [error]);
  useEffect(() => { if (tab === 'interview') chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [state?.interview?.messages.length, tab]);

  async function refreshModelStatus(settings: ModelSettingsPublic) {
    setStatus(previous => previous ? { ...previous, mode: settings.mode, model: settings.mode === 'live' ? settings.model : '本地规则演示', modelConfigured: settings.mode === 'live' } : previous);
    setSettingsDirty(false);
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('模型配置已保存，但工作台状态暂时无法刷新。请刷新页面核对。');
    setStatus(await response.json() as AppStatus);
  }

  function setModelBusy(value: boolean) { busyRef.current = value; setBusy(value ? 'model_settings' : ''); }

  async function act(action: Action, message?: string): Promise<WorkspaceState | null> {
    if (!stateRef.current || busyRef.current) return null;
    if ((baseUnsaved || resumeDirty || captureDirty || designDirty) && ['generate_general_resume', 'generate_multi_resume'].includes(action.type)) { setError('请先保存其他资料、简历或设计修改，再生成新用途简历。'); return null; }
    if (nonDesignUnsaved && ['preview_resume_design', 'save_resume_design', 'select_resume_design', 'delete_resume_design'].includes(action.type)) { setError('请先保存其他个人资料、岗位或简历修改，再处理设计规则。'); return null; }
    if (hasUnsaved && ['prepare_applications', 'fill_applications', 'submit_applications', 'apply_resume_design', 'delete_application', 'delete_resume', 'clear_job', 'preview_fact_split', 'apply_fact_split', 'finish_career_chat', 'career_chat', 'select_directions', 'recommend_companies', 'select_companies', 'swipe_company', 'undo_company_swipe', 'refresh_jobs', 'research_company', 'open_company', 'activate_company', 'analyze_job', 'generate_resume', 'approve_resume', 'prepare_application', 'fill_application', 'submit_application', 'start_interview', 'answer_interview', 'chat_resume_edit'].includes(action.type)) {
      setNotice('');
      setError(`还有未保存的${unsavedLabels.join('、')}。请先保存并完成事实确认，再继续这一步，避免使用旧资料。`);
      return null;
    }
    if (action.type === 'extract_profile' && !action.profile.experienceText.trim()) { setError('经历输入为空。请先撤销清空或填写经历；删除已保存档案请使用专门的删除入口。'); return null; }
    busyRef.current = true; setBusy(action.type); setError(''); setNotice('');
    try {
      const response = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...action, expectedRevision: stateRef.current.revision }) });
      const result = await response.json();
      if (response.status === 409) {
        const latest = await fetch('/api/state');
        if (latest.ok) { const refreshed = await latest.json() as WorkspaceState; setState(refreshed); stateRef.current = refreshed; }
        setConfirmApplication(null); setConfirmChecked(false);
        throw new Error(`${typeof result.error === 'string' && result.error.trim() ? result.error : '操作与当前保存记录冲突。'} 已刷新记录，你的未保存输入仍保留。`);
      }
      if (!response.ok) {
        if (['prepare_applications', 'fill_applications', 'submit_applications'].includes(action.type)) {
          try { const latest = await fetch('/api/state', { cache: 'no-store' }); if (latest.ok) { const refreshed = await latest.json() as WorkspaceState; setState(refreshed); stateRef.current = refreshed; } } catch { /* Keep the action error; a manual refresh can recover saved batch items. */ }
        }
        throw new Error(result.error || '操作未完成，请稍后再试。');
      }
      const previousState = stateRef.current;
      const next = result as WorkspaceState;
      if (action.type === 'prepare_applications') message = `本次新增 ${next.applications.filter(application => !previousState.applications.some(existing => existing.id === application.id)).length} 条模拟申请；已有的目标不会重复创建。请逐项核对。`;
      setState(next); stateRef.current = next;
      if (action.type === 'load_example' || action.type === 'extract_profile' || action.type === 'accept_resume_import' || action.type === 'apply_fact_split') { setProfile(getDraft(next.profile)); setFactEdits({}); }
      if (action.type === 'clear_job') { setJob(next.job); setResumeId(''); setAnswer(''); }
      if (action.type === 'delete_resume') { setResumeId(''); setResumeDirty(false); if (!next.interview) setAnswer(''); }
      if (action.type === 'delete_application') { setDeleteApplicationId(''); if (confirmApplication?.id === action.applicationId) { setConfirmApplication(null); setConfirmChecked(false); } }
      if (action.type === 'clear_profile') { setPurposeDirty(false); setPurposeResetToken(value => value + 1); setDesignDirty(false); setDesignResetToken(value => value + 1); setProfile(getDraft(next.profile)); setFactEdits({}); setAnswer(''); setResumeId(''); setResumeDirty(false); setConfirmClearProfile(false); setTab('profile'); }
      if (action.type === 'load_example' || action.type === 'save_job' || action.type === 'activate_company' || action.type === 'open_company') setJob(next.job);
      if (action.type === 'update_fact') setFactEdits(previous => { const updated = { ...previous }; delete updated[action.factId]; return updated; });
      if (action.type === 'save_job' || action.type === 'open_company') setResumeId('');
      if (['generate_resume', 'generate_general_resume', 'generate_multi_resume', 'activate_company', 'open_company', 'save_resume_edit', 'chat_resume_edit', 'apply_resume_design'].includes(action.type)) { if (action.type !== 'open_company') setResumeId(next.activeResumeId || ''); setResumeDirty(false); setTab('resume'); }
      if (action.type === 'prepare_application' || action.type === 'prepare_applications') setTab('applications');
      if (action.type === 'fill_applications' || action.type === 'submit_applications') {
        const batch = next.applications.filter(application => action.applicationIds.includes(application.id));
        const attention = batch.filter(application => application.status === 'failed' || application.status === 'unknown');
        const completed = batch.filter(application => application.status === (action.type === 'fill_applications' ? 'filled' : 'confirmed')).length;
        setNotice(`本次 ${batch.length} 项：${completed} 项${action.type === 'fill_applications' ? '已填写' : '已核验模拟提交'}${attention.length ? `，${attention.length} 项需要处理` : ''}。请逐项查看记录。`);
        if (attention.length) setError(attention.some(application => application.status === 'unknown') ? '部分提交结果待核验，请先核验，勿重复提交。' : '部分操作失败，具体原因见对应记录。');
      }
      if (action.type === 'fill_application' || action.type === 'submit_application' || action.type === 'verify_application') {
        const application = next.applications.find(item => item.id === action.applicationId);
        if (!application) { setError('返回记录中没有找到本次申请，请刷新核对。'); return next; }
        if (application.status === 'failed' || application.status === 'unknown') {
          setError(application.error || (application.status === 'unknown' ? '提交结果待核验，请先核验，勿重复提交。' : '操作没有完成，请查看申请记录中的失败原因。'));
        } else if (action.type === 'fill_application' && application.status === 'filled') {
          setNotice('表单已填写，请核对截图与简历后确认模拟提交。');
        } else if (application.status === 'confirmed') {
          setNotice('已核验本次模拟申请，测试站回执已保存。');
        } else {
          setError(`当前申请状态为“${statusLabels[application.status]}”，请查看申请记录继续处理。`);
        }
      } else if (message) setNotice(message);
      return next;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成，请稍后再试。'); return null; }
    finally { busyRef.current = false; setBusy(''); }
  }

  async function uploadResume(file: File) {
    if (!state || busyRef.current) return;
    busyRef.current = true; setBusy('resume_import'); setError(''); setNotice('');
    try {
      const data = new FormData(); data.append('file', file); data.append('expectedRevision', String(state.revision));
      const response = await fetch('/api/resume-import', { method: 'POST', body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '简历未能解析，请检查文件内容后重试。');
      setState(result); setNotice('简历已解析。请核对自动填入的资料，再确认导入。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '上传失败，请重试。'); }
    finally { busyRef.current = false; setBusy(''); }
  }

  if (!state) return <div className="loading-screen"><div className="brand-mark"><Leaf size={26} /></div><h1>职航</h1><p>把下一步走清楚</p>{error ? <><div className="alert error">{error}</div><Button onClick={() => void bootstrap()}><RefreshCw size={16} />重新连接</Button></> : <LoaderCircle size={24} className="spin" />}</div>;

  const confirmed = state.profile.facts.filter(fact => fact.confirmed).length;
  const selectedResume = selectWorkspaceResume(state, resumeId);
  const showResumeMatch = !!state.analysis && !!selectedResume && !selectedResume.scope && !selectedResume.stale && selectedResume.job.company === state.job.company && selectedResume.job.title === state.job.title && selectedResume.job.text === state.job.text && selectedResume.job.candidateId === state.job.candidateId;
  const completed = [confirmed > 0, !!state.analysis || !!state.exploration?.companies.some(company => company.selected), state.resumes.some(resume => resume.approved), state.applications.some(application => application.status === 'confirmed'), !!state.interview?.messages.some(message => message.role === 'user')];
  const profileDirty = JSON.stringify(profile) !== JSON.stringify(getDraft(state.profile));
  const jobDirty = JSON.stringify(job) !== JSON.stringify(state.job);
  const factsDirty = Object.entries(factEdits).some(([id, text]) => { const fact = state.profile.facts.find(item => item.id === id); return !!fact && fact.text !== text; });
  const baseUnsaved = profileDirty || jobDirty || factsDirty;
  const nonPurposeUnsaved = baseUnsaved || resumeDirty || captureDirty || designDirty;
  const nonDesignUnsaved = baseUnsaved || resumeDirty || captureDirty || purposeDirty;
  const hasUnsaved = nonDesignUnsaved || designDirty;
  const unsavedLabels = [profileDirty ? '个人资料与经历' : '', jobDirty ? '目标岗位' : '', factsDirty ? '事实修改' : '', resumeDirty ? '简历编辑' : '', captureDirty ? '导入岗位修正' : '', designDirty ? '简历设计要求' : '', purposeDirty ? '简历用途' : ''].filter(Boolean);
  const hasSavedProfile = Object.entries(state.profile).some(([key, value]) => key !== 'facts' && typeof value === 'string' && !!value.trim()) || !!state.profile.facts.length || !!state.resumeImport || !!state.factPreview || !!state.exploration?.messages.length || !!state.exploration?.directions.length || !!state.interview;
  const isEmpty = !Object.values(profile).some(value => value?.trim()) && !Object.values(job).some(value => typeof value === 'string' && value.trim()) && state.profile.facts.length === 0 && state.resumes.length === 0;
  const running = (name: string) => busy === name ? <LoaderCircle size={16} className="spin" /> : null;
  const navigate = (next: Tab) => {
    if (next === tab) return;
    if (busy === 'model_settings') { setError('正在验证或保存模型连接，请等待结果后再离开。'); return; }
    if (settingsDirty && tab === 'settings') { setError('模型设置有未保存的修改，请先验证并启用，或放弃未保存修改后再离开。'); return; }
    if (resumeDirty && next !== 'resume') { setError('简历有未保存的修改，请先保存新版本或撤销修改后再离开。'); return; }
    if (captureDirty && next !== 'browser') { setError('导入岗位有未保存的修正，请先保存或放弃本次修改后再离开。'); return; }
    setTab(next); setError(''); setNotice('');
  };
  const editCapture = (id: string) => { setCaptureEditId(id); navigate('browser'); };

  function profileField(key: keyof ProfileDraft, label: string, placeholder: string, type?: string) {
    const limits: Partial<Record<keyof ProfileDraft, number>> = { name: 80, email: 160, phone: 40, school: 160, graduation: 80, city: 100, availability: 120 };
    return <Field key={key} label={label} value={profile[key] || ''} maxLength={limits[key] ?? 200} type={type} placeholder={placeholder} onChange={value => setProfile(previous => ({ ...previous, [key]: value }))} />;
  }


  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('profile'); }}><span className="brand-mark"><Leaf size={24} /></span><span><strong>职航<span className="brand-dot">.</span></strong><small>把下一步走清楚</small></span></a>
      <div className="sidebar-label">你的求职工作台</div>
      <nav className="main-nav" aria-label="工作台导航">{tabs.map((item, index) => <button className={`nav-item ${tab === item.id ? 'active' : ''}`} key={item.id} onClick={() => navigate(item.id)} aria-current={tab === item.id ? 'page' : undefined}><item.icon size={19} strokeWidth={1.7} /><span><strong>{item.label}</strong></span>{completed[index] ? <CircleCheck className="nav-complete" size={15} /> : <span className="nav-number">0{index + 1}</span>}</button>)}</nav>
      <div className="model-settings-nav"><button className={`nav-item ${tab === 'browser' ? 'active' : ''}`} onClick={() => navigate('browser')} aria-current={tab === 'browser' ? 'page' : undefined}><Puzzle size={19} strokeWidth={1.7} /><span><strong>浏览器扩展</strong><small>连接浏览器 · 查看导入岗位</small></span></button><button className={`nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')} aria-current={tab === 'settings' ? 'page' : undefined}><Settings2 size={19} strokeWidth={1.7} /><span><strong>模型设置</strong><small>{status?.mode === 'live' ? '已连接真实模型' : '接入你的模型 API'}</small></span>{status?.mode === 'live' && <CircleCheck className="nav-complete" size={15} />}</button></div>
      <div className="sidebar-note"><FolderHeart size={23} strokeWidth={1.5} /><h3>每段经历，都有价值。</h3><p>先把真实的你整理好，<br />再一起找到合适的表达。</p><div><span className="tiny-dot" />本浏览器工作区 · 自动保存已完成步骤</div></div>
      <div className="sidebar-footer"><ShieldCheck size={15} /><span>真实经历 · 可追溯记录</span></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>求职工作台</span><ChevronRight size={14} /><strong>{tabInfo.label}</strong></div><div className="workspace-chip"><button className="workspace-refresh" disabled={!!busy || refreshing} title="刷新保存记录，不覆盖未保存输入" aria-label="刷新工作台记录" onClick={() => void refreshWorkspace(true).catch(reason => setError(reason instanceof Error ? reason.message : '刷新失败。'))}><RefreshCw size={15} className={refreshing ? 'spin' : ''} /></button><span className="tiny-dot" />{state.profile.name ? `${state.profile.name}的工作区` : '我的工作区'}<span className="avatar">{state.profile.name?.slice(0, 1) || '我'}</span></div></header>
      <div className={`mode-banner ${status?.mode === 'live' ? 'live' : ''}`}><FlaskConical size={16} /><span>{status?.mode === 'live' ? <><strong>{status.model}</strong> 已连接 · 真实网申需单独授权</> : <><strong>本地演示模式</strong> · 真实网申需单独授权</>}</span><button className="model-banner-link" onClick={() => navigate('settings')}>{status?.mode === 'live' ? '管理模型' : '接入真实模型'}<ArrowRight size={13} /></button><a href="/sandbox" target="_blank" rel="noreferrer">查看测试站<ArrowUpRight size={14} /></a></div>

      <div className="page-content">
        <div className="page-heading"><div><h1>{tabInfo.label}</h1><p className="page-description">{tab === 'profile' ? '上传已有简历，或写下做过的事。职航自动梳理资料，你来确认每一条事实。' : tab === 'job' ? '先聊行业与岗位方向，再滑动发现机会，把喜欢的岗位变成下一份简历。' : tab === 'resume' ? '创建专岗、通用或多岗简历；同一审核版本可选择多个投递岗位。' : tab === 'applications' ? '分别查看真实网申与模拟测试的岗位、简历版本和处理结果。' : tab === 'settings' ? '填写自己的 API 密钥，验证连接后，在原有工作流中使用真实模型。' : tab === 'browser' ? '从日常浏览器采集岗位，预览确认后带回职航，继续滑卡、研究公司和准备简历。' : '围绕实际简历和岗位练习，回答后获得反馈与进一步追问。'}</p></div>{tab === 'profile' && isEmpty && <Button variant="secondary" disabled={!!busy} onClick={() => void act({ type: 'load_example' }, '示例资料已载入。请点击“梳理经历”，再逐条确认事实。')}><Sparkles size={16} />{running('load_example')}载入示例资料</Button>}</div>

        {error && <div className="alert error" role="alert"><CircleAlert size={18} /><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="alert success" role="status"><CircleCheck size={18} /><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {hasUnsaved && <div className="alert warning draft-alert" role="status"><CircleAlert size={18} /><div><strong>有未保存的修改：{unsavedLabels.join('、')}</strong><p>请保存正在编辑的内容。相关分析、审核、投递和面试操作会在保存后恢复。</p><div>{(profileDirty || factsDirty) && <Button variant="quiet" onClick={() => navigate('profile')}>返回经历保存</Button>}{jobDirty && <Button variant="quiet" onClick={() => navigate('job')}>返回岗位保存</Button>}{purposeDirty && <Button variant="quiet" onClick={() => navigate('resume')}>返回用途草稿</Button>}{designDirty && <Button variant="quiet" onClick={() => navigate('resume')}>返回设计保存</Button>}{resumeDirty && <Button variant="quiet" onClick={() => navigate('resume')}>返回简历保存</Button>}</div></div></div>}

        {tab === 'browser' && <><BrowserConnectionsPanel /><CapturedJobsPanel state={state} busy={busy} act={act} onRefresh={() => refreshWorkspace(true)} onDiscover={() => navigate('job')} initialEditId={captureEditId} onDirty={setCaptureDirty} /></>}

        {tab === 'settings' && <ModelSettingsPanel disabled={!!busy} onDirty={setSettingsDirty} onBusy={setModelBusy} onSaved={refreshModelStatus} />}

        {tab === 'profile' && <>
          <ResumeImportPanel key={state.resumeImport?.importedAt || 'empty-import'} imported={state.resumeImport} busy={!!busy} upload={uploadResume} act={act} />
          <div className="profile-layout"><section className="card profile-card"><div className="card-heading"><span className="section-number">01</span><div><h2>先认识一下你</h2><p>这些信息将用于简历和模拟网申，请填写真实资料。</p></div>{profileDirty && <span className="tag amber">尚未保存</span>}</div><div className="profile-draft-toolbar"><span>清空本页只影响基本资料和经历输入，已保存档案不变。</span><ClearDraftControl value={profile} emptyValue={emptyProfile} onChange={setProfile} label="本页个人资料输入" clearLabel="清空本页" disabled={!!busy} resetKey={state.revision} /></div><div className="form-grid">{profileField('name', '姓名', '你的姓名')}{profileField('targetRole', '已有意向岗位（可留空）', '还不清楚也没关系，下一步一起探索')}{profileField('school', '学校', '学校名称')}{profileField('major', '专业', '如：法学、新闻学、计算机')}<label className="field"><span>最高学历</span><select aria-label="最高学历" value={profile.education} onChange={event => setProfile(previous => ({ ...previous, education: event.target.value }))}><option value="">暂不填写</option>{['本科', '硕士', '博士', '专科', '其他'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{profileField('graduation', '毕业时间', '如：2027 年 6 月')}{profileField('city', '意向城市', '如：北京、上海')}{profileField('email', '邮箱', '用于接收招聘消息', 'email')}{profileField('phone', '手机号', '你的联系电话', 'tel')}{profileField('availability', '到岗时间 / 实习时长', '如：两周内到岗，可实习 3 个月')}</div><div className="section-divider" /><div className="card-heading compact"><span className="section-number">02</span><div><h2>讲讲你做过的事</h2><p>项目、实习、社团、课程作业都可以。也可以直接粘贴简历文字。</p></div></div><label className="field"><span className="sr-only">个人经历</span><textarea aria-label="个人经历" className="experience-input" maxLength={30000} value={profile.experienceText} onChange={event => setProfile(previous => ({ ...previous, experienceText: event.target.value }))} placeholder={'可以从一件具体的事开始：\n\n我参与了什么项目？我负责哪一部分？\n遇到了什么问题，具体做了什么？\n最后有什么结果，有哪些记录可以佐证？'} /></label><ClearInputControl value={profile.experienceText} onChange={experienceText => setProfile(previous => ({ ...previous, experienceText }))} label="个人经历" disabled={!!busy} resetKey={state.revision} /><div className="form-footer"><span><ShieldCheck size={15} />保存并梳理后，逐条确认事实</span><Button disabled={!!busy || !profile.experienceText.trim()} onClick={() => void act({ type: 'extract_profile', profile }, '经历已梳理，请检查并确认下方的事实。')}>{running('extract_profile') || <Sparkles size={16} />}梳理经历<ArrowRight size={16} /></Button></div></section>
          <aside className="context-column"><section className="guide-card"><span className="guide-icon"><Leaf size={30} strokeWidth={1.4} /></span><p className="eyebrow">A LITTLE GUIDANCE</p><h2>你来讲故事，<br />我们一起理清线索。</h2><p>不需要先写得漂亮。具体、真实的细节，比完整的套话更有用。</p><ol><li><span>1</span><div><strong>说清你的角色</strong><p>团队做了什么，你负责什么。</p></div></li><li><span>2</span><div><strong>留下行动的细节</strong><p>用了什么方法，解决什么问题。</p></div></li><li><span>3</span><div><strong>有依据再写数字</strong><p>不确定的数据，留待补充。</p></div></li></ol></section><section className="fact-summary"><div><ShieldCheck size={18} /><strong>你的事实档案</strong></div><p><span>{confirmed}</span><small> / {state.profile.facts.length} 条已确认</small></p><div className="progress-track"><span style={{ width: `${state.profile.facts.length ? confirmed / state.profile.facts.length * 100 : 0}%` }} /></div><small>确认后的经历才能用于简历生成。</small></section></aside></div>

          <section className="profile-delete-section" aria-label="已保存个人档案管理"><div><h2>已保存的个人档案</h2><p>需要重新开始时，可以删除当前资料。清空本页输入不会删除它。</p></div>{state.resumes.length > 0 && <button type="button" className="button quiet" disabled={!!busy} onClick={() => { setResumeId(state.resumes.at(-1)!.id); navigate('resume'); }}>查看保留的简历</button>}<button type="button" className="button quiet danger-text" disabled={!!busy || !hasSavedProfile} onClick={() => setConfirmClearProfile(true)}>删除当前个人档案</button>
            {confirmClearProfile && <div className="profile-delete-confirm" role="alertdialog" aria-labelledby="delete-profile-title" aria-describedby="delete-profile-description" onKeyDown={event => { if (event.key === 'Escape' && !busy) setConfirmClearProfile(false); }}><h3 id="delete-profile-title">删除已保存的当前个人档案？</h3><div id="delete-profile-description"><p>将删除当前基本资料、经历事实、导入预览、方向探索聊天与偏好、临时附件和当前面试对话，也会清空本页未保存的个人输入与未保存的设计草稿。</p><p><strong>继续保留：</strong>历史简历快照和投递记录、岗位与喜欢清单、已保存的设计规则、模型配置。历史简历仍含原有个人信息，但会标记为历史版本。</p><p>这次删除不能撤销；尚未完成的模拟申请需要重新准备。</p></div><div className="inline-buttons"><button type="button" className="button secondary" autoFocus disabled={!!busy} onClick={() => setConfirmClearProfile(false)}>取消删除</button><button type="button" className="button danger" disabled={!!busy} onClick={() => void act({ type: 'clear_profile' }, '当前个人档案已删除。历史简历、投递记录、岗位和模型配置保留。')}>{busy === 'clear_profile' && <LoaderCircle size={15} className="spin" />}确认删除当前档案</button></div></div>}
          </section>
          <FactSplitReview state={state} busy={busy} act={act} /><section className="card facts-section"><div className="card-heading"><span className="section-number">03</span><div><h2>把事实确认下来</h2><p>可以修正表述。确认意味着这条内容符合你的真实经历。</p></div><span className="tag neutral">{state.profile.facts.length} 条记录</span></div><AgentReviewStatus run={state.factOrganization} />{state.profile.facts.length === 0 ? <div className="fact-empty"><CheckCheck size={24} /><p>梳理经历后，待确认的事实会出现在这里。</p></div> : <div className="facts-list">{state.profile.facts.map((fact, index) => <article className={`fact-item ${fact.confirmed ? 'verified' : ''}`} key={fact.id}><div className="fact-item-head"><span className="fact-index">事实 {String(index + 1).padStart(2, '0')}</span><span className={`tag ${fact.confirmed ? 'green' : 'amber'}`}>{fact.confirmed ? <Check size={12} /> : <Clock3 size={12} />}{fact.confirmed ? '已确认' : '待你确认'}</span></div><FactContext fact={fact} /><textarea aria-label={`事实 ${index + 1}`} maxLength={3000} value={factEdits[fact.id] ?? fact.text} onChange={event => setFactEdits(previous => ({ ...previous, [fact.id]: event.target.value }))} /><FactReviewNote fact={fact} /><FactSources fact={fact} /><div className="fact-actions">{factEdits[fact.id] !== undefined && factEdits[fact.id] !== fact.text && <Button variant="quiet" disabled={!!busy || !factEdits[fact.id].trim()} onClick={() => void act({ type: 'update_fact', factId: fact.id, text: factEdits[fact.id], confirmed: false })}>保存修改</Button>}<Button variant={fact.confirmed ? 'quiet' : 'secondary'} disabled={!!busy || !(factEdits[fact.id] ?? fact.text).trim()} onClick={() => void act({ type: 'update_fact', factId: fact.id, text: factEdits[fact.id] ?? fact.text, confirmed: !(fact.confirmed && factEdits[fact.id] === undefined) })}>{fact.confirmed && factEdits[fact.id] === undefined ? '撤销确认' : <><Check size={14} />确认属实</>}</Button></div></article>)}</div>}{state.questions.length > 0 && <div className="questions-box"><MessageCircle size={19} /><div><strong>这些细节还可以补充</strong><ul>{state.questions.map((question, index) => <li key={index}>{question}</li>)}</ul><p>把补充信息写入上方经历，再次梳理；更新后的事实需要重新审核。</p></div></div>}<div className="section-next"><span>{confirmed > 0 ? '事实已就绪，可以一起探索行业与岗位方向。' : '先确认至少一条事实，再继续下一步。'}</span><Button disabled={!!busy || confirmed === 0} onClick={() => navigate('job')}>去探索方向与公司<ArrowRight size={16} /></Button></div></section>
        </>}

        {tab === 'job' && <><CareerExplorer state={state} busy={busy} blocked={baseUnsaved || designDirty || purposeDirty} act={act} onEditCapture={editCapture} onOpenCaptures={() => navigate('browser')} /><details className="manual-job-details"><summary>已有明确岗位 / 补充真实 JD<span>直接粘贴招聘要求进行匹配</span></summary>{state.job.sourceKind === 'exploration' && <p className="inline-error">下方是方向探索资料，并非招聘原文。请核实具体职位后替换内容并保存。</p>}<div className="job-layout"><section className="card"><div className="card-heading"><span className="section-number">01</span><div><h2>你的目标岗位</h2><p>粘贴完整招聘要求，保留工作内容与任职条件。</p></div>{jobDirty && <span className="tag amber">尚未保存</span>}</div><div className="form-grid"><Field label="公司名称" value={job.company} placeholder="招聘公司" onChange={value => setJob(previous => ({ ...previous, company: value }))} /><Field label="岗位名称" value={job.title} placeholder="如：产品实习生" onChange={value => setJob(previous => ({ ...previous, title: value }))} /><Field wide maxLength={2000} label="招聘页面链接（选填，仅保存来源）" value={job.url} placeholder="https://…" onChange={value => setJob(previous => ({ ...previous, url: value }))} /></div><label className="field job-description"><span>岗位描述 / JD</span><textarea aria-label="手动岗位 JD" maxLength={16000} value={job.text} placeholder="粘贴岗位职责、任职要求、实习时间等信息…" onChange={event => setJob(previous => ({ ...previous, text: event.target.value }))} /></label><ClearInputControl value={job.text} onChange={text => setJob(previous => ({ ...previous, text }))} label="手动岗位 JD" disabled={!!busy} resetKey={state.revision} /><div className="form-footer"><span>已确认 {confirmed} 条经历供分析参考</span><Button disabled={!!busy || !job.company.trim() || !job.title.trim() || job.text.trim().length < 10} onClick={async () => { const saved = await act({ type: 'save_job', job }, '岗位已保存，可以开始匹配分析。'); if (saved) setJob(saved.job); }}>{running('save_job') || <Check size={16} />}保存岗位</Button></div></section><section className="card match-card"><div className="card-heading"><span className="section-number">02</span><div><h2>岗位与经历的交集</h2><p>依据已确认事实给出匹配说明。</p></div></div>{!state.analysis ? <Empty icon={BriefcaseBusiness} title="从具体要求开始匹配" description="保存岗位后，逐项查看你有哪些经历可以支撑，哪些内容需要继续补充。" action={<Button disabled={!!busy || !state.job.text || confirmed === 0 || hasUnsaved} onClick={() => void act({ type: 'analyze_job' })}>{running('analyze_job') || <Sparkles size={16} />}分析岗位匹配</Button>} /> : <><MatchAnalysis analysis={state.analysis} profile={state.profile} job={state.job} /><div className="form-footer"><Button variant="quiet" disabled={!!busy || hasUnsaved} onClick={() => void act({ type: 'analyze_job' })}>{running('analyze_job') || <RefreshCw size={14} />}重新分析</Button><Button disabled={!!busy || hasUnsaved || confirmed === 0} onClick={() => void act({ type: 'generate_resume' }, '已生成岗位简历。请审核后用于模拟投递。')}>{running('generate_resume') || <FileText size={16} />}生成岗位简历<ArrowRight size={16} /></Button></div></>}</section></div></details></>}

        <div hidden={tab !== 'resume'}><ResumePurposePanel key={purposeResetToken} state={state} busy={!!busy} blocked={nonPurposeUnsaved} onDirty={setPurposeDirty} onSingle={() => { setResumeId(''); if (!state.job.company || !state.job.title) navigate('job'); }} act={act} /></div>
        <div hidden={tab !== 'resume'}><ResumeDesignPanel key={designResetToken} state={state} resume={selectedResume} busy={!!busy} blocked={nonDesignUnsaved} onDirty={setDesignDirty} act={act} /></div>
        {tab === 'resume' && !!(state.job.candidateId || state.job.company.trim() || state.job.title.trim() || state.job.text.trim()) && <CurrentJobRemoval key={JSON.stringify(state.job)} job={state.job} busy={!!busy} dirty={hasUnsaved} act={act} />}
        {tab === 'resume' && !selectedResume && state.resumes.length > 0 && <section className="resume-history-picker"><label className="field"><span>查看历史简历</span><select aria-label="打开历史简历" value="" disabled={!!busy || hasUnsaved} onChange={event => setResumeId(event.target.value)}><option value="">选择已保存的版本…</option>{[...state.resumes].reverse().map(resume => <option key={resume.id} value={resume.id}>V{resume.version} · {resumeLabel(resume)}</option>)}</select></label><p>只打开已有版本，不恢复当前岗位。</p></section>}
        {tab === 'resume' && (!selectedResume ? state.job.company && state.job.title ? <ResumePreparation state={state} job={job} onChange={setJob} busy={busy} dirty={baseUnsaved} blocked={designDirty || purposeDirty} act={act} onProfile={() => navigate('profile')} /> : <section className="card"><Empty title="先探索方向，再准备合适的简历" description="上传或整理经历后，和 Agent 聊聊行业与岗位。选定公司即可生成第一份简历，也可以直接提供明确的 JD。" action={<Button onClick={() => navigate(confirmed ? 'job' : 'profile')}>前往{confirmed ? '方向与公司' : '我的经历'}<ArrowRight size={16} /></Button>} /></section> : <><div className="model-generation-note"><span className="job-source-badge">{selectedResume.scope ? selectedResume.scope.kind === 'general' ? '通用简历' : '多岗位共用简历' : sourceName(selectedResume.job.sourceKind)}</span><Sparkles size={15} /><span>{selectedResume.generation ? selectedResume.generation.mode === 'live' ? <>本版由真实模型 <strong>{selectedResume.generation.model}</strong> 生成</> : <>本版来源：<strong>本地规则演示</strong></> : '历史版本 · 来源未记录'}{selectedResume.authoredBy === 'user' ? ' · 含手动编辑' : ''}</span></div><>{showResumeMatch && state.analysis && <details className="resume-match-details"><summary>核对岗位匹配依据<span>必要条件、加分项与工作职责</span></summary><MatchAnalysis analysis={state.analysis} profile={selectedResume.profile} job={selectedResume.job} /></details>}</><ResumeStudio key={selectedResume.id} resume={selectedResume} resumes={state.resumes} applicationCount={state.applications.filter(application => application.resumeId === selectedResume.id).length} busy={!!busy} blocked={baseUnsaved || designDirty || purposeDirty} onSelect={setResumeId} onDirty={setResumeDirty} onNavigate={navigate} onChooseTargets={() => { setReuseOpen(true); setTimeout(() => document.getElementById('resume-reuse')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }} act={act} /><ResumeReusePanel key={`reuse-${selectedResume.id}`} state={state} resume={selectedResume} busy={!!busy} blocked={hasUnsaved} open={reuseOpen} onOpen={setReuseOpen} act={act} renderReal={props => <RealApplicationPanel {...props} />} /></>)}

        {tab === 'applications' && <><RealApplicationRecords busy={!!busy} />{state.applications.length > 0 && <ApplicationBatchPanel state={state} busy={!!busy} blocked={hasUnsaved} browserAvailable={!!status?.browserAvailable} act={act} />}<div className="application-summary"><div><span>模拟申请</span><strong>{state.applications.length}<small>份</small></strong></div><div><span>已核验提交</span><strong>{state.applications.filter(application => application.status === 'confirmed').length}<small>份</small></strong></div><div><span>需要你关注</span><strong>{state.applications.filter(application => ['unknown', 'failed', 'filled'].includes(application.status)).length}<small>份</small></strong></div><p><FlaskConical size={23} /><span>以下模拟操作在自建招聘测试站完成，<br />不会向真实企业发送申请。</span></p></div>{state.applications.length === 0 ? <section className="card"><Empty icon={Send} title="下一次申请，从一份审核过的简历开始" description="申请记录将保存岗位、简历版本、填写状态与提交结果，方便你持续跟进。" action={<Button onClick={() => navigate('resume')}>前往岗位简历<ArrowRight size={16} /></Button>} /></section> : <div className="applications-list">{[...state.applications].reverse().map(application => { const resume = state.resumes.find(item => item.id === application.resumeId); const target = applicationTarget(application, resume); return <article className="card application-card" key={application.id}><div className="application-card-head"><span className="company-icon"><BriefcaseBusiness size={25} strokeWidth={1.5} /></span><div><h2>{target.title}</h2><p>{target.company}{target.location ? ` · ${target.location}` : ''} <span>·</span> 简历 V{resume?.version ?? '—'} <span>·</span> {dateLabel(application.createdAt)}</p></div><span className={`tag ${application.status === 'confirmed' ? 'green' : ['failed', 'unknown'].includes(application.status) ? 'amber' : 'neutral'}`}>{statusLabels[application.status]}</span></div><div className="application-steps">{['准备材料', '填写表单', '确认提交', '核验回执'].map((step, index) => { const reached = application.status === 'confirmed' ? 4 : application.status === 'filled' ? 2 : ['submitting', 'unknown'].includes(application.status) ? 3 : 1; return <div className={index < reached ? 'reached' : ''} key={step}><span>{index < reached ? <Check size={12} /> : index + 1}</span>{step}</div>; })}</div>{application.receipt && <p className="receipt"><CircleCheck size={16} />模拟回执：{application.receipt}</p>}{application.error && <p className="inline-error"><CircleAlert size={15} />{application.error}</p>}{application.status === 'unknown' && <p className="inline-error">提交结果尚未确认。请先核验，避免重复提交。</p>}<div className="application-actions"><button type="button" className="button quiet danger-text" disabled={!!busy || hasUnsaved} onClick={() => setDeleteApplicationId(application.id)}>删除记录</button><span className="simulation-label"><FlaskConical size={14} />模拟申请</span>{application.evidence && <a className="button quiet" href={`/api/applications/${application.id}/evidence`} target="_blank" rel="noreferrer">查看执行截图<ArrowUpRight size={14} /></a>}{['prepared', 'failed'].includes(application.status) && <Button disabled={!!busy || hasUnsaved || !status?.browserAvailable || !resume || !!resume.stale} onClick={() => void act({ type: 'fill_application', applicationId: application.id }, '表单已填写，请核对截图与简历后确认模拟提交。')}>{running('fill_application') || <FileText size={16} />}{application.status === 'failed' ? '重新填写表单' : '自动填写测试表单'}</Button>}{application.status === 'filled' && <Button disabled={!!busy || hasUnsaved || !resume || !!resume.stale} onClick={() => { setConfirmApplication(application); setConfirmChecked(false); }}>核对并模拟提交<ArrowRight size={16} /></Button>}{['unknown', 'submitting', 'confirmed'].includes(application.status) && <Button variant={application.status === 'confirmed' ? 'secondary' : 'primary'} disabled={!!busy} onClick={() => void act({ type: 'verify_application', applicationId: application.id }, '已重新核验本次申请记录。')}>{running('verify_application') || <RefreshCw size={15} />}{application.status === 'confirmed' ? '重新核验' : '核验提交结果'}</Button>}</div>{deleteApplicationId === application.id && <InlineRemovalConfirm title="删除这条模拟投递记录？" confirmLabel="确认删除记录" busy={!!busy} disabled={hasUnsaved} onCancel={() => setDeleteApplicationId('')} onConfirm={() => void act({ type: 'delete_application', applicationId: application.id }, '模拟投递记录已删除，关联简历和岗位保留。')}><p>删除“{application.company} · {application.jobTitle}”的这条记录及模拟回执，无法撤销。关联的简历版本和岗位继续保留。</p><p>这不会撤回任何真实投递或向招聘方发送消息。</p></InlineRemovalConfirm>}</article>; })}</div>}{!status?.browserAvailable && <div className="alert warning"><CircleAlert size={18} /><span>浏览器执行环境尚未就绪，暂时无法自动填写测试表单。其他求职流程可以继续使用。</span></div>}</>}

        {tab === 'interview' && <div className="interview-layout"><section className="card chat-card"><div className="chat-header"><span className="chat-avatar"><MessageCircle size={20} /></span><div><h2>你的面试练习室</h2><p>{state.interview ? (() => { const resume = state.resumes.find(item => item.id === state.interview!.resumeId); return `${resume ? resumeLabel(resume) : '历史简历'} · 简历 V${resume?.version || ''}`; })() : '围绕具体经历，练习清晰表达'}</p></div><span className="tag neutral">文字练习</span></div><div className="chat-messages" aria-live="polite">{!state.interview ? <Empty icon={MessageCircle} title="从你熟悉的经历开始" description="选择一版简历，职航将结合岗位要求提问。你可以按背景、任务、行动、结果组织答案。" /> : state.interview.messages.map((message, index) => <div className={`chat-message ${message.role}`} key={index}><span className="message-avatar">{message.role === 'assistant' ? <Leaf size={16} /> : (state.profile.name?.slice(0, 1) || '我')}</span><div><small>{message.role === 'assistant' ? '职航 · 面试陪练' : '我的回答'}</small><p>{message.content}</p></div></div>)}{busy === 'answer_interview' && <div className="chat-thinking"><LoaderCircle size={14} className="spin" />正在整理反馈…</div>}<div ref={chatEnd} /></div><form className="chat-composer" onSubmit={async event => { event.preventDefault(); if (answer.trim() && await act({ type: 'answer_interview', answer: answer.trim() })) setAnswer(''); }}><textarea aria-label="面试回答" maxLength={4000} value={answer} disabled={!state.interview || !!busy || hasUnsaved} onChange={event => setAnswer(event.target.value)} placeholder={state.interview ? '写下你的回答，具体说明你做了什么…' : '先在右侧选择简历并开始练习'} /><ClearInputControl value={answer} onChange={setAnswer} label="面试回答" disabled={!!busy} resetKey={state.revision} /><div><span>真实细节，比标准答案更有力量。</span><Button type="submit" disabled={!!busy || hasUnsaved || !state.interview || !answer.trim()}>{running('answer_interview') || <Send size={15} />}发送回答</Button></div></form></section><aside className="context-column"><section className="card review-card"><div className="card-heading"><FileText size={20} /><div><h2>练习依据</h2><p>使用该版本的固定经历快照</p></div></div><label className="field"><span>选择简历版本</span><select disabled={!!busy || state.resumes.length === 0} value={selectedResume?.id || ''} onChange={event => setResumeId(event.target.value)}>{!selectedResume && <option value="">{state.resumes.length ? '请选择简历版本' : '暂无简历'}</option>}{[...state.resumes].reverse().map(resume => <option key={resume.id} value={resume.id}>V{resume.version} · {resumeLabel(resume)}{resume.approved ? ' · 已审核' : ' · 未审核'}</option>)}</select></label>{selectedResume && !selectedResume.approved && <p className="subtle-text">请先在岗位简历中确认内容准确，再开始练习。</p>}<Button className="full-width" disabled={!!busy || hasUnsaved || !selectedResume?.approved} onClick={() => selectedResume && void act({ type: 'start_interview', resumeId: selectedResume.id })}>{running('start_interview') || <MessageCircle size={16} />}{state.interview ? '重新开始练习' : '开始面试练习'}</Button>{state.interview && <p className="subtle-text">重新开始会替换当前练习对话。</p>}</section><section className="guide-card interview-guide"><p className="eyebrow">MAKE IT YOUR OWN</p><h2>让回答有一个<br />清晰的脉络。</h2><ol><li><span>S</span><div><strong>当时发生了什么？</strong><p>交代场景和问题。</p></div></li><li><span>T</span><div><strong>你的任务是什么？</strong><p>明确自己的责任。</p></div></li><li><span>A</span><div><strong>你具体如何行动？</strong><p>分享判断和做法。</p></div></li><li><span>R</span><div><strong>结果与反思是什么？</strong><p>用真实证据说明。</p></div></li></ol></section></aside></div>}

        {tab !== 'settings' && tab !== 'browser' && state.events.length > 0 && <details className="activity-log"><summary><Clock3 size={15} />最近活动<span>{state.events.length} 条记录</span></summary><div>{[...state.events].reverse().slice(0, 8).map(event => <p key={event.id}><time>{dateLabel(event.at)}</time><strong>{event.title}</strong><span>{event.detail}</span></p>)}</div></details>}
        <footer className="page-footer"><span>职航 · 从真实经历，到下一次机会</span><span>版本 {status?.version || '0.3.0'}</span></footer>
      </div>
    </main>

    {confirmApplication && <div className="modal-backdrop" onClick={() => !busy && setConfirmApplication(null)}><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={event => event.stopPropagation()}><button className="modal-close" aria-label="关闭提交确认" disabled={!!busy} onClick={() => setConfirmApplication(null)}><X size={19} /></button><span className="modal-icon"><Send size={26} /></span><h2 id="confirm-title">确认这一次模拟申请</h2><p>此操作会向自建测试站提交表单，生成可核验的模拟回执。</p><dl><div><dt>目标公司</dt><dd>{confirmApplication.company}</dd></div><div><dt>目标岗位</dt><dd>{confirmApplication.jobTitle}</dd></div><div><dt>简历版本</dt><dd>V{state.resumes.find(resume => resume.id === confirmApplication.resumeId)?.version || '—'}</dd></div><div><dt>执行环境</dt><dd>自建招聘测试站 · 模拟</dd></div></dl>{confirmApplication.evidence && <a className="evidence-link" href={`/api/applications/${confirmApplication.id}/evidence`} target="_blank" rel="noreferrer">查看填写后的表单截图<ArrowUpRight size={14} /></a>}<label className="confirmation-check"><input type="checkbox" checked={confirmChecked} onChange={event => setConfirmChecked(event.target.checked)} /><span>我已核对岗位、简历版本与填写内容，确认进行本次模拟提交。</span></label><div className="modal-actions"><Button variant="secondary" disabled={!!busy} onClick={() => setConfirmApplication(null)}>返回核对</Button><Button disabled={!!busy || hasUnsaved || !confirmChecked || !!state.resumes.find(item => item.id === confirmApplication.resumeId)?.stale} onClick={async () => { const updated = await act({ type: 'submit_application', applicationId: confirmApplication.id, confirmed: true }); if (updated) { setConfirmApplication(null); setConfirmChecked(false); } }}>{running('submit_application') || <Send size={15} />}确认并模拟提交</Button></div></section></div>}
    {busy && <div className="busy-indicator" role="status"><LoaderCircle size={15} className="spin" /><span>{['fill_application', 'submit_application', 'verify_application', 'fill_applications', 'submit_applications'].includes(busy) ? '正在操作测试浏览器，请稍候…' : busy === 'model_settings' ? '正在处理模型连接，请稍候…' : '正在处理，请稍候…'}</span></div>}
  </div>;
}
