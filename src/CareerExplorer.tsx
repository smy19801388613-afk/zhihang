import { useEffect, useRef, useState } from 'react';
import { BriefcaseBusiness, Check, Leaf, LoaderCircle, MessageCircle, Send, Sparkles, Trash2, ArrowRight, Globe } from 'lucide-react';
import type { Action, CareerAttachment, WorkspaceState } from '../shared/types';
import JobDiscovery from './JobDiscovery';
import CareerAttachmentInput from './CareerAttachmentInput';
import ClearInputControl from './ClearInputControl';

type Props = { state: WorkspaceState; busy: string; blocked: boolean; act: (action: Action, message?: string) => Promise<WorkspaceState | null>; onEditCapture?: (id: string) => void; onOpenCaptures?: () => void };
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(value => b.includes(value));
export default function CareerExplorer({ state, busy, blocked, act, onEditCapture, onOpenCaptures }: Props) {
  const exploration = state.exploration;
  const messagesEnd = useRef<HTMLDivElement>(null), directionsSection = useRef<HTMLElement>(null);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [exploration?.messages.length, busy]);
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<CareerAttachment[]>([]);
  const [uploading, setUploading] = useState(false), [confirmClear, setConfirmClear] = useState(false);
  const [directions, setDirections] = useState<string[]>(exploration?.selectedDirectionIds || []);
  const persistedDirections = exploration?.selectedDirectionIds || [];
  const directionKey = JSON.stringify(persistedDirections);
  useEffect(() => { setDirections(JSON.parse(directionKey)); }, [directionKey]);
  const availableDirectionKey = JSON.stringify(exploration?.directions.map(direction => direction.id) || []);
  useEffect(() => { const available = new Set<string>(JSON.parse(availableDirectionKey)); setDirections(previous => previous.filter(id => available.has(id))); }, [availableDirectionKey]);
  const directionsDirty = !sameSet(directions, persistedDirections);
  const disabled = !!busy || blocked || uploading;
  const phase = exploration?.conversationPhase || (exploration?.directions.length ? 'compare' : 'explore');
  const ready = phase === 'ready';
  const toggle = (value: string, values: string[]) => values.includes(value) ? values.filter(item => item !== value) : [...values, value];
  async function send(content: string) {
    if (disabled || (!content.trim() && !attachments.length)) return;
    const next = await act({ type: 'career_chat', message: content.trim() || '请结合附件帮我分析可考虑的行业和岗位方向。', attachmentIds: attachments.map(item => item.id) });
    if (next) {
      setMessage(''); setAttachments([]);
      for (const item of attachments) void fetch(`/api/career-attachments/${item.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  async function finish() {
    if (ready || await act({ type: 'finish_career_chat' })) directionsSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function discover() {
    if (directionsDirty && !await act({ type: 'select_directions', directionIds: directions })) return;
    await act({ type: 'recommend_companies' }, '已查找岗位，采集结果与来源覆盖情况见下方。');
  }
  async function clear() {
    if (await act({ type: 'clear_career_chat' }, '聊天已清空，已保存岗位和简历仍保留。')) { setConfirmClear(false); setMessage(''); setAttachments([]); setDirections([]); }
  }
  return <div className="career-explorer">
    {onOpenCaptures && <div className="capture-job-entry"><BriefcaseBusiness size={21} /><div><strong>{Object.keys(state.browserCaptures || {}).length ? `已保留 ${Object.keys(state.browserCaptures || {}).length} 个浏览器导入岗位` : '也可以从正在浏览的招聘页面带回岗位'}</strong><p>在自己的浏览器中筛选，导入后进入滑卡池。</p></div><button className="button quiet" onClick={onOpenCaptures}>浏览器扩展与已导入岗位</button></div>}
    <ol className="career-progress" aria-label="方向探索流程">{[['explore','了解偏好'],['compare','比较方向'],['ready','确认并找岗位']].map(([key,label],index) => <li key={key} className={phase === key ? 'current' : ''} aria-current={phase === key ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    <section className="card chat-card career-chat">
      <div className="chat-header"><span className="chat-avatar"><MessageCircle size={20} /></span><div><h2>一起找方向</h2><p>{ready ? '已有可执行方向，随时进入下一步；也可继续问具体问题。' : '先回答你的问题，再收敛到可以行动的方向。'}</p></div><button className="button quiet" disabled={disabled || !exploration?.messages.length} onClick={() => setConfirmClear(true)}><Trash2 size={15} />清空聊天</button></div>
      {confirmClear && <div className="career-clear-confirm" role="alertdialog" aria-label="确认清空聊天"><p>清空方向聊天并重新开始？已保存的岗位、喜欢清单、事实与简历会保留。</p><button className="button secondary" disabled={disabled} onClick={() => setConfirmClear(false)}>取消</button><button className="button primary" disabled={disabled} onClick={() => void clear()}>确认清空聊天</button></div>}
      <div className="career-chat-messages" aria-live="polite">
        {!exploration?.messages.length && <div className="career-welcome"><span className="message-avatar"><Leaf size={17} /></span><p>可以先问“我的专业能做什么”，或上传简历、岗位文件和截图。比较几个方向后，我们就进入公司与岗位筛选。</p></div>}
        {exploration?.messages.map((item,index) => <div className={`chat-message ${item.role}`} key={index}><span className="message-avatar">{item.role === 'assistant' ? <Leaf size={16} /> : '我'}</span><div><small>{item.role === 'assistant' ? '职航 · 方向顾问' : '我的想法'}</small><p>{item.content}</p>
          {!!item.attachments?.length && <div className="sent-attachments">{item.attachments.map(attachment => <span key={attachment.id}>{attachment.kind === 'image' ? '图片' : '文件'} · {attachment.name}</span>)}</div>}
          {!!item.sources?.length && <details className="career-sources"><summary><Globe size={14} />本轮联网来源 · {item.sources.length}</summary>{item.sources.map(source => <article key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><small>{source.readMethod === 'page' ? '已读取网页正文' : '搜索摘要'} · 获取于 {new Date(source.fetchedAt).toLocaleString('zh-CN')}{source.publishedAt ? ` · 发布 ${source.publishedAt}` : ''}</small><p>{source.excerpt}</p></article>)}</details>}
          {item.searchWarning && <p className="career-search-warning">{item.searchWarning}</p>}
        </div></div>)}
        {busy === 'career_chat' && <div className="chat-thinking"><LoaderCircle size={14} className="spin" />正在分析；涉及公司信息时会核对公开来源…</div>}<div ref={messagesEnd} />
      </div>
      {!exploration?.messages.length && <div className="starter-prompts">{['我的专业能干什么', '我想了解字节跳动目前的业务和招聘入口', '我更看重成长，也愿意跨行业'].map(prompt => <button key={prompt} disabled={disabled} onClick={() => void send(prompt)}>{prompt}</button>)}</div>}
      <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(message); }}>
        <textarea aria-label="方向探索消息" maxLength={4000} value={message} disabled={disabled} onChange={event => setMessage(event.target.value)} placeholder={ready ? '继续问具体问题，或点击下方按钮开始找岗位' : '说说你想了解什么，也可以附上文件或图片'} />
        <ClearInputControl value={message} onChange={setMessage} label="方向探索消息" disabled={disabled} resetKey={state.revision} />
        <CareerAttachmentInput value={attachments} onChange={setAttachments} disabled={!!busy || blocked} onBusy={setUploading} />
        <div><span>PDF / DOCX / TXT / 图片 · 单个最大 8 MB</span><button className="button primary" type="submit" disabled={disabled || (!message.trim() && !attachments.length)}><Send size={15} />发送想法</button></div>
      </form>
      {!!exploration?.directions.length && <div className={`career-next ${ready ? 'ready' : ''}`}><div><strong>{ready ? '方向方案已就绪' : '已经有候选方向，可以开始选择'}</strong><p>{exploration.decisionSummary || '不必回答完所有问题。选定想了解的方向后，就能查找公司与岗位。'}</p></div><button className="button primary" disabled={disabled || exploration.profileStale} onClick={() => void finish()}>{ready ? '下一步：选择方向' : '结束探索，进入下一步'}<ArrowRight size={15} /></button></div>}
    </section>
    {!!exploration?.directions.length && <section className="card directions-section" ref={directionsSection}><div className="card-heading"><span className="section-number">02</span><div><h2>选择想进一步了解的方向</h2><p>最多选择 4 个行业与岗位组合。</p></div></div>{exploration.profileStale && <p className="inline-error">个人经历已更新，请继续对话，让方向建议参考最新资料。</p>}
      <div className="direction-grid">{exploration.directions.map(direction => <label className={`direction-card ${directions.includes(direction.id) ? 'selected' : ''}`} key={direction.id}><div className="selection-title"><input type="checkbox" aria-label={`选择方向：${direction.industry} · ${direction.role}`} checked={directions.includes(direction.id)} disabled={disabled || (!directions.includes(direction.id) && directions.length >= 4)} onChange={() => setDirections(toggle(direction.id, directions))} /><span><small>行业</small><strong>{direction.industry}</strong></span></div><div className="role-label"><span>岗位方向</span><strong>{direction.role}</strong></div><p>{direction.rationale}</p><dl><div><dt>可迁移能力</dt><dd>{direction.transferableSkills.join('、') || '待结合经历补充'}</dd></div><div><dt>还需准备</dt><dd>{direction.gaps.join('、') || '继续核对具体 JD'}</dd></div><div><dt>进入条件</dt><dd>{direction.entryRequirements}</dd></div><div><dt>薪资考量</dt><dd>{direction.salaryContext}</dd></div></dl></label>)}</div>
      <div className="form-footer"><span>已选择 {directions.length} 个方向{directionsDirty ? ' · 尚未保存' : ''}</span><div className="inline-buttons"><button className="button secondary" disabled={disabled || !directions.length || !directionsDirty} onClick={() => void act({ type: 'select_directions', directionIds: directions }, '方向已确认，可以发现公司与岗位。')}><Check size={15} />确认所选方向</button><button className="button primary" disabled={disabled || !directions.length || exploration.profileStale} onClick={() => void discover()}>{busy === 'recommend_companies' ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}发现公司与岗位</button></div></div>
    </section>}
    {(!!exploration?.companies.length || !!exploration?.jobSearch) && <JobDiscovery state={state} busy={busy} blocked={blocked || directionsDirty} act={act} onEditCapture={onEditCapture} />}
  </div>;
}
