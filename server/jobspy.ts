import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CareerDirection, CompanyCandidate, JobSourceResult } from '../shared/types.ts';

type Source = 'linkedin' | 'indeed';
type Row = Record<string, unknown>;
export interface JobSpyQuery { id: string; source: Source; term: string; location: string }
export interface JobSpyQueryResult { id: string; rows: Row[]; checkedAt: string; error?: string }
export interface JobSpyBridgeResult { results: JobSpyQueryResult[]; error?: string; failures?: Record<string, number> }
export interface JobSpySearchInput { city: string; directions: CareerDirection[] }
export interface JobSpyDiscovery { candidates: CompanyCandidate[]; sources: JobSourceResult[] }
export type JobSpyDiscoverer = (input: JobSpySearchInput) => Promise<JobSpyDiscovery>;
interface Options {
  python?: string; timeoutMs?: number; now?: () => number; cacheTtlMs?: number;
  run?: (queries: JobSpyQuery[]) => Promise<JobSpyBridgeResult>;
}
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const LABELS: Record<Source, string> = { linkedin: 'LinkedIn 公开岗位 · JobSpy', indeed: 'Indeed 公开岗位 · JobSpy' };
const CITIES: Array<[string, string]> = [
  ['北京', 'Beijing'], ['上海', 'Shanghai'], ['广州', 'Guangzhou'], ['深圳', 'Shenzhen'], ['杭州', 'Hangzhou'],
  ['南京', 'Nanjing'], ['成都', 'Chengdu'], ['武汉', 'Wuhan'], ['西安', "Xi'an"], ['重庆', 'Chongqing'],
  ['苏州', 'Suzhou'], ['天津', 'Tianjin'], ['厦门', 'Xiamen'], ['青岛', 'Qingdao'], ['长沙', 'Changsha'],
  ['合肥', 'Hefei'], ['郑州', 'Zhengzhou'], ['济南', 'Jinan'], ['福州', 'Fuzhou'], ['宁波', 'Ningbo'],
  ['珠海', 'Zhuhai'], ['东莞', 'Dongguan'], ['佛山', 'Foshan'], ['大连', 'Dalian'], ['沈阳', 'Shenyang'],
  ['香港', 'Hong Kong'], ['澳门', 'Macau'], ['台北', 'Taipei'],
];
// The more specific rules precede broader families. A title match alone does
// not turn a generic compliance vacancy into a privacy/product compliance job.
const ROLES = [
  { trigger: /隐私|数据合规|个人信息|privacy|data protection/iu, term: 'privacy compliance intern', title: /合规|法务|法律|隐私|政策|privacy|compliance|legal|policy/iu, detail: /隐私|数据合规|个人信息|数据保护|privacy|data protection|gdpr/iu },
  { trigger: /产品合规|产品认证|rohs|reach/iu, term: 'product compliance intern', title: /合规|法规|认证|compliance|regulatory|certification/iu, detail: /产品合规|产品认证|rohs|reach|product.{0,15}(?:compliance|certification)|regulatory/iu },
  { trigger: /法务|合规|法律|知识产权|政策|legal|compliance|policy/iu, term: 'compliance intern', title: /合规|法务|法律|知识产权|政策|compliance|legal|policy|intellectual property/iu },
  { trigger: /数据分析|商业分析|经营分析|data analyst|business analyst/iu, term: 'data analyst intern', title: /数据分析|商业分析|经营分析|data analy|business analy/iu },
  { trigger: /产品|product/iu, term: 'product manager intern', title: /产品经理|产品策划|产品运营|产品助理|游戏策划|product (?:manager|management|operation|analyst|intern)/iu },
  { trigger: /算法|人工智能|机器学习|machine learning|algorithm|artificial intelligence/iu, term: 'machine learning intern', title: /算法|机器学习|人工智能|模型工程|machine learning|algorithm|artificial intelligence|data scien/iu },
  { trigger: /前端|frontend|front.end/iu, term: 'frontend developer intern', title: /前端|web开发|frontend|front.end/iu },
  { trigger: /后端|服务端|软件|开发|工程师|backend|software/iu, term: 'software engineer intern', title: /开发|工程|研发|软件|software|engineer|developer/iu },
  { trigger: /运营|operation/iu, term: 'operations intern', title: /运营|operation/iu },
  { trigger: /设计|design/iu, term: 'design intern', title: /设计|design/iu },
  { trigger: /市场|营销|品牌|商务|marketing/iu, term: 'marketing intern', title: /市场|营销|品牌|商务|marketing|brand|business develop/iu },
  { trigger: /人力|招聘|组织|human resource|recruit/iu, term: 'human resources intern', title: /人力|招聘|组织|human resource|recruit/iu },
  { trigger: /财务|审计|税务|finance|audit/iu, term: 'finance intern', title: /财务|审计|税务|finance|audit|tax/iu },
  { trigger: /供应链|采购|物流|supply chain|logistics/iu, term: 'supply chain intern', title: /供应链|采购|物流|supply chain|procurement|logistics/iu },
];
const value = (input: unknown): string => typeof input === 'string' ? input.trim() : typeof input === 'number' ? String(input) : '';
function plain(input: unknown): string {
  return value(input).replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
    .replace(/<br\s*\/?\s*>|<\/p>|<\/li>/giu, '\n').replace(/<[^>]*>/gu, '').replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').trim();
}
function cityTokens(city: string): Array<[string, string]> {
  const known = CITIES.filter(([zh, en]) => city.includes(zh) || city.toLowerCase().includes(en.toLowerCase()));
  if (known.length) return known.slice(0, 3);
  if (!city.trim() || /不限|全国|待定|未定|都可以|不限制|灵活|无偏好|任意|无要求/u.test(city)) return [];
  return city.split(/[、，,/]+/u).map(item => item.trim()).filter(Boolean).slice(0, 3).map(item => [item, item]);
}
function fitsCity(location: string, city: string): boolean {
  if (!location) return false;
  const wanted = cityTokens(city);
  if (!wanted.length) return /china|中国|北京|上海|广州|深圳|杭州|江苏|浙江|香港|taiwan|hong kong/iu.test(location);
  // City names such as "Shanghai" in a foreign company address must not bypass
  // a known contradictory country in the actual location field.
  if (/united states|united kingdom|germany|india|canada|australia/iu.test(location)) return false;
  return wanted.some(([zh, en]) => location.includes(zh) || new RegExp(`(?:^|[^a-z])${en.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[^a-z])`, 'iu').test(location));
}
export function matchesJobSpyRole(title: string, jd: string, direction: CareerDirection): boolean {
  const rule = ROLES.find(item => item.trigger.test(direction.role));
  if (rule) return rule.title.test(title) && (!('detail' in rule) || !rule.detail || rule.detail.test(`${title}\n${jd}`));
  const terms = direction.role.replace(/实习生?|校招|应届|助理|支持|岗位|方向|intern(?:ship)?/giu, '').split(/[\s、/，,()（）—-]+/u).filter(term => term.length >= 2);
  return terms.some(term => title.toLowerCase().includes(term.toLowerCase()));
}
export function buildJobSpyQueries(input: JobSpySearchInput): JobSpyQuery[] {
  const cities = cityTokens(input.city).map(([, en]) => /远程|remote/iu.test(en) ? 'China' : en);
  if (!cities.length) cities.push('China');
  const terms = [...new Set(input.directions.slice(0, 3).map(direction => {
    const rule = ROLES.find(item => item.trigger.test(direction.role));
    return rule?.term ?? `${direction.role.replace(/[\r\n]/gu, ' ').slice(0, 70)} intern`;
  }))];
  const queries: JobSpyQuery[] = [];
  // First city: each selected direction. Additional cities get the same
  // direction coverage before an alternate source consumes the six-query cap.
  for (const city of cities) for (const term of terms) {
    if (queries.length < 6) queries.push({ id: `q${queries.length}`, source: 'linkedin', term, location: city });
  }
  for (const city of cities) for (const term of terms) {
    if (queries.length < 6) queries.push({ id: `q${queries.length}`, source: 'indeed', term, location: city });
  }
  return queries;
}
function safeSourceUrl(raw: unknown, source: Source): string {
  try {
    const url = new URL(value(raw));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (source === 'linkedin' && !/(^|\.)linkedin\.com$/u.test(url.hostname)) return '';
    if (source === 'indeed' && !/(^|\.)indeed\.com$/u.test(url.hostname)) return '';
    url.hash = ''; return url.toString();
  } catch { return ''; }
}
function salaryLabel(row: Row): string {
  const min = typeof row.min_amount === 'number' && Number.isFinite(row.min_amount) ? row.min_amount : null;
  const max = typeof row.max_amount === 'number' && Number.isFinite(row.max_amount) ? row.max_amount : null;
  if (min === null && max === null) return '未披露';
  const range = [min, max].filter((number): number is number => number !== null).join('–');
  const interval = ({ hourly: '小时', daily: '日', weekly: '周', monthly: '月', yearly: '年' } as Record<string, string>)[value(row.interval)];
  // Aggregators can map daily Chinese internship amounts to monthly. Preserve
  // the raw unit and explicitly keep it unverified; never silently convert it.
  return `${value(row.currency) || '币种未注明'} ${range}${interval ? ` / ${interval}` : ' · 单位未注明'}（聚合来源，金额与单位待核验）`;
}
export function normalizeJobSpyRow(row: Row, query: JobSpyQuery, checkedAt: string, input: JobSpySearchInput): CompanyCandidate | undefined {
  const title = plain(row.title); const company = plain(row.company); const jd = plain(row.description);
  const location = plain(row.location); const url = safeSourceUrl(row.job_url, query.source);
  if (!title || !company || jd.length < 40 || jd.length > 60000 || !url || !fitsCity(location, input.city)) return;
  const titleStudent = /实习|校园|校招|应届|毕业生|\bintern(?:ship)?\b|\bgraduate\b/iu.test(title);
  const nativeStudent = /\binternship\b/iu.test(value(row.job_type));
  const jdStudent = /在校|实习生|应届毕业|应届生|校园招聘|currently enrolled|current student|university student|recent graduate/iu.test(jd);
  // An employer mentioning its "intern program" in a senior vacancy is not
  // evidence of student eligibility; require a title/type/student condition.
  if (!(titleStudent || nativeStudent && jdStudent)) return;
  if (/高级|资深|负责人|总监|\bsenior\b|\blead\b|\bdirector\b/iu.test(title)) return;
  if (/(?:至少|要求|需有|具有)\s*[2-9]\s*年(?:以上)?(?:相关)?(?:工作|从业)经验|[2-9]\+?\s*years.{0,25}(?:professional|work) experience/iu.test(jd)) return;
  if (/远程|remote/iu.test(input.city) && !/远程|remote/iu.test(location)) return;
  const direction = input.directions.find(item => matchesJobSpyRole(title, jd, item));
  if (!direction) return;
  const sourceJobId = value(row.id) || new URL(url).pathname.split('/').filter(Boolean).at(-1)!;
  const knownCompany = /腾讯|\btencent\b/iu.test(company) ? 'tencent' : /网易|\bnetease\b/iu.test(company) ? 'netease' : undefined;
  const hash = createHash('sha256').update(`${query.source}:${url}`).digest('hex').slice(0, 18);
  return {
    id: `jobspy_${query.source}_${hash}`, companyId: knownCompany ?? `company_${createHash('sha256').update(company.toLowerCase()).digest('hex').slice(0, 16)}`,
    name: company, industry: plain(row.company_industry) || '行业待核实', role: title,
    rationale: `公开岗位与「${direction.role}」相关，已检查城市、学生身份线索及完整 JD；仍需核对毕业届别和到岗时间。`,
    requirements: [], careerUrl: url, sourceLabel: LABELS[query.source], checkedAt,
    hiringStatus: 'listed', sourceKind: 'jobspy', jdComplete: true, selected: false, location, salary: salaryLabel(row), jobDescription: jd,
    jobType: /实习|intern/iu.test(`${title} ${value(row.job_type)}`) ? '实习' : '校园招聘', sourceJobId,
    ...(Number.isFinite(Date.parse(value(row.date_posted))) ? { publishedAt: new Date(value(row.date_posted)).toISOString() } : {}),
    // The scraped logo is optional and can carry an unsafe URL. Use the same
    // allowlisted company hosts for known logos; unknown companies use initials.
    ...(knownCompany === 'tencent' ? { logoUrl: 'https://join.qq.com/static2/newstatic/image/logo_black.png' } : knownCompany === 'netease' ? { logoUrl: 'https://hr.163.com/favicon.ico' } : {}),
  };
}

