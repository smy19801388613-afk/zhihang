import type { ResumeDocument } from '../shared/types.ts';
import { semanticFactSources } from './fact-segmentation.ts';

export class ResumeScopeError extends Error {
  itemId?: string;
  constructor(public readonly code:'missing_course_identity'|'unsupported_leadership'|'unsupported_qualification',message:string){super(message);this.name='ResumeScopeError';}
}

export function chineseNumber(value: string): string {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]+$/u.test(value)) return [...value].map(c => digits[c]).join('').replace(/^0+(?=\d)/, '');
  let total = 0; let section = 0; let digit = 0;
  for (const c of value) {
    if (c in digits) digit = digits[c];
    else if (c === '万' || c === '亿') { const unit = c === '万' ? 10000 : 100000000; section = (section + digit) * unit; total += section; section = 0; digit = 0; }
    else { const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[c]; if (!unit) return value; section += (digit || 1) * unit; digit = 0; }
  }
  return String(total + section + digit);
}

interface NumericClaim { key: string; raw: string }
const cn = '[零〇一二两三四五六七八九十百千万亿]+';
const canonicalNumber = (raw: string) => {
  const [integer, decimal = ''] = raw.split('.');
  const fraction = decimal.replace(/0+$/, '');
  return `${integer.replace(/^0+(?=\d)/, '')}${fraction ? `.${fraction}` : ''}`;
};

/** Dates are atomic; month formatting and Chinese/Arabic quantities are equivalent. */
export function numericClaims(value: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  let normalized = value.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '');
  normalized = normalized.replace(/([二两][零〇一二三四五六七八九]{3})(?=年)/gu, year => chineseNumber(year))
    .replace(new RegExp(`(20\\d{2}年)(${cn})月`, 'gu'), (_raw, year, month) => `${year}${chineseNumber(month)}月`)
    .replace(new RegExp(`([至到—–~～-])(${cn})月`, 'gu'), (_raw, separator, month) => `${separator}${chineseNumber(month)}月`);
  // Expand a date range's abbreviated second month before recognizing dates.
  normalized = normalized.replace(/((20\d{2})\s*(?:年|[./-])\s*\d{1,2}月?\s*(?:至|到|—|–|~|～|-)\s*)[.]?(\d{1,2})月?(?!\d|[./])/gu, '$1$2年$3月');
  normalized = normalized.replace(/(?<!\d)(20\d{2})\s*(?:年|[./-])\s*(0?[1-9]|1[0-2])(?:月|(?=\D|$))(?:\s*(?:[./-]|月)\s*(0?[1-9]|[12]\d|3[01])日?)?(?!\d)/gu, (raw, year, month, day) => {
    claims.push({ key: `date:${year}-${Number(month)}${day ? `-${Number(day)}` : ''}`, raw }, { key: `n:${year}`, raw: year }); return ' ';
  });
  normalized = normalized.replace(new RegExp(`百分之(${cn})(?:点([零〇一二两三四五六七八九]+))?`, 'gu'), (raw, whole, fraction) => {
    claims.push({ key: `n:${chineseNumber(whole)}${fraction ? `.${[...fraction].map(c => chineseNumber(c)).join('')}` : ''}%`, raw }); return ' ';
  });
  normalized = normalized.replace(new RegExp(`(${cn})(?=\\s*(?:个?月|年|天|周|次|人|份|篇|项|个|场|页|条|维度|万元|元|倍))`, 'gu'), (raw, n) => {
    claims.push({ key: `n:${chineseNumber(n)}`, raw }); return ' ';
  });
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?%?/g)) {
    const raw = match[0]; const percent = raw.endsWith('%');
    claims.push({ key: `n:${canonicalNumber(percent ? raw.slice(0, -1) : raw)}${percent ? '%' : ''}`, raw });
  }
  return claims;
}

export function validateNumbers(source: string, output: string, label: string): void {
  const allowed = new Set(numericClaims(source).map(claim => claim.key));
  const added = numericClaims(output).filter(claim => !allowed.has(claim.key));
  if (added.length) {
    const unsupported = [...new Set(added.map(claim => claim.raw))].slice(0, 5);
    throw new Error(`${label}新增了没有依据的数字或日期（尚无依据的数字：${unsupported.map(raw => `“${raw}”`).join('、')}），已拦截。对应条目所引事实没有等值数据；请核对片段或先补充并确认真实依据。`);
  }
}

