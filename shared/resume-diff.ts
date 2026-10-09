import type { ResumeDocument } from './types.ts';

export interface ResumeDiffChange {
  field: string;
  label: string;
  before: string;
  after: string;
  type: 'added' | 'removed' | 'changed' | 'reordered';
}

/** Compare saved values, never an assistant's description of its own work. */
export function diffResumeDocuments(before: ResumeDocument, after: ResumeDocument): ResumeDiffChange[] {
  const changes: ResumeDiffChange[] = [];
  const add = (field: string, label: string, left: string, right: string, type?: ResumeDiffChange['type']) => {
    if (left !== right) changes.push({ field, label, before: left, after: right, type: type || (!left ? 'added' : !right ? 'removed' : 'changed') });
  };
  add('headline', '求职意向', before.headline, after.headline);
  add('summary', '个人简介', before.summary, after.summary);
  add('theme', '版式', before.theme, after.theme);
  add('accent', '配色', before.accent, after.accent);
  const leftDesign = before.design, rightDesign = after.design;
  const designLabels = { fontFamily: '字体', bodyFontPt: '正文字号 (pt)', lineHeight: '行距', marginMm: '页边距 (mm)', sectionGapPx: '栏目间距 (px)', itemGapPx: '条目间距 (px)', educationPosition: '教育背景位置', pageGoal: '目标页数', headingStyle: '栏目标题样式' };
  const designValues: Record<string, string> = { sans: '无衬线', serif: '衬线', first: '最前', last: '最后', auto: '自动', line: '带分隔线', plain: '简洁标题' };
  const designValue = (value: string | number) => designValues[String(value)] || String(value);
  for (const [field, label] of Object.entries(designLabels) as [keyof typeof designLabels, string][]) {
    add(`design.${field}`, label, leftDesign ? designValue(leftDesign[field]) : '历史模板未记录', rightDesign ? designValue(rightDesign[field]) : '历史模板未记录');
  }
  const common = (ids: string[], other: string[]) => ids.filter(id => other.includes(id));
  const oldSections = before.sections.map(s => s.id); const newSections = after.sections.map(s => s.id);
  add('sections.order', '章节顺序', common(oldSections, newSections).join(' → '), common(newSections, oldSections).join(' → '), 'reordered');
  for (const id of new Set([...oldSections, ...newSections])) {
    const left = before.sections.find(s => s.id === id); const right = after.sections.find(s => s.id === id);
    const label = right?.title || left?.title || '未命名章节';
    const sectionText = (s: typeof left) => s ? [s.title, ...s.items.flatMap(i => [i.title, i.subtitle, i.date, i.content])].filter(Boolean).join('\n') : '';
    if (!left || !right) { add(`sections.${id}`, label, sectionText(left), sectionText(right)); continue; }
    add(`sections.${id}.title`, `${label} · 章节名称`, left.title, right.title);
    const leftIds = left.items.map(i => i.id); const rightIds = right.items.map(i => i.id);
    add(`sections.${id}.order`, `${label} · 条目顺序`, common(leftIds, rightIds).join(' → '), common(rightIds, leftIds).join(' → '), 'reordered');
    for (const itemId of new Set([...leftIds, ...rightIds])) {
      const a = left.items.find(i => i.id === itemId); const b = right.items.find(i => i.id === itemId);
      const itemLabel = b?.title || a?.title || '未命名条目';
      const itemText = (i: typeof a) => i ? [i.title, i.subtitle, i.date, i.content].filter(Boolean).join('\n') : '';
      if (!a || !b) { add(`sections.${id}.${itemId}`, `${label} · ${itemLabel}`, itemText(a), itemText(b)); continue; }
      for (const [key, name] of [['title', '标题'], ['subtitle', '角色 / 单位'], ['date', '日期'], ['content', '正文']] as const) {
        add(`sections.${id}.${itemId}.${key}`, `${itemLabel} · ${name}`, a[key], b[key]);
      }
      add(`sections.${id}.${itemId}.factIds`, `${itemLabel} · 事实引用`, [...a.factIds].sort().join('、'), [...b.factIds].sort().join('、'));
    }
  }
  return changes;
}

export function summarizeResumeChanges(before: ResumeDocument, after: ResumeDocument): string {
  const changes = diffResumeDocuments(before, after);
  if (!changes.length) return '当前没有产生内容或样式变化。请指定想修改的句子、章节或样式。';
  const labels = [...new Set(changes.map(change => change.label))];
  const styleOnly = changes.every(change => change.field === 'theme' || change.field === 'accent' || change.field.startsWith('design.'));
  return `已更新：${labels.slice(0, 6).join('、')}${labels.length > 6 ? `等 ${labels.length} 处` : ''}。${styleOnly ? '正文未变化；本次仅调整样式。' : ''}请查看修改前后内容并审核后再用于申请。`;
}
