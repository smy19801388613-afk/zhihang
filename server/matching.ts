import type { Fact, Job, JobAnalysis, MatchItem, Profile } from '../shared/types.ts';
import { z } from 'zod';
import { chineseNumber } from './resume-grounding.ts';

export interface RequirementCandidate { id: string; text: string; category: NonNullable<MatchItem['category']>; sourceQuotes?: string[] }
export interface MatchReply { requirementId: string; factIds: string[]; status: MatchItem['status']; profileFields?: string[] }
type Category = RequirementCandidate['category'];
export interface RequirementSource { id: string; text: string; categoryHint: Category; hardGate: boolean }
export interface CuratedRequirements {
  requirements: RequirementCandidate[];
  metadata: NonNullable<JobAnalysis['metadata']>;
  curation: NonNullable<JobAnalysis['curation']>;
}
const categories = ['required', 'capability', 'preferred', 'responsibility'] as const;
export const requirementCurationSchema = z.object({
  requirements: z.array(z.object({
    category: z.enum(categories),
    sources: z.array(z.object({ sourceId: z.string().min(1).max(40), quote: z.string().min(1).max(16000) }).strict()).min(1).max(80),
  }).strict()).max(80),
}).strict();
export type RequirementCurationReply = z.infer<typeof requirementCurationSchema>;

type Section = Category | 'context' | 'unknown';
const labels: Record<string, Section> = {
  岗位职责: 'responsibility', 工作职责: 'responsibility', 职责: 'responsibility', 工作内容: 'responsibility', 职位描述: 'responsibility',
  必要条件: 'capability', 任职要求: 'capability', 任职资格: 'capability', 岗位要求: 'capability', 基本要求: 'capability', 职位要求: 'capability', 招聘要求: 'capability', 我们希望你: 'capability',
  加分项: 'preferred', 优先条件: 'preferred', 加分条件: 'preferred',
  福利待遇: 'context', 薪酬福利: 'context', 薪资福利: 'context', 薪资待遇: 'context', 薪酬体系: 'context', 福利: 'context', 我们提供: 'context',
  公司介绍: 'context', 企业介绍: 'context', 关于我们: 'context', 公司简介: 'context', 团队介绍: 'context', 培训体系: 'context', 晋升体系: 'context', 晋升通道: 'context', 职业发展: 'context',
};
const headingNames = Object.keys(labels).sort((a, b) => b.length - a.length).join('|');
const headingPattern = new RegExp(`(?:【(${headingNames})】|\\[(${headingNames})\\]|(${headingNames})\\s*[：:]|^\\s*(${headingNames})\\s*$)`, 'gmu');
const preferred = /优先|加分|更佳|a plus|preferred/iu;
const unlimited = /(?:学历|经验|专业|年限)不限|不限(?:学历|经验|专业)|无(?:工作)?经验要求|无需(?:工作)?经验/u;
const objectiveGate = /(?:专科|大专|本科|硕士|博士|中专)|(?:相关|类)专业|(?:20\d{2}届|在校生|应届毕业)|(?:至少|不少于|具有|拥有|具备|需)?\s*[\d一二三四五六七八九十]+\s*(?:年|年以上).{0,12}(?:工作|相关|行业|岗位|开发|项目|经验)|每周.{0,10}[\d一二两三四五六七八九十]+\s*天|(?:连续|至少|持续|实习|不少于).{0,5}[\d一二两三四五六七八九十]+\s*个?月|工作许可|法律职业资格|律师执业|法考|(?:持有|取得|通过|必须).{0,14}(?:证书|资格证|驾照|认证)|(?:英语|英文|雅思|托福|CET|IELTS|TOEFL).{0,8}(?:[四六六八]级|[\d]+分|至少|不低于)/iu;
const capabilitySignal = /具备|具有|熟悉|熟练|掌握|了解|擅长|能够|能独立|会使用|有.{0,12}(?:经验|能力)|能力|意识|思维|沟通|协作|抗压|英文|英语|经验|技能|独立.{0,10}(?:阅读|分析|领导)|已取得|至少/iu;
const dutySignal = /^(?:向.{0,12}提供|在.{0,16}提供|负责|参与|协助|支持|维护|带领|开展|完成|处理|提供|了解客户|检索|整理|推动|跟进|制定|组织|开发|设计|分析|对接|调研|执行|搭建|核对)/u;
const promotion = /五行缺伯乐|期待你(?:的)?加入|等你加入|欢迎加入|加入我们|志同道合|遇见更好的自己|大好薪情|领到手软|带你飞|我们的豪宅|(?:学历|本科|硕士|博士).*占比|(?:我们|公司|企业|集团).{0,12}(?:成立于|共有|拥有|分布|专注|致力于)|年薪|底薪|提成|绩效奖金|月度奖|季度奖|年终奖|五险一金|六险一金|带薪年假|节日福利|团建|国内游|国外游|晋升随|大舞台|有一种(?:骄傲|信誉|信任)/u;
const independentClause = /^(?:(?:但|且)?(?:应聘者|候选人|申请者|你)?(?:需|须|必须)|具备|具有|熟悉|熟练|掌握|会使用|能够|能独立|已取得|通过|持有|至少|不少于|每周|连续|独立领导|本科|专科|大专|硕士|博士|沟通|英语|英文|良好|较强|[\d一二三四五六七八九十]+年|有.{0,10}(?:经验|能力))/u;

