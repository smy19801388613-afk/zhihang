import { useState } from 'react';
import { resumeLabel } from '../shared/resume-scope';
import { GitCompareArrows, Quote } from 'lucide-react';
import type { Profile, ResumeVersion } from '../shared/types';
import { toResumeDocument } from '../shared/resume-template';
import { diffResumeDocuments, type ResumeDiffChange } from '../shared/resume-diff';

const profileLabels: Partial<Record<keyof Profile, string>> = { name: '姓名', email: '邮箱', phone: '手机号', school: '学校', education: '学历', major: '专业', graduation: '毕业时间', city: '城市', availability: '到岗时间' };
const values: Record<string, string> = { modern: '简约现代', classic: '经典专业', forest: '森林绿', navy: '海军蓝', plum: '梅紫', ink: '黑白' };
const changeLabels = { added: '新增', removed: '删除', changed: '修改', reordered: '调整顺序' };
const when = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未记录';

export default function ResumeEvidence({ resume, draft, resumes, dirty }: { resume: ResumeVersion; draft: ResumeVersion; resumes: ResumeVersion[]; dirty: boolean }) {
  const [comparisonId, setComparisonId] = useState(resume.parentId || '');
  const baseline = dirty ? resume : resumes.find(item => item.id === comparisonId);
  const current = dirty ? draft : resume;
  const document = toResumeDocument(current);
  const changes: ResumeDiffChange[] = baseline ? diffResumeDocuments(toResumeDocument(baseline), document) : [];
  if (baseline) for (const [field, label] of Object.entries(profileLabels)) {
    const before = String(baseline.profile[field as keyof Profile] || '');
    const after = String(current.profile[field as keyof Profile] || '');
    if (before !== after) changes.push({ field: `profile.${field}`, label: `个人资料 · ${label}`, before, after, type: !before ? 'added' : !after ? 'removed' : 'changed' });
  }
  function display(value: string, change: ResumeDiffChange, version: ResumeVersion) {
    if (!value) return '（空）';
    if (change.field === 'theme' || change.field === 'accent') return values[value] || value;
    const doc = toResumeDocument(version);
    if (change.type === 'reordered') {
      const names = new Map([...doc.sections.map(section => [section.id, section.title] as const), ...doc.sections.flatMap(section => section.items.map((item, index) => [item.id, item.title || `内容 ${index + 1}`] as const))]);
      return value.split(' → ').map(id => names.get(id) || '历史内容').join(' → ');
    }
    if (change.field.endsWith('.factIds')) return value.split('、').map(id => version.profile.facts.find(fact => fact.id === id)?.text || '历史依据已不可用').join('\n');
    return value;
  }
  return <div className="resume-evidence">
    <section className="card resume-diff-panel" data-testid="resume-diff"><div className="card-heading"><GitCompareArrows size={19} /><div><h2>{dirty ? '保存前，核对这次修改' : '实际修改前后对照'}</h2><p>{dirty ? `已保存 V${resume.version} → 当前草稿` : `V${resume.version} · ${when(resume.createdAt)} · ${resume.authoredBy === 'user' ? '网页编辑' : 'Agent 生成 / 修改'}`}</p></div></div>
      {!dirty && <label className="field diff-baseline"><span>比较基准</span><select aria-label="简历比较基准" value={comparisonId} onChange={event => setComparisonId(event.target.value)}><option value="">不比较{resume.parentId ? '' : ' · 初次生成'}</option>{[...resumes].reverse().filter(item => item.id !== resume.id).map(item => <option key={item.id} value={item.id}>V{item.version} · {resumeLabel(item)}{item.id === resume.parentId ? ' · 修改前版本' : ''}</option>)}</select></label>}
      {baseline ? changes.length ? <><p className="diff-count">实际发生 {changes.length} 处修改 · 以保存内容为准</p><div className="resume-changes">{changes.map(change => <article className="resume-change" key={change.field}><h3><span className="tag neutral">{changeLabels[change.type]}</span>{change.label}</h3><div className="diff-columns"><div><strong>修改前 · V{baseline.version}</strong><pre>{display(change.before, change, baseline)}</pre></div><div><strong>{dirty ? '修改后 · 未保存' : `修改后 · V${resume.version}`}</strong><pre>{display(change.after, change, current)}</pre></div></div></article>)}</div></> : <p className="evidence-empty">内容与样式没有变化。</p> : <p className="evidence-empty">{resume.parentId && comparisonId ? '比较基准未保留，可选择其他版本核对。' : '这是完整的已保存内容。后续修改会保留原版本，并显示实际变化。'}</p>}
    </section>
    <details className="card resume-fact-evidence" data-testid="resume-evidence"><summary><Quote size={17} /><span>核对简历的原文依据</span><small>{document.sections.reduce((total, section) => total + section.items.length, 0)} 条内容</small></summary><p>每条经历都可以追溯到本版本保存的资料。手动新增或改写内容，请核对引用是否仍然准确。</p>{document.sections.map(section => <section key={section.id}><h3>{section.title}</h3>{section.items.map((item, index) => <article key={item.id}><strong>{item.title || `内容 ${index + 1}`}</strong><p className="evidence-resume-content">{item.content}</p>{item.factIds.length ? item.factIds.map(id => { const fact = resume.profile.facts.find(value => value.id === id); return fact ? <div className="evidence-entry" key={id}><span className={`tag ${fact.confirmed ? 'green' : 'amber'}`}>{fact.confirmed ? '已确认经历' : '尚未确认'}</span><blockquote>{fact.text}</blockquote>{fact.source && <details><summary>查看来源原文</summary><p>{fact.source}</p></details>}</div> : <p key={id} className="evidence-empty">该条引用已无法找到，请先核对内容。</p>; }) : <p className="evidence-empty">本条未关联原始经历，请结合个人资料和原简历核对。</p>}</article>)}</section>)}</details>
  </div>;
}
