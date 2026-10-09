import { useState } from 'react';
import { FileUp, FileText, Check, LoaderCircle, X } from 'lucide-react';
import type { Action, Profile, ResumeImport, WorkspaceState } from '../shared/types';

type Draft = Omit<Profile, 'facts'>;
type Props = { imported?: ResumeImport | null; busy: boolean; upload: (file: File) => Promise<void>; act: (action: Action, message?: string) => Promise<WorkspaceState | null> };
export default function ResumeImportPanel({ imported, busy, upload, act }: Props) {
  const [draft, setDraft] = useState<Draft | null>(imported?.proposedProfile || null);
  const [localError, setLocalError] = useState('');
  function choose(file?: File) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setLocalError('文件超过 8 MB，请压缩后重试。'); return; }
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) { setLocalError('请上传 PDF、DOCX 或 TXT 文件。'); return; }
    setLocalError(''); void upload(file);
  }
  const limits: Partial<Record<keyof Draft, number>> = { name: 80, email: 160, phone: 40, school: 160, graduation: 80, city: 100, availability: 120 };
  const fields: [keyof Draft, string][] = [['name', '姓名'], ['email', '邮箱'], ['phone', '手机号'], ['school', '学校'], ['major', '专业'], ['graduation', '毕业时间'], ['city', '意向城市'], ['availability', '到岗时间 / 实习时长'], ['targetRole', '已有意向岗位（可留空）']];
  return <section className="card resume-import-card">
    <div className="card-heading"><span className="section-number"><FileUp size={18} /></span><div><h2>导入已有简历</h2><p>自动整理资料和经历，由你确认后保存。</p></div></div>
    {!imported ? <label className={`upload-zone ${busy ? 'disabled' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) choose(event.dataTransfer.files[0]); }}>
      <span className="upload-symbol">{busy ? <LoaderCircle className="spin" size={27} /> : <FileUp size={27} />}</span><strong>上传或拖入简历</strong><span>PDF / DOCX / TXT · 最大 8 MB</span><small>扫描件请先转为文字，上传后先预览再确认。</small><input aria-label="上传基础简历" type="file" accept=".pdf,.docx,.txt" disabled={busy} onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
    </label> : draft && <div className="import-preview">
      <div className="import-file"><FileText size={19} /><div><strong>{imported.filename}</strong><p>请核对识别结果，缺失信息可补充或留空。</p></div><span className="tag amber">等待你核对</span></div>
      {imported.warnings.length > 0 && <div className="import-warnings">{imported.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      <div className="form-grid">{fields.map(([key, label]) => <label className="field" key={key}><span>{label}</span><input maxLength={limits[key] || 200} value={draft[key] || ''} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}<label className="field"><span>最高学历</span><select value={draft.education} onChange={event => setDraft({ ...draft, education: event.target.value })}><option value="">未识别 / 暂不填写</option>{['本科', '硕士', '博士', '专科', '其他'].map(value => <option key={value}>{value}</option>)}</select></label></div>
      <label className="field import-experience"><span>从简历整理出的经历</span><textarea maxLength={30000} value={draft.experienceText} onChange={event => setDraft({ ...draft, experienceText: event.target.value })} /></label>
      <details className="source-details"><summary>查看提取的原文</summary><pre>{imported.text}</pre></details>
      <div className="form-footer"><span>确认导入后，经历仍需逐条确认属实。</span><div className="inline-buttons"><button className="button quiet" disabled={busy} onClick={() => void act({ type: 'discard_resume_import' }, '已取消本次导入，现有资料保持不变。')}><X size={15} />取消导入</button><button className="button primary" disabled={busy || !draft.experienceText.trim()} onClick={() => void act({ type: 'accept_resume_import', profile: draft }, '已自动建立个人资料与经历。请在下方确认事实。')}><Check size={16} />确认导入并梳理经历</button></div></div>
    </div>}
    {localError && <p className="inline-error" role="alert">{localError}</p>}
  </section>;
}
