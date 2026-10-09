import { useEffect, useState } from 'react';
import { FilePlus2, Sparkles } from 'lucide-react';
import type { Action, WorkspaceState } from '../shared/types';
import ClearInputControl from './ClearInputControl';
import ResumeTargetPicker, { selectedTargets } from './ResumeTargetPicker';

export default function ResumePurposePanel({ state, busy, blocked, onDirty, onSingle, act }: {
  state: WorkspaceState; busy: boolean; blocked: boolean; onDirty: (value: boolean) => void; onSingle: () => void;
  act: (action: Action, message?: string) => Promise<WorkspaceState | null>;
}) {
  const [mode, setMode] = useState<'single' | 'general' | 'multi'>('single');
  const [name, setName] = useState(''), [focus, setFocus] = useState('');
  const [ids, setIds] = useState<string[]>([]), [includeCurrent, setIncludeCurrent] = useState(false);
  const [open, setOpen] = useState(!state.resumes.length);
  const dirty = mode !== 'single' || !!name || !!focus || !!ids.length || includeCurrent;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const disabled = busy || blocked;
  const selected = selectedTargets(state, ids, includeCurrent, true);
  const totalChars = selected.targets.reduce((total, job) => total + job.text.length, 0);
  const invalid = mode === 'multi' && (!!selected.error || selected.targets.length < 2 || selected.targets.length > 8 || totalChars > 48000);
  const confirmed = state.profile.facts.filter(fact => fact.confirmed).length;
  function reset() { setMode('single'); setName(''); setFocus(''); setIds([]); setIncludeCurrent(false); }
  async function generate() {
    if (disabled || !confirmed || mode === 'single' || invalid) return;
    const title = name.trim() || (mode === 'general' ? '我的通用简历' : '多岗位共用简历');
    const action: Action = mode === 'general' ? { type: 'generate_general_resume', name: title, focus: focus.trim() } : { type: 'generate_multi_resume', name: title, focus: focus.trim(), candidateIds: ids, includeCurrentJob: includeCurrent };
    if (await act(action, '简历已生成并保留独立版本。请先审核，再选择一个或多个投递岗位。')) { reset(); setOpen(false); }
  }
  return <details className="card resume-purpose-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-testid="resume-purpose-panel"><summary><FilePlus2 size={19} /><span><strong>简历用途</strong><small>专岗定制、通用简历，或一份覆盖多个岗位</small></span></summary>
    <div className="resume-purpose-options" role="group" aria-label="选择简历用途">{[['single', '专岗简历', '围绕当前岗位的 JD 定制'], ['general', '通用简历', '基于已确认经历，不需要先选岗位'], ['multi', '一份多岗', '比较 2–8 个岗位，提炼共用重点']].map(([value, title, description]) => <button type="button" key={value} aria-pressed={mode === value} disabled={disabled} onClick={() => setMode(value as typeof mode)}><strong>{title}</strong><span>{description}</span></button>)}</div>
    {mode === 'single' ? <p className="purpose-single-hint">继续使用当前岗位准备区生成专岗简历。已审核的专岗简历也能在“选择投递岗位”中复用于多个岗位。<button type="button" className="button quiet" disabled={disabled || dirty} onClick={onSingle}>打开当前岗位准备</button></p> : <>
      <div className="form-grid"><label className="field"><span>简历名称</span><input aria-label="新简历名称" value={name} maxLength={80} disabled={disabled} onChange={event => setName(event.target.value)} placeholder={mode === 'general' ? '如：法务与合规通用简历' : '如：内容与运营共用简历'} /></label><div className="purpose-confirmed">已确认 {confirmed} 条经历<br />使用当前保存的设计规则</div></div>
      <label className="field"><span>希望突出什么（选填）</span><textarea aria-label="简历用途说明" value={focus} maxLength={2000} rows={3} disabled={disabled} onChange={event => setFocus(event.target.value)} placeholder="写下求职方向、想强调的能力或使用场景；经历内容仍以已确认事实为准。" /></label><ClearInputControl value={focus} onChange={setFocus} label="简历用途说明" disabled={disabled} />
      {mode === 'multi' && <><ResumeTargetPicker state={state} ids={ids} includeCurrent={includeCurrent} onChange={(next, current) => { setIds(next); setIncludeCurrent(current); }} disabled={disabled} max={8} requireComplete label="多岗简历目标" />{selected.error && <p className="inline-error">{selected.error}</p>}<p className={totalChars > 48000 ? 'inline-error' : 'subtle-text'}>有效岗位 {selected.targets.length} 个 · JD 合计 {totalChars.toLocaleString()} / 48,000 字符</p></>}
      <div className="form-footer"><span>{!confirmed ? '先在“我的经历”确认事实，再生成简历。' : mode === 'general' ? '通用版本不会假设你匹配某个尚未选择的岗位。' : '共用简历不等于满足所有岗位要求，请逐岗核对。'}</span><button type="button" className="button primary" disabled={disabled || !confirmed || invalid} onClick={() => void generate()}><Sparkles size={16} />{mode === 'general' ? '生成通用简历' : '生成多岗位简历'}</button></div>
    </>}{dirty && <button type="button" className="button quiet" disabled={disabled} onClick={reset}>放弃用途草稿</button>}
  </details>;
}