function cleanLine(raw: string) {
  return raw.trim().replace(/^(?:[-•·●]|[（(]?\d+[、.．)）])\s*/u, '');
}

/** Split only independent qualifications, not comma-separated objects within one duty. */
function qualificationSpans(full: string, section: Section): string[] {
  if (section === 'responsibility' && !objectiveGate.test(full)) return [full];
  const spans: string[] = [];
  let start = 0;
  for (const match of full.matchAll(/[，,、](?!\d)/gu)) {
    const next = full.slice(match.index! + 1).trimStart();
    const left = full.slice(start, match.index!).trim();
    // Keep attendance days and duration together as one auditable availability condition.
    if (independentClause.test(next) && !(/每周/u.test(left) && /^连续/u.test(next))) {
      if (left) spans.push(left);
      start = match.index! + 1;
    }
  }
  const last = full.slice(start).trim();
  if (last) spans.push(last);
  return spans;
}

function classification(text: string, section: Section): Category | undefined {
  if (unlimited.test(text) && !objectiveGate.test(text.replace(unlimited, ''))) return undefined;
  const qualificationWording = /^(?:(?:但|且)?(?:应聘者|候选人|申请者|你)?(?:需|须|必须)|学历要求|经验要求|专业要求|本科|专科|大专|硕士|博士|具备|具有|持有|已取得|至少|不少于|每周)/u.test(text);
  if (section === 'context' && !qualificationWording) return undefined;
  // A service audience or colleague's education is not the applicant's qualification.
  if (/^(?:团队成员|员工|同事|我们的团队).{0,16}(?:博士|硕士|本科|毕业|组成)/u.test(text)) return undefined;
  if (dutySignal.test(text) && !qualificationWording && !promotion.test(text)) return 'responsibility';
  // Population statistics, promises to employees and company introductions are not gates.
  const ad = promotion.test(text);
  const gate = objectiveGate.test(text) && !ad;
  if (preferred.test(text)) return gate || capabilitySignal.test(text) || section === 'preferred' ? 'preferred' : undefined;
  if (gate) return 'required';
  if (ad || section === 'context') return undefined;
  if (section === 'preferred') return 'preferred';
  if (section === 'responsibility' || dutySignal.test(text)) return 'responsibility';
  if (section === 'capability' || capabilitySignal.test(text)) return 'capability';
  return undefined;
}