async function runBridge(queries: JobSpyQuery[], options: Options): Promise<JobSpyBridgeResult> {
  const python = options.python || process.env.JOBSPY_PYTHON || join(PROJECT, '.venv-jobspy', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) return { results: [], error: 'JobSpy 尚未安装：运行 scripts/setup-jobspy.ps1，或设置 JOBSPY_PYTHON。官网来源仍可使用。' };
  return new Promise(resolve => {
    const results: JobSpyQueryResult[] = []; let pending = ''; let totalBytes = 0; let finished = false; let error: string | undefined;
    let failures: Record<string, number> = {};
    // Deliberately pass no model/API keys, cookie stores or applicant records.
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(python, ['-X', 'utf8', join(PROJECT, 'scripts/jobspy-bridge.py')], { cwd: PROJECT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    function finish(message?: string) {
      if (finished) return; finished = true; clearTimeout(timer);
      resolve({ results, failures, ...(message || error ? { error: message || error } : {}) });
    }
    const timer = setTimeout(() => { child.kill(); finish('JobSpy 查询超时；保留已返回并通过筛选的岗位，未完成的来源可稍后刷新。'); }, options.timeoutMs ?? 45_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > 3_000_000) { child.kill(); finish('JobSpy 返回数据超出上限'); return; }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed.fatal === 'string') { error = parsed.fatal; continue; }
          if (parsed.diagnostics && typeof parsed.diagnostics === 'object') {
            const diagnostics = parsed.diagnostics as { failuresBySource?: Record<string, number> };
            failures = diagnostics.failuresBySource ?? {}; continue;
          }
          if (typeof parsed.id === 'string' && queries.some(query => query.id === parsed.id) && Array.isArray(parsed.rows) && typeof parsed.checkedAt === 'string' && Number.isFinite(Date.parse(parsed.checkedAt))) {
            results.push({ id: parsed.id, rows: parsed.rows.filter(row => row && typeof row === 'object').slice(0, 5), checkedAt: parsed.checkedAt, ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}) });
          }
        } catch { error = 'JobSpy 返回数据无法解析'; }
      }
    });
    child.stderr.on('data', () => { /* Native diagnostics can include URLs; never log private environment or arbitrary output. */ });
    child.on('error', () => finish('JobSpy 解释器无法启动，请检查 JOBSPY_PYTHON 或重新运行安装脚本。'));
    child.on('close', code => finish(code && !error ? 'JobSpy 查询进程退出，来源暂不可用。' : undefined));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ queries }));
  });
}

