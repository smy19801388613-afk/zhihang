import { jobText } from '../shared/job-source.ts';
import { createHash } from 'node:crypto';
import type { BrowserCaptureRecord, CaptureBatch, CaptureEditableFields, CaptureFields, CaptureImportResult, CaptureJob, CapturePlatform } from '../shared/browser-capture.ts';
import type { CompanyCandidate, Job, WorkspaceState } from '../shared/types.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cityKey = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').replace(/市$/, '').toLowerCase();
export function isTrustedCaptureLogo(platform: CapturePlatform, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const domains = platform === 'boss' ? ['zhipin.com', 'bosszhipin.com'] : ['58.com', '58cdn.com.cn'];
    return domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
// Only recruitment categories are accepted. Classifieds such as housing, services,
// people and company profile pages cannot become job records through this API.
const job58Categories = new Set(['job', 'zhaopin', 'tech', 'renli', 'kefu', 'xiaoshou', 'caiwu', 'shichang', 'shengchan', 'wuliucangchu', 'siji', 'jiaoyu', 'fanyizhaopin', 'lvshi', 'zhaopinxinxi', 'yinshi', 'jiudian', 'baojie', 'meirong', 'yiyuanyiliao', 'wenshu', 'guanggao', 'meishu', 'jianzhu', 'fangchan', 'jinrong', 'maoyi', 'qiche', 'dianshang', 'it', 'pugong', 'kuaidi', 'baomu', 'anfang', 'shejizhaopin']);
for (const category of ['falv', 'yewu', 'zplvyoujiudian', 'chaoshi', 'zpwuliucangchu', 'zpshangwumaoyi', 'zpfangchan', 'zpxiaoshou', 'zpkefu', 'zpwenyuan', 'zpshichangyingxiao', 'zpmeishu', 'zpzhuangxiu', 'zpyiyuanyiliao', 'zpjianshen', 'zhuanye', 'zpbaomu', 'zpanmo', 'zpsiji', 'zpshengchanyunying']) job58Categories.add(category);
export function normalizeCaptureUrl(platform: CapturePlatform, value: string): { url: string; sourceJobId: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('岗位原始链接格式无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('岗位链接必须使用招聘网站的 HTTPS 地址。');
  if (platform === 'boss') {
    const match = /^\/job_detail\/([A-Za-z0-9_-]{6,150})\.html$/.exec(url.pathname);
    if (url.hostname !== 'www.zhipin.com' || !match) throw new Error('BOSS 仅接收 www.zhipin.com 的单个岗位详情链接。');
    return { url: `https://www.zhipin.com/job_detail/${match[1]}.html`, sourceJobId: match[1] };
  }
  const match = /^\/([a-z][a-z0-9_-]{0,39})\/([0-9]{6,30})x\.shtml$/.exec(url.pathname);
  if (!/^[a-z0-9-]+\.58\.com$/.test(url.hostname) || !match || !job58Categories.has(match[1])) throw new Error('58 同城仅接收已适配招聘分类中的单个岗位详情链接。');
  return { url: `https://${url.hostname}/${match[1]}/${match[2]}x.shtml`, sourceJobId: match[2] };
}
export const capturePayloadHash = (batch: CaptureBatch) => hash(JSON.stringify(batch));
function rawSnapshot(job: CaptureJob): Omit<CaptureJob, 'edits'> {
  const { edits: _edits, ...raw } = structuredClone(job);
  return raw;
}
function effectiveFields(job: CaptureJob): CaptureFields { return { ...structuredClone(job.fields), ...structuredClone(job.edits || {}) }; }
function sourceCities(record: BrowserCaptureRecord) { return record.rawHistory.map(raw => cityKey(raw.fields.city)).filter(Boolean); }
export function applyCaptureEdits(record: BrowserCaptureRecord, edits: Partial<CaptureEditableFields>, now: string): void {
  for (const key of Object.keys(edits) as Array<keyof CaptureEditableFields>) {
    const value = edits[key];
    if (value !== undefined) {
      (record.fields as unknown as Record<string, string | boolean>)[key] = value;
      if (!record.editedFields.includes(key)) record.editedFields.push(key);
    }
  }
  // A user deliberately changing the description owns its completeness as well.
  if ('jd' in edits && !('jdComplete' in edits)) {
    if (!record.editedFields.includes('jdComplete')) record.editedFields.push('jdComplete');
  }
  if ('jd' in edits) record.jdEditedAt = now;
  record.updatedAt = now;
}
export function mergeBrowserCaptures(state: WorkspaceState, batch: CaptureBatch, now = new Date().toISOString()): CaptureImportResult {
  const registry = state.browserCaptures ??= {};
  const result: CaptureImportResult = { requestId: batch.requestId, imported: 0, updated: 0, duplicates: 0, errors: [] };
  batch.jobs.forEach((job, index) => {
    try {
      const source = normalizeCaptureUrl(job.platform, job.sourceUrl);
      const incomingCity = cityKey(job.fields.city);
      const sameSource = Object.values(registry).filter(record => record.platform === job.platform && record.sourceJobId === source.sourceJobId);
      // A blank city may be filled only when the source identifies one record.
      // Never pick arbitrarily between the same post captured for two cities.
      const exact = sameSource.filter(record => incomingCity && sourceCities(record).includes(incomingCity));
      const empty = sameSource.filter(record => !sourceCities(record).length);
      const previous = exact.length === 1 ? exact[0] : sameSource.length === 1 && (!incomingCity || empty.length === 1) ? sameSource[0] : undefined;
      if (!previous) {
        if (Object.keys(registry).length >= 2000) throw new Error('已保存 2000 个浏览器岗位，请先整理后再导入。');
        const id = `capture-${hash(`${job.platform}|${source.sourceJobId}|${incomingCity}`).slice(0, 32)}`;
        if (registry[id]) throw new Error('同一来源岗位存在城市歧义，请补充城市后重新导入。');
        registry[id] = { id, platform: job.platform, sourceJobId: source.sourceJobId, sourceUrl: source.url, firstCapturedAt: job.capturedAt, lastCapturedAt: job.capturedAt, receivedAt: now, updatedAt: now, jdCapturedAt: job.capturedAt, ...('jd' in (job.edits || {}) ? {jdEditedAt: now} : {}), rawHistory: [rawSnapshot(job)], fields: effectiveFields(job), editedFields: Object.keys(job.edits || {}) as Array<keyof CaptureEditableFields>, selected: false };
        if ('jd' in (job.edits || {}) && !('jdComplete' in (job.edits || {}))) applyCaptureEdits(registry[id], { jd: job.edits!.jd }, now);
        result.imported++;
        return;
      }
      const before = JSON.stringify(previous.fields);
      const previousJd = previous.fields.jd;
      const previousComplete = previous.fields.jdComplete;
      const incoming = effectiveFields(job);
      const incomingEdits = { ...(job.edits || {}) };
      if ('jd' in incomingEdits && !('jdComplete' in incomingEdits)) { incoming.jdComplete = previous.fields.jdComplete; incomingEdits.jdComplete = previous.fields.jdComplete; }
      const protectedFields = new Set(previous.editedFields);
      for (const key of Object.keys(incoming) as Array<keyof CaptureFields>) {
        if (protectedFields.has(key as keyof CaptureEditableFields)) continue;
        const value = incoming[key];
        if (value === undefined || (value === '' && !(key in incomingEdits))) continue;
        if (key === 'jd' || key === 'jdComplete') {
          // A later list summary must never downgrade an already complete JD.
          if ((previous.fields.jdComplete && !(key in incomingEdits)) || protectedFields.has('jd')) continue;
          if (key === 'jdComplete' && !incoming.jd.trim()) continue;
          if (!incoming.jdComplete && key === 'jd' && previous.fields.jd.length >= incoming.jd.length) continue;
        } else if (previous.fields[key] !== '' && previous.fields[key] !== undefined && !(key in incomingEdits)) continue;
        (previous.fields as unknown as Record<string, string | boolean>)[key] = value;
        if (key in incomingEdits && key !== 'logoUrl') previous.editedFields.push(key);
      }
      if (previousJd !== previous.fields.jd || previousComplete !== previous.fields.jdComplete) {
        if (previous.editedFields.includes('jd')) previous.jdEditedAt = now;
        else previous.jdCapturedAt = job.capturedAt;
      }
      const raw = rawSnapshot(job);
      if (!previous.rawHistory.some(item => JSON.stringify(item) === JSON.stringify(raw))) {
        const history = [...previous.rawHistory, raw];
        previous.rawHistory = history.length <= 5 ? history : [history[0], ...history.slice(-4)];
      }
      if (Date.parse(job.capturedAt) < Date.parse(previous.firstCapturedAt)) previous.firstCapturedAt = job.capturedAt;
      if (Date.parse(job.capturedAt) > Date.parse(previous.lastCapturedAt)) previous.lastCapturedAt = job.capturedAt;
      previous.updatedAt = now;
      if (before === JSON.stringify(previous.fields)) result.duplicates++;
      else result.updated++;
    } catch (error) { result.errors.push({ index, message: error instanceof Error ? error.message : '岗位导入失败。' }); }
  });
  return result;
}
export function captureCandidate(record: BrowserCaptureRecord): CompanyCandidate {
  const f = record.fields;
  const jdUserEdited = record.editedFields.includes('jd');
  const matchingOriginal = record.rawHistory.find(raw => raw.fields.jd === f.jd && raw.fields.jdComplete === f.jdComplete);
  const jdAt = (jdUserEdited ? record.jdEditedAt : record.jdCapturedAt) || matchingOriginal?.capturedAt || record.firstCapturedAt;
  return { id: record.id, name: f.company, role: f.title, industry: f.industry || '', location: f.city, salary: f.salary, education: f.education, experience: f.experience, jobDescription: f.jd, jdComplete: f.jdComplete, jdUserEdited,
    rationale: f.jdComplete ? '由你从浏览器当前页面导入，请以原页面为准核对招聘情况。' : '详情待补充：当前只有已展示的岗位摘要，请打开详情后再次导入或手动补充完整 JD。',
    requirements: [f.education, f.experience].filter(Boolean), careerUrl: record.sourceUrl, sourceLabel: `${record.platform === 'boss' ? 'BOSS直聘' : '58同城'} · 浏览器导入${f.jdComplete ? '' : ' · 详情待补充'}${jdUserEdited ? ' · JD经用户修订' : ''}`, checkedAt: f.jdComplete ? jdAt : record.lastCapturedAt,
    hiringStatus: 'unverified', selected: record.selected, ...(record.decision ? { decision: record.decision } : {}), sourceJobId: record.sourceJobId, sourceKind: 'browser_capture', capturePlatform: record.platform, ...(f.logoUrl ? { logoUrl: f.logoUrl } : {}) };
}
export function captureJob(record: BrowserCaptureRecord): Job {
  const f = record.fields;
  return { company: f.company, title: f.title, text: jobText([f.industry ? `行业：${f.industry}` : '', f.city ? `地点：${f.city}` : '', f.salary ? `薪资：${f.salary}` : '', f.education ? `学历要求：${f.education}` : '', f.experience ? `经验要求：${f.experience}` : ''], f.jd), url: record.sourceUrl, location: f.city, industry: f.industry || '', roleFamily: f.title, sourceKind: 'browser_capture', candidateId: record.id, jdComplete: f.jdComplete };
}
export function syncCaptureDecisions(state: WorkspaceState): void {
  for (const candidate of state.exploration?.companies || []) {
    const record = state.browserCaptures?.[candidate.id];
    if (!record) continue;
    record.selected = candidate.selected;
    if (candidate.decision) record.decision = candidate.decision;
    else delete record.decision;
  }
}
export function mergeCaptureCandidates(state: WorkspaceState): void {
  state.exploration ??= { messages: [], directions: [], selectedDirectionIds: [], companies: [], stage: 'conversation' };
  const registry = state.browserCaptures || {};
  state.exploration.companies = [...state.exploration.companies.filter(candidate => !registry[candidate.id]), ...Object.values(registry).map(captureCandidate)];
}