/** Model input is job-only, exact original spans with stable IDs. No personal data. */
export function prepareRequirementCuration(job: Job): { sources: RequirementSource[]; metadata: NonNullable<JobAnalysis['metadata']> } {
  const metadata: NonNullable<JobAnalysis['metadata']> = { ...(job.industry ? { industry: job.industry } : {}) };
  const sources: RequirementSource[] = [];
  const seen = new Set<string>();
  let section: Section = 'unknown';
  const marked = job.text.replace(headingPattern, (_whole, bracket: string, square: string, colon: string, bare: string) => `\n@@${bracket || square || colon || bare}@@\n`);
  for (const raw of marked.split(/\r?\n|(?<=[。！？；;])/u)) {
    const full = cleanLine(raw);
    if (!full || /^[。！？；;]+$/u.test(full)) continue;
    const heading = full.match(/^@@(.+)@@$/u)?.[1];
    if (heading) { section = labels[heading]; continue; }
    const meta = full.match(/^(?:所属)?(行业|工作地点|办公地点|地点|城市|薪资|薪酬|工资|公司|企业|招聘人数|发布日期|更新时间|招聘类型|岗位名称|职位名称)\s*[：:]\s*(.*)$/u)
      || full.match(/^(薪资|薪酬|工资)\s*(未披露|面议|未公布|待确认)[。；;]?$/u);
    if (meta) {
      const value = meta[2].replace(/[。；;]$/u, '').trim() || full;
      if (meta[1] === '行业') metadata.industry = value;
      else if (/地点|城市/u.test(meta[1])) metadata.location = value;
      else if (/薪资|薪酬|工资/u.test(meta[1])) metadata.salary = value;
      else if (!(metadata.other || []).includes(full)) (metadata.other ||= []).push(full);
      continue;
    }
    if (/^[\p{Script=Han}与及、\s]{2,28}行业[。；;]?$/u.test(full) && !/经验|熟悉|了解|要求|具备/u.test(full)) { metadata.industry ||= full; continue; }
    if (/^(?:上海|杭州|北京|深圳|广州|成都|南京|武汉)(?:或|、|与|\/)?(?:上海|杭州|北京|深圳|广州|成都|南京|武汉)?(?:的方向参考|地区|市)?[。；;]?$/u.test(full)) { metadata.location ||= full; continue; }
    // Independent mandatory clauses inside a perks paragraph still survive. Statistics
    // such as "本科学历占比" are excluded in classification, even after segmentation.
    const spans = qualificationSpans(full, section);
    for (const text of spans) {
      const category = classification(text, section);
      const key = text.replace(/[\s。；;]+$/gu, '');
      if (!category || seen.has(key)) continue;
      seen.add(key);
      sources.push({ id: `source_${sources.length + 1}`, text, categoryHint: category, hardGate: category === 'required' });
    }
  }
  return { sources, metadata };
}

/** Honest offline fallback: paragraphs/conditions, category-aware, deduplicated, no invented skills. */
export function parseRequirements(job: Job): CuratedRequirements {
  const { sources, metadata } = prepareRequirementCuration(job);
  if (sources.length > 80) throw new Error('岗位独立条件超过 80 项，请按一个具体岗位精简后分析；系统没有省略后续条件。');
  return {
    requirements: sources.map((source, index) => ({ id: `req_${index + 1}`, text: source.text, category: source.categoryHint, sourceQuotes: [source.text] })), metadata,
    curation: { mode: 'rules', sourceCount: sources.length, warnings: ['当前使用规则提炼，未进行模型语义归纳；分类与相关性需人工核对。'] },
  };
}