export function createJobSpyDiscoverer(options: Options = {}): JobSpyDiscoverer {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: JobSpyBridgeResult; expires: number }>();
  const inFlight = new Map<string, Promise<JobSpyBridgeResult>>();
  let activeSearches = 0;
  async function boundedRun(queries: JobSpyQuery[]): Promise<JobSpyBridgeResult> {
    if (activeSearches >= 2) return { results: [], error: '已有公开岗位查询正在进行，请稍后刷新。' };
    activeSearches++;
    try { return await (options.run ? options.run(queries) : runBridge(queries, options)); }
    catch { return { results: [], error: 'JobSpy 公开招聘来源暂不可用' }; }
    finally { activeSearches--; }
  }
  return async input => {
    const queries = buildJobSpyQueries(input);
    if (!queries.length) return { candidates: [], sources: [] };
    const key = JSON.stringify(queries); const cached = cache.get(key);
    let raw: JobSpyBridgeResult;
    if (cached && cached.expires > now()) raw = cached.value;
    else {
      let pending = inFlight.get(key);
      if (!pending) { pending = boundedRun(queries); inFlight.set(key, pending); }
      try { raw = await pending; } finally { inFlight.delete(key); }
      if (!raw.error && raw.results.length === queries.length && !raw.results.some(result => result.error) && !Object.values(raw.failures ?? {}).some(Boolean)) cache.set(key, { value: raw, expires: now() + (options.cacheTtlMs ?? 300_000) });
      if (cache.size > 30) cache.delete(cache.keys().next().value!);
    }
    const candidates: CompanyCandidate[] = []; const sources: JobSourceResult[] = [];
    for (const source of ['linkedin', 'indeed'] as const) {
      const sourceQueries = queries.filter(query => query.source === source);
      if (!sourceQueries.length) continue;
      let scanned = 0; let errors = raw.failures?.[source] ?? 0; const found: CompanyCandidate[] = [];
      for (const query of sourceQueries) {
        const result = raw.results.find(item => item.id === query.id);
        if (!result) { errors++; continue; }
        if (result.error) errors++;
        scanned += result.rows.length;
        for (const row of result.rows) {
          const candidate = normalizeJobSpyRow(row, query, result.checkedAt, input);
          if (candidate) found.push(candidate);
        }
      }
      const unique = [...new Map(found.map(candidate => [candidate.careerUrl, candidate])).values()]; candidates.push(...unique);
      sources.push({ id: `jobspy_${source}`, label: LABELS[source], status: errors || raw.error ? 'error' : 'ok', count: unique.length,
        message: `${raw.error ? `${raw.error} ` : ''}${errors ? '部分公开查询未完成或来源限制访问；' : ''}本次 ${sourceQueries.length} 个英文规范化查询，检查 ${scanned} 条记录，${unique.length} 条通过城市、学生类型及岗位方向筛选。仅查首批公开岗位，缓存最多 5 分钟；聚合薪资待核验。` });
    }
    return { candidates, sources };
  };
}

