import type { ResumeVersion } from '../shared/types';
import { toResumeDocument } from '../shared/resume-template';
import { DesignParameters, designNames } from './ResumeDesignPanel';

export default function ResumeDesignStatus({ resume, dirty }: { resume: ResumeVersion; dirty: boolean }) {
  const document = toResumeDocument(resume), quality = resume.quality;
  const label = !quality || quality.status === 'not_checked' ? '尚未检查 PDF' : quality.status === 'passed' ? 'PDF 排版检查通过' : quality.status === 'failed' ? 'PDF 检查未通过' : 'PDF 排版需留意';
  const color = quality?.status === 'passed' && !dirty ? 'green' : quality?.status === 'warning' || quality?.status === 'failed' ? 'amber' : 'neutral';
  return <section className="resume-design-status" aria-label="本版设计与排版检查">
    <div className="design-preview-heading"><div><h3>基础设计：{resume.designSkill?.name || '内置样式 / 手动排版'}</h3><p>V{resume.version} 的固定快照，规则库的后续修改不会改变它。实际排版以下方参数为准。</p></div><span className={`tag ${color}`}>{dirty ? '草稿尚未检查' : label}</span></div>
    {quality?.pageCount !== undefined && <p className="design-page-count">已保存 PDF：<strong>{quality.pageCount} 页</strong>{dirty ? ' · 当前修改尚未重新检查' : ''}</p>}
    {quality?.warnings?.length ? <ul className="design-quality-warnings">{quality.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : (!quality || quality.status === 'not_checked') && <p className="subtle-text">保存版本后以实际 PDF 检查结果为准，网页预览不代表页数已达标。</p>}
    <details className="design-parameter-details"><summary>查看本版实际参数与检查记录</summary>{document.design ? <DesignParameters design={document.design} theme={document.theme} accent={document.accent} /> : <p className="subtle-text">{designNames[document.theme]} · {designNames[document.accent]} · 历史内置模板；未记录受控排版参数。</p>}{quality && <><p className="subtle-text">检查时间：{Number.isFinite(Date.parse(quality.checkedAt)) ? new Date(quality.checkedAt).toLocaleString('zh-CN') : '未记录'}{quality.textComplete === undefined ? '' : ` · 正文完整：${quality.textComplete ? '是' : '否'}`}{quality.overflow === undefined ? '' : ` · 内容溢出：${quality.overflow ? '是' : '否'}`}</p>{quality.adjustments?.length ? <ul className="design-quality-adjustments">{quality.adjustments.map((text, index) => <li key={index}>{text}</li>)}</ul> : null}</>}</details>
  </section>;
}