/** Verify exact full quotes so negation, preferred status, years and objects cannot be cropped away. */
export function validateCuratedRequirements(job: Job, reply: unknown): CuratedRequirements {
  const parsed = requirementCurationSchema.parse(reply);
  const { sources, metadata } = prepareRequirementCuration(job);
  const byId = new Map(sources.map(source => [source.id, source]));
  const used = new Set<string>();
  const requirements: RequirementCandidate[] = [];
  const warnings: string[] = [];
  const append = (category: Category, selected: RequirementSource[]) => {
    if (!selected.length) return;
    const sourceQuotes = selected.map(source => source.text);
    requirements.push({ id: `req_${requirements.length + 1}`, text: sourceQuotes.join('\n'), category, sourceQuotes });
  };
  for (const item of parsed.requirements) {
    const selected = item.sources.map(reference => {
      const source = byId.get(reference.sourceId);
      if (!source) throw new Error('模型返回了未知的岗位原文引用，请重新分析。');
      if (reference.quote !== source.text || !job.text.includes(reference.quote)) throw new Error('模型的岗位引文与原文不一致，不能改写、截断或补造条件，请重新分析。');
      if (used.has(source.id)) throw new Error('模型重复使用了同一段岗位原文，请重新分析。');
      used.add(source.id);
      return source;
    });
    // Keep objective barriers and explicit preferred wording in their original class.
    // The model may interpret non-gate skills versus duties but cannot promote them to hard gates.
    const buckets = new Map<Category, RequirementSource[]>();
    for (const source of selected) {
      const category: Category = source.hardGate ? 'required' : source.categoryHint === 'preferred' ? 'preferred'
        : item.category === 'required' || item.category === 'preferred' ? source.categoryHint : item.category;
      const bucket = buckets.get(category) || []; bucket.push(source); buckets.set(category, bucket);
      if (category !== item.category && !warnings.includes('已按招聘原文保留硬门槛与加分项分类，未将一般能力升级为准入限制。')) warnings.push('已按招聘原文保留硬门槛与加分项分类，未将一般能力升级为准入限制。');
    }
    for (const [category, selectedSources] of buckets) append(category, selectedSources);
  }
  const missingGates = sources.filter(source => source.hardGate && !used.has(source.id));
  const missingDuties = sources.filter(source => source.categoryHint === 'responsibility' && !used.has(source.id));
  for (const source of [...missingGates, ...missingDuties]) append(source.categoryHint, [source]);
  if (missingGates.length) warnings.push(`已补回模型未覆盖的 ${missingGates.length} 项明确硬门槛，请逐项核对。`);
  if (missingDuties.length) warnings.push(`已保留模型未覆盖的 ${missingDuties.length} 项工作职责，未为凑条数省略。`);
  if (requirements.length > 15) warnings.push('该岗位的独立条件较多，已完整保留门槛与职责，未强行压缩至 15 项。');
  return { requirements, metadata, curation: { mode: 'model', warnings, sourceCount: sources.length } };
}

const groups: Array<[string, RegExp]> = [
  ['english', /英文|英语|english|ielts|toefl/iu], ['certificate', /法考|法律职业资格|律师执业|职业资格证/u],
  ['rohs', /rohs/iu], ['reach', /reach/iu], ['lead', /领导|带领|(?:担任|作为|项目|团队)负责人|主导/u],
  ['legal', /法学|法律|法规/u], ['privacy', /隐私|个人信息/u], ['policy', /政策/u],
  ['search', /检索|资料搜索|文献搜索/u], ['writing', /写作|撰写|报告|摘要|初稿/u],
  ['excel', /excel|电子表格/iu], ['comparison', /对比|比较表/u], ['minutes', /会议纪要/u],
  ['research', /研究|调研/u], ['feedback', /反馈/u], ['documents', /资料|材料|文档/u],
  ['python', /python/iu], ['sql', /\bsql\b/iu], ['java', /\bjava\b/iu], ['react', /\breact\b/iu],
  ['development', /开发|编程|软件/u], ['analysis', /分析/u], ['design', /设计|原型/u],
  ['communication', /沟通|协作|协调/u], ['operation', /运营|策划/u], ['certification', /认证/u], ['chemicals', /化学物质/u],
  ['corporateInternship', /企业.*实习|实习.*企业/u], ['corporateWork', /企业.*工作|工作.*企业/u], ['crossborder', /出境|跨境|海外/u],
];
const anchors = (text: string) => groups.filter(([, pattern]) => pattern.test(text.replace(/\s+/gu, ''))).map(([id]) => id);
const critical = new Set(['english', 'certificate', 'rohs', 'reach', 'lead', 'python', 'sql', 'java', 'react', 'certification', 'chemicals', 'crossborder', 'corporateWork']);
const negation = /(?:没有|尚无|未曾|从未|未取得|未通过|不具备|未担任|未负责|尚未|未参与|未在|不会|不熟悉|无.{0,8}(?:经验|资格|证书))/u;
const learning = /学习中|正在学习|入门|基础|初步/u;
const profileLabels: Record<string, string> = { education: '学历', major: '专业', graduation: '毕业时间', availability: '到岗安排' };
const toNumber = (value: string) => Number(/^\d+$/u.test(value) ? value : chineseNumber(value));
const quantity = '[\\d零〇一二两三四五六七八九十]+';

