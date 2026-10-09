import { useEffect, useRef, useState } from 'react';
import { FileUp, Palette, Sparkles } from 'lucide-react';
import type { Action, ResumeVersion, WorkspaceState } from '../shared/types';
import { DESIGN_PRESETS, type ResumeDesignPreset, type ResumeDesignSkill, type ResumeDesignSpec } from '../shared/resume-design';
import ClearInputControl from './ClearInputControl';
import { resumeLabel } from '../shared/resume-scope';
import InlineRemovalConfirm from './InlineRemovalConfirm';

type Draft = { name: string; instructions: string; preset: ResumeDesignPreset };
const blankDraft = (): Draft => ({ name: DESIGN_PRESETS.clean.name, instructions: '', preset: 'clean' });
const fromSkill = (skill?: ResumeDesignSkill | null): Draft => skill ? { name: skill.name, instructions: skill.instructions, preset: skill.preset } : blankDraft();
const key = (draft: Draft) => JSON.stringify(draft);
export const designNames = { modern: '简约现代', classic: '经典正式', forest: '森林绿', navy: '海军蓝', plum: '梅紫', ink: '黑白' };

export function DesignParameters({ design, theme, accent }: { design: ResumeDesignSpec; theme: 'modern' | 'classic'; accent: keyof Pick<typeof designNames, 'forest' | 'navy' | 'plum' | 'ink'> }) {
  const fields = [['版式 / 配色', `${designNames[theme]} · ${designNames[accent]}`], ['字体 / 字号', `${design.fontFamily === 'sans' ? '无衬线' : '衬线'} · ${design.bodyFontPt} pt`], ['行距 / 页边距', `${design.lineHeight} 倍 · ${design.marginMm} mm`], ['栏目 / 条目间距', `${design.sectionGapPx} / ${design.itemGapPx} px`], ['教育背景', design.educationPosition === 'first' ? '放在最前' : '放在最后'], ['目标页数', design.pageGoal === 'auto' ? '按内容自动排版' : `优先 ${design.pageGoal} 页，保留全部内容`]];
  return <dl className="design-parameters">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div><dt>栏目标题</dt><dd>{design.headingStyle === 'line' ? '带分隔线' : '简洁标题'}</dd></div></dl>;
}