export function validateExperienceScope(source: string, output: string, label: string, options: { courseEvidence?: string } = {}): void {
  // A course list or ordinary training is not itself a course-project identity.
  // Older saved facts may straddle two experiences; first locate the evidence
  // that actually supports this output before applying that experience's scope.
  const isCourseProject=(text:string)=>/(?:课程|课堂)(?:设计|项目|论文|作业|实验|研究|报告|案例)|(?:课程|课堂)[^，。；\n]{0,8}(?:案例检索|案例研究|项目研究)/u.test(text);
  // Reviewed company work/internship identities may discuss course products.
  // Callers can narrow this guard's input without weakening denial checks below.
  const blocks=semanticFactSources(options.courseEvidence ?? source);
  const courseBlocks=blocks.filter(block=>isCourseProject([block.title,block.text].join('\n')));
  let courseApplies=courseBlocks.length>0;
  if(courseApplies&&!/课程|课堂/u.test(output)) {
    const compact=(value:string)=>value.replace(/20\d{2}(?:[年./-]\d{1,2})?|[\s\p{P}\p{S}]/gu,'');
    const out=compact(output);
    const grams=(value:string)=>new Set([...value.matchAll(/[\p{Script=Han}A-Za-z]{4,}/gu)].flatMap(match=>Array.from({length:match[0].length-3},(_,index)=>match[0].slice(index,index+4))));
    const scores=blocks.map(block=>{
      const title=[...grams(compact(block.title))].filter(token=>out.includes(token)).length;
      const body=[...grams(compact(block.text))].filter(token=>out.includes(token)&&!['资料整理','数据分析','团队协作','课程项目','课程设计','研究报告','项目研究'].includes(token)).length;
      return {block,title,body,course:isCourseProject([block.title,block.text].join('\n'))};
    });
    const bestCourse=scores.filter(score=>score.course).sort((a,b)=>(b.title*10+b.body)-(a.title*10+a.body))[0];
    const matchingOther=scores.filter(score=>!score.course&&score.title>=1&&score.body>=2).sort((a,b)=>(b.title*10+b.body)-(a.title*10+a.body))[0];
    // An exact non-course title plus its own task evidence can disambiguate a
    // neighboring course header. Meaningful course evidence keeps the guard on.
    if(matchingOther&&bestCourse?.title===0&&bestCourse.body<4)courseApplies=false;
  }
  if (courseApplies && !/课程|课堂/u.test(output)) throw new ResumeScopeError('missing_course_identity',`${label}省略了来源中的课程身份，已拦截；请保留“课程项目”等范围说明，不能包装成企业经历。`);
  const positiveClauses = output.split(/[，。；;\n]/u).filter(clause => !/(?:未|没有|不)(?:担任|是|作为|负责|带领|领导)/u.test(clause)).join('\n');
  if (/(?:未|没有)担任.{0,8}负责人|不是.{0,8}负责人|非负责人/u.test(source) && /(?:担任|作为|项目|团队).{0,4}负责人|带领团队|领导团队/u.test(positiveClauses)) throw new ResumeScopeError('unsupported_leadership',`${label}把参与经历升级为负责人，已拦截；请保留真实个人职责。`);
  if (/未通过法考|未取得法律职业资格|没有法律职业资格/u.test(source) && /(?:已通过法考|取得法律职业资格|持有法律职业资格)/u.test(output.replace(/未取得法律职业资格/gu, ''))) throw new ResumeScopeError('unsupported_qualification',`${label}新增了与档案不符的职业资格，已拦截。`);
}

/** Move standalone audit disclaimers; keep skill limitations in place. */
export function separateAuditNotes(document: ResumeDocument): { document: ResumeDocument; reviewNotes: string[] } {
  const result = structuredClone(document); const reviewNotes: string[] = [];
  const evidenceObject = '(?:考试成绩|英语考试成绩|英语成绩|语言考试成绩|成绩单|专业英语能力证明|英语能力证明|语言能力证明|能力证明材料|作品链接|作品样例|证书扫描件|资格证明材料)';
  const evidenceAudit = new RegExp(`^(?:也|尚)?(?:未提供|没有提供|尚未提供)${evidenceObject}(?:(?:或|与|及|和|、)${evidenceObject})*[。；;，,]?$`, 'u');
  const isAudit = (value: string) => {
    if (/无独立.*能力|不能|无法|不具备|尚未具备|尚未实践|学习中|正在学习/u.test(value)) return false;
    return evidenceAudit.test(value)
      || /^(?:本人|我|本项目|该项目|该经历|但|且|也)?\s*(?:(?:未|没有)(?:参与真实企业|参与企业|担任团队负责人|负责产品上线|证明业务|通过法考|取得法律职业资格)|没有(?:正式)?企业实习|无企业实习|尚无企业实习|(?:无|没有)可验证的增长|没有律师执业资格)/u.test(value);
  };
  const clean = (text: string) => { const start = reviewNotes.length; const cleaned = text.split(/(?<=[。；;，,\n])/u).map(part => {
    const value = part.trim();
    if (value && isAudit(value)) { reviewNotes.push(value); return ''; }
    return part;
  }).filter(Boolean).join('').trim(); return reviewNotes.length > start ? cleaned.replace(/[，,；;]\s*$/u, '。') : text; };
  result.summary = clean(result.summary);
  const removedItems = new Set<string>();
  for (const section of result.sections) for (const item of section.items) {
    const hadContent = !!item.content.trim();
    const content = clean(item.content);
    // An audit-only item is removed, never converted to an empty invented achievement.
    item.content = content;
    if (hadContent && !content.trim()) removedItems.add(item.id);
  }
  result.sections = result.sections.map(section => ({ ...section, items: section.items.filter(item => !removedItems.has(item.id)) })).filter(section => section.items.length);
  return { document: result, reviewNotes: [...new Set(reviewNotes)] };
}