function basicEvidence(profile: Profile, requirement: string): { state: NonNullable<MatchItem['evidenceState']>; fields: string[]; text: string } | undefined {
  const checks: Array<{ state: 'supported' | 'unknown' | 'unmet'; field: string }> = [];
  const degrees = ['专科', '本科', '硕士', '博士'];
  const requiredDegree = degrees.findIndex(d => requirement.includes(d));
  if (requiredDegree >= 0) {
    const actual = degrees.findIndex(d => profile.education.includes(d));
    checks.push({ field: 'education', state: actual < 0 ? 'unknown' : actual >= requiredDegree ? 'supported' : 'unmet' });
  }
  if (/法学.*(?:相关|专业|本科|硕士|博士)|法律.*专业/u.test(requirement)) checks.push({ field: 'major', state: !profile.major ? 'unknown' : /法学|法律/u.test(profile.major) ? 'supported' : 'unknown' });
  if (/在校生|应届|毕业/u.test(requirement)) {
    const year = profile.graduation.match(/20\d{2}/u)?.[0];
    const expectedYear = requirement.match(/20\d{2}/u)?.[0];
    const graduationMonth = profile.graduation.match(/20\d{2}\s*(?:年|[./-])\s*(\d{1,2})/u)?.[1];
    const now = new Date();
    const future = year && (Number(year) > now.getUTCFullYear() || (Number(year) === now.getUTCFullYear() && (!graduationMonth || Number(graduationMonth) >= now.getUTCMonth() + 1)));
    const completed = /(?:本科|硕士|博士|专科|已经|已)毕业/u.test(requirement) && !/应届/u.test(requirement);
    checks.push({ field: 'graduation', state: !year ? 'unknown' : expectedYear ? year === expectedYear ? 'supported' : 'unmet' : /在校生/u.test(requirement) ? future ? 'supported' : 'unknown' : completed ? future ? 'unmet' : 'supported' : 'unknown' });
  }
  const days = requirement.match(new RegExp(`每周(?:至少|可|能|到岗|实习|工作|出勤|不少于|\\s)*(${quantity})\\s*天`, 'u'))?.[1];
  const months = requirement.match(new RegExp(`(?:连续|至少|持续|实习|不少于)(?:\\s|达|满|期)*(${quantity})\\s*个?月`, 'u'))?.[1];
  if (days || months) {
    const actualDays = profile.availability.match(new RegExp(`每周(?:可|能|到岗|实习|工作|出勤|\\s)*(${quantity})\\s*天`, 'u'))?.[1];
    const actualMonths = profile.availability.match(new RegExp(`(${quantity})\\s*个?月`, 'u'))?.[1];
    checks.push({ field: 'availability', state: (days && !actualDays) || (months && !actualMonths) ? 'unknown' : (days && toNumber(actualDays!) < toNumber(days)) || (months && toNumber(actualMonths!) < toNumber(months)) ? 'unmet' : 'supported' });
  }
  if (!checks.length) return undefined;
  // Basic fields can establish only the clauses they describe. Unparsed residual
  // conditions such as "且有五年企业经验" must never disappear behind a degree match.
  const residual = requirement
    .replace(/法学(?:或相关专业|相关专业|相关)?|法律(?:或相关)?专业/gu, '')
    .replace(/(?:专科|本科|硕士|博士)(?:及以上|以上)?/gu, '')
    .replace(/20\d{2}(?:年|届)?|在校生|应届|毕业生|毕业时间|已经毕业|已毕业|毕业/gu, '')
    .replace(new RegExp(`每周(?:至少|可|能|到岗|实习|工作|出勤|不少于|\\s)*(${quantity})\\s*天`, 'gu'), '')
    .replace(new RegExp(`(?:连续|至少|持续|实习|不少于)(?:\\s|达|满|期)*(${quantity})\\s*个?月`, 'gu'), '')
    .replace(/学历|学位|要求|需要|需|为|是|相关专业|专业|具备|及以上|以及|及|且|并|[\s。；;，,：:、]/gu, '');
  if (residual) checks.push({ field: '', state: 'unknown' });
  const known = checks.filter(c => c.state !== 'unknown');
  const fields = [...new Set(known.map(c => c.field))];
  return {
    state: checks.some(c => c.state === 'unmet') ? 'unmet' : checks.some(c => c.state === 'unknown') ? known.length ? 'partial' : 'unknown' : 'supported', fields,
    text: fields.map(field => `${profileLabels[field]}：${profile[field as keyof Profile]}`).join('\n'),
  };
}