export default function ResumeDesignPanel({ state, resume, busy, blocked, onDirty, act }: {
  state: WorkspaceState; resume?: ResumeVersion; busy: boolean; blocked: boolean; onDirty: (dirty: boolean) => void;
  act: (action: Action, message?: string) => Promise<WorkspaceState | null>;
}) {
  const library = state.resumeDesign, current = library?.skills.find(skill => skill.id === library.currentSkillId);
  const sourceKey = current ? `${current.id}:${current.version}` : '';
  const [draft, setDraft] = useState<Draft>(() => fromSkill(library?.preview || current));
  const [baseline, setBaseline] = useState<Draft>(() => fromSkill(current));
  const [selectedId, setSelectedId] = useState(library?.currentSkillId || '');
  const [expanded, setExpanded] = useState(!state.resumes.length);
  const [fileError, setFileError] = useState('');
  const [reading, setReading] = useState(false);
  const [replacePending, setReplacePending] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const fileRead = useRef(0), previousSource = useRef(sourceKey);
  const dirty = key(draft) !== key(baseline);
  const disabled = busy || blocked || reading;
  const preview = library?.preview;
  const matchingPreview = !!preview && key(fromSkill(preview)) === key({ ...draft, name: draft.name.trim(), instructions: draft.instructions.trim() });
  useEffect(() => { onDirty(dirty || reading); }, [dirty, reading, onDirty]);
  useEffect(() => {
    if (previousSource.current === sourceKey) return;
    previousSource.current = sourceKey;
    if (!dirty) { const next = fromSkill(current); setDraft(next); setBaseline(next); setSelectedId(current?.id || ''); }
  }, [sourceKey, current, dirty]);

  function adopt(next: WorkspaceState) {
    const chosen = next.resumeDesign?.skills.find(skill => skill.id === next.resumeDesign?.currentSkillId);
    const value = fromSkill(chosen); setDraft(value); setBaseline(value); setSelectedId(chosen?.id || '');
    previousSource.current = chosen ? `${chosen.id}:${chosen.version}` : ''; setReplacePending(false); setFileError('');
  }
  async function select() {
    const next = await act({ type: 'select_resume_design', skillId: selectedId || null }, '已选择设计。新生成的简历将使用它，已有版本保持原样。');
    if (next) adopt(next);
  }
  async function readFile(file?: File) {
    if (!file || disabled) return;
    const sequence = ++fileRead.current; setFileError('');
    if (!/\.(?:md|txt)$/i.test(file.name)) { setFileError('请选择 .md、SKILL.md 或 .txt 纯文本文件。'); return; }
    if (file.size > 48 * 1024) { setFileError('文件过大。设计规范最多 12,000 字符，文件需小于 48 KiB。'); return; }
    if (file.type && !/^text\//i.test(file.type) && file.type !== 'application/octet-stream') { setFileError('该文件不是纯文本，请导出为 UTF-8 的 .md 或 .txt 文件。'); return; }
    setReading(true);
    try {
      const text = await file.text();
      if (sequence !== fileRead.current) return;
      if (text.length > 12000) throw new Error('设计规范超过 12,000 字符，请精简后重新导入。');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)) throw new Error('文件含二进制或无法识别的字符，请另存为 UTF-8 纯文本。');
      const name = /^skill\.md$/i.test(file.name) ? '导入的设计规则' : file.name.replace(/\.(?:md|txt)$/i, '').slice(0, 80);
      setDraft(value => ({ ...value, name: name || '导入的设计规则', instructions: text }));
    } catch (error) { setFileError(error instanceof Error ? error.message : '文件读取失败，请重新选择。'); }
    finally { if (sequence === fileRead.current) setReading(false); }
  }
  const deleting = library?.skills.find(skill => skill.id === deleteId);
  return <details className="card resume-design-panel" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} data-testid="resume-design-panel">
    <summary><Palette size={19} /><span><strong>简历设计 Skills</strong><small>当前：{current?.name || '内置默认样式'}</small></span><span className="tag neutral">排版与风格</span></summary>
    <p className="design-intro">选择版式，或写下设计要求。预览并保存后用于新简历；已有简历可另存一个新版本。</p>
    <div className="design-presets" role="group" aria-label="设计预设">{(Object.entries(DESIGN_PRESETS) as [ResumeDesignPreset, typeof DESIGN_PRESETS.clean][]).map(([preset, value]) => <button type="button" key={preset} disabled={disabled} aria-pressed={draft.preset === preset} onClick={() => setDraft(previous => ({ ...previous, preset, name: previous.name === DESIGN_PRESETS[previous.preset].name ? value.name : previous.name }))}><span className={`design-preset-icon ${preset}`} aria-hidden="true"><i /><i /><i /><i /></span><strong>{value.name}</strong><small>{value.description}</small></button>)}</div>
    <div className="design-editor"><label className="field"><span>设计名称</span><input aria-label="设计名称" value={draft.name} maxLength={80} disabled={disabled} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} /></label><label className="field"><span>设计要求</span><textarea aria-label="设计要求" value={draft.instructions} maxLength={12000} rows={5} disabled={disabled} onChange={event => setDraft(value => ({ ...value, instructions: event.target.value }))} placeholder="例如：采用黑白配色，教育背景放在最后，正文 11 pt，尽量一页。不要删减经历。" /></label>
      <ClearInputControl value={draft.instructions} onChange={instructions => setDraft(value => ({ ...value, instructions }))} label="设计要求" disabled={disabled} resetKey={`${sourceKey}:${baseline.instructions}`} />
      <div className="design-file-row"><label className={`button secondary design-file-input ${disabled ? 'is-disabled' : ''}`}><FileUp size={15} />{reading ? '正在读取…' : '读取设计文件'}<input type="file" aria-label="读取设计文件" accept=".md,.txt,text/plain,text/markdown" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void readFile(file); }} /></label><span>.md / SKILL.md / .txt · 最多 12,000 字符，仅读取文字</span></div>
      {fileError && <p className="inline-error" role="alert">{fileError}</p>}
      <div className="inline-buttons design-editor-actions"><button type="button" className="button primary" disabled={disabled || !draft.name.trim()} onClick={() => void act({ type: 'preview_resume_design', ...draft, name: draft.name.trim(), instructions: draft.instructions.trim() }, '设计预览已整理，请核对支持范围后保存。')}><Sparkles size={15} />预览设计规则</button>{dirty && <button type="button" className="button quiet" disabled={disabled} onClick={() => { const value = fromSkill(current); setDraft(value); setBaseline(value); setFileError(''); }}>放弃设计草稿</button>}</div>
    </div>
    {preview && <section className="design-rule-preview" aria-label="设计规则预览"><div className="design-preview-heading"><h3>{preview.name}</h3><span className="tag neutral">{preview.mode === 'live' ? '模型整理' : '规则演示'}</span></div>{!matchingPreview && <p className="inline-error">这份预览与当前输入不同。请重新预览后再保存。</p>}<div className="design-supported"><div><h4>已识别并采用</h4><ul>{preview.recognized.map((text, index) => <li key={index}>{text}</li>)}</ul></div><div><h4>未支持 / 需要留意</h4>{preview.unsupported.length ? <ul>{preview.unsupported.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>未发现未支持的要求。仍需核对参数与导出结果。</p>}</div></div><details className="design-parameter-details"><summary>查看实际排版参数</summary><DesignParameters design={preview.design} theme={preview.theme} accent={preview.accent} /></details><div className="inline-buttons"><button type="button" className="button primary" disabled={disabled || !matchingPreview} onClick={async () => { const next = await act({ type: 'save_resume_design', setDefault: false }, '设计已保存并用于本岗位，已有简历保持原样。'); if (next) adopt(next); }}>保存用于本岗位</button><button type="button" className="button secondary" disabled={disabled || !matchingPreview} onClick={async () => { const next = await act({ type: 'save_resume_design', setDefault: true }, '设计已保存为默认，今后切换岗位也会使用。'); if (next) adopt(next); }}>保存并设为默认</button></div></section>}
    <section className="design-library"><div className="design-preview-heading"><h3>已保存的设计</h3><span>默认：{library?.skills.find(skill => skill.id === library.defaultSkillId)?.name || '内置默认样式'}</span></div><label className="field"><span>设计规则库</span><select aria-label="设计规则库" value={selectedId} disabled={disabled} onChange={event => setSelectedId(event.target.value)}><option value="">内置默认样式</option>{library?.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}{skill.id === library.defaultSkillId ? ' · 默认' : ''}</option>)}</select></label><div className="inline-buttons"><button type="button" className="button secondary" disabled={disabled} onClick={() => dirty ? setReplacePending(true) : void select()}>使用所选设计</button><button type="button" className="button quiet" disabled={disabled || dirty || (library?.defaultSkillId || '') === selectedId} onClick={async () => { const next = await act({ type: 'select_resume_design', skillId: selectedId || null, setDefault: true }, '默认设计已更新。'); if (next) adopt(next); }}>设为默认设计</button><button type="button" className="button quiet danger-text" disabled={disabled || !selectedId} onClick={() => setDeleteId(selectedId)}>删除所选设计</button></div>
      {replacePending && <InlineRemovalConfirm title="替换未保存的设计草稿？" confirmLabel="放弃草稿并选择" busy={busy} disabled={blocked || reading} onCancel={() => setReplacePending(false)} onConfirm={() => void select()}><p>当前设计输入尚未保存。选择规则库中的设计后，会替换这些输入；已保存简历不受影响。</p></InlineRemovalConfirm>}
      {deleting && <InlineRemovalConfirm title="删除这份设计规则？" confirmLabel="确认删除设计" busy={busy} disabled={blocked || reading} onCancel={() => setDeleteId('')} onConfirm={async () => { const next = await act({ type: 'delete_resume_design', skillId: deleting.id }, '设计规则已删除，历史简历中的设计快照继续保留。'); if (next) { if (!dirty) adopt(next); else setSelectedId(next.resumeDesign?.currentSkillId || ''); setDeleteId(''); } }}><p>从规则库删除“{deleting.name}”。历史简历和其中保存的设计快照继续保留。</p></InlineRemovalConfirm>}
    </section>
    {resume && <div className="design-apply"><p>将“{current?.name || '内置默认样式'}”应用于 V{resume.version} · {resumeLabel(resume)}，保留正文并生成新版本。</p><button type="button" className="button primary" disabled={disabled || dirty || !current || !!resume.stale} onClick={() => void act({ type: 'apply_resume_design', resumeId: resume.id }, '已保留正文并生成新的设计版本，请核对排版与内容后重新审核。')}>应用设计并生成新版本</button>{resume.stale && <p className="subtle-text">历史版本只供查看，请从当前岗位的有效简历继续设计。</p>}</div>}
  </details>;
}