/** Official source wins duplicate identities; reserve room for newly found
 * employers instead of letting a large official pool exhaust all 40 cards. */
export function mergeJobCandidates(official: CompanyCandidate[], aggregated: CompanyCandidate[], limit = 40): CompanyCandidate[] {
  const normalize = (text: string) => text.toLowerCase().replace(/上海市|上海|shanghai/gu, '上海').replace(/杭州市|杭州|hangzhou/gu, '杭州').replace(/[\s··,，()（）【】\[\]\-—_]/gu, '');
  const seenUrls = new Set<string>(); const seenJobs = new Map<string, string>();
  function identities(candidate: CompanyCandidate): [string, string] {
    let url = candidate.careerUrl;
    try { const parsed = new URL(url); for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|trk|tracking|ref)/iu.test(key)) parsed.searchParams.delete(key); url = parsed.toString(); } catch {}
    const employer = candidate.companyId === 'tencent' || candidate.companyId === 'netease' ? candidate.companyId : normalize(candidate.name).replace(/有限责任公司|股份有限公司|有限公司|co\.?ltd\.?$/gu, '');
    // Location is reduced to the requested city when possible: "上海" and
    // "Pudong, Shanghai, China" represent the same vacancy location.
    const cities = cityTokens(candidate.location ?? '').map(([zh]) => zh).sort().join('/') || normalize(candidate.location ?? '');
    return [url, `${employer}|${normalize(candidate.role)}|${cities}`];
  }
  function unique(list: CompanyCandidate[]): CompanyCandidate[] {
    return list.filter(candidate => {
      const [url, key] = identities(candidate);
      const source = candidate.id.startsWith('official_') ? 'official' : candidate.sourceLabel;
      if (seenUrls.has(url) || seenJobs.has(key) && seenJobs.get(key) !== source) return false;
      seenUrls.add(url); seenJobs.set(key, source); return true;
    });
  }
  const officialUnique = unique(official); const aggregateUnique = unique(aggregated);
  const aggregateReserve = Math.min(aggregateUnique.length, Math.min(12, Math.floor(limit / 2)));
  const selectedOfficial = officialUnique.slice(0, Math.max(0, limit - aggregateReserve));
  return [...selectedOfficial, ...aggregateUnique.slice(0, limit - selectedOfficial.length)];
}