function related(requirement: string, facts: Fact[]): Fact[] {
  const required = anchors(requirement); const essential = required.filter(anchor => critical.has(anchor));
  return facts.filter(fact => {
    if (/^(?:职业偏好|求职意向|希望探索|希望从事|想从事|感兴趣)/u.test(fact.text.trim())) return false;
    const has = anchors(fact.text);
    return required.length > 0 && required.some(a => has.includes(a)) && essential.every(a => has.includes(a));
  });
}

export function resolveMatch(profile: Profile, candidate: RequirementCandidate, proposed?: MatchReply): MatchItem {
  const facts = profile.facts.filter(fact => fact.confirmed);
  const base = { requirement: candidate.text, category: candidate.category, sourceQuotes: candidate.sourceQuotes || [candidate.text], profileFields: [] as string[], factIds: [] as string[] };
  const basic = candidate.category === 'responsibility' ? undefined : basicEvidence(profile, candidate.text);
  if (basic) return { ...base, status: basic.state === 'unknown' || basic.state === 'unmet' ? 'missing' : basic.state, evidenceState: basic.state, profileFields: basic.fields,
    evidence: `${basic.text}${basic.text ? '\n' : ''}${basic.state === 'unmet' ? '当前填写资料与本项条件不符；如资料已变化，请先更新。' : basic.state === 'unknown' ? '尚未提供足够资料，需补充核验；不代表不具备。' : basic.state === 'partial' ? '部分基本资料有据，剩余条件待确认。' : '个人资料支持本项条件；录用资格仍由招聘方核验。'}` };
  const allRelated = related(candidate.text, facts);
  // A fact denying a different skill cannot disqualify this skill. Split clauses first.
  const explicitNegative = allRelated.filter(fact => fact.text.split(/[，。；;\n]/u).some(clause => negation.test(clause) && related(candidate.text, [{ ...fact, text: clause }]).length));
  const proposedFacts = proposed ? related(candidate.text, facts.filter(fact => proposed.factIds.includes(fact.id))) : allRelated;
  const positive = proposedFacts.filter(fact => !explicitNegative.includes(fact));
  const selected = (positive.length ? positive : explicitNegative).slice(0, 3);
  if (!selected.length) return { ...base, status: 'missing', evidenceState: 'unknown', evidence: '暂无可支持该要求的已确认经历证据，尚未提供足够资料；请人工核验，不代表不具备。' };
  let state: NonNullable<MatchItem['evidenceState']> = 'partial';
  if (!positive.length && explicitNegative.length) state = explicitNegative.some(fact => fact.text.split(/[，。；;\n]/u).some(clause => learning.test(clause) && related(candidate.text, [{ ...fact, text: clause }]).length)) ? 'partial' : 'unmet';
  else if (proposed?.status === 'supported' && !positive.some(fact => fact.text.split(/[，。；;\n]/u).some(clause => related(candidate.text, [{ ...fact, text: clause }]).length && /学习中|正在学习|尚未|未提供|简单/u.test(clause)))) {
    const required = anchors(candidate.text); const supported = anchors(positive.map(fact => fact.text).join('\n'));
    state = required.every(anchor => supported.includes(anchor)) ? 'supported' : 'partial';
  }
  // The model cannot turn an unsubstantiated "missing" into a factual denial.
  if (proposed?.status === 'missing' && state !== 'unmet') state = positive.length ? 'partial' : state;
  return { ...base, status: state === 'unmet' ? 'missing' : state, evidenceState: state, factIds: selected.map(fact => fact.id), evidence: selected.map(fact => fact.text).join('\n') };
}

export function cleanRequirementIds(value: string, requirements: RequirementCandidate[]): string {
  return value.replace(/\breq_\d+\b/gu, id => requirements.find(requirement => requirement.id === id)?.text.replace(/[。；;]$/u, '') || '该项岗位条件');
}

export function buildAnalysis(profile: Profile, job: Job, analysis?: { summary: string; matches: MatchReply[]; questions: string[]; directionAdvice: string[] }, curated?: CuratedRequirements): JobAnalysis {
  let selected = curated || parseRequirements(job);
  if (curated) {
    // Rebind every source to this exact JD at the trust boundary. A stale or forged
    // curation cannot borrow quotes from another job or silently omit hard gates.
    const { sources } = prepareRequirementCuration(job);
    selected = validateCuratedRequirements(job, { requirements: curated.requirements.map(item => ({ category: item.category, sources: (item.sourceQuotes || [item.text]).map(quote => ({ sourceId: sources.find(source => source.text === quote)?.id || 'unknown', quote })) })) });
    selected.curation.warnings = [...new Set([...curated.curation.warnings, ...selected.curation.warnings])];
  }
  const { requirements, metadata, curation } = selected;
  const factIds = new Set(profile.facts.filter(fact => fact.confirmed).map(fact => fact.id));
  const seen = new Set<string>();
  for (const match of analysis?.matches || []) {
    if (!requirements.some(requirement => requirement.id === match.requirementId)) throw new Error('模型返回了未知的岗位要求引用，未能对应到原始 JD，请重试。');
    if (seen.has(match.requirementId)) throw new Error('模型重复引用了同一项岗位要求，请重试。');
    seen.add(match.requirementId);
    if (match.factIds.some(id => !factIds.has(id)) || new Set(match.factIds).size !== match.factIds.length) throw new Error('模型返回了无效的事实引用；请重试，当前结果未保存。');
  }
  const matches = requirements.map(candidate => resolveMatch(profile, candidate, analysis?.matches.find(match => match.requirementId === candidate.id)));
  return {
    summary: analysis ? cleanRequirementIds(analysis.summary, requirements) : '规则演示分析：已按招聘原文区分门槛、能力、加分项与职责，并排除可识别的宣传和福利介绍。基本资料按具体条件核对，经历按关键词关联；未进行模型语义判断，相关经历不代表完全满足。',
    matches, metadata, curation,
    questions: analysis?.questions.map(value => cleanRequirementIds(value, requirements)) || [...matches.filter(match => match.evidenceState === 'unknown').slice(0, 3).map(match => `你是否有可支持“${match.requirement}”的真实资料或经历？`)],
    directionAdvice: analysis?.directionAdvice.map(value => cleanRequirementIds(value, requirements)) || ['行业说明业务背景；请结合具体工作职责、城市偏好与薪资信息决定是否申请。'],
  };
}
