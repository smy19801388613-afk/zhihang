import type { CareerDirection, CompanyCandidate, JobDiscoveryResult, JobSourceResult, Profile } from '../shared/types.ts';
import { createJobSpyDiscoverer, mergeJobCandidates, type JobSpyDiscoverer } from './jobspy.ts';

/** Public, read-only company endpoints. No model, account cookie or applicant data is sent. */
export interface DiscoveryInput { profile: Profile; directions: CareerDirection[]; companies: CompanyCandidate[] }
interface Options {
  fetch?: typeof fetch; now?: () => number; requestTimeoutMs?: number; totalTimeoutMs?: number;
  cacheTtlMs?: number; requestIntervalMs?: number;
  jobspy?: JobSpyDiscoverer | false;
}
type RecordValue = Record<string, unknown>;
type CachedResponse = { value: unknown; fetchedAt: string; expiresAt: number };
const TENCENT = 'https://join.qq.com';
const NETEASE = 'https://hr.163.com';
const TENCENT_LOGO = `${TENCENT}/static2/newstatic/image/logo_black.png`;
const CITY_NAMES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '武汉', '西安', '重庆', '苏州', '天津', '厦门', '青岛', '长沙', '合肥', '郑州', '济南', '福州', '宁波', '珠海', '东莞', '佛山', '大连', '沈阳', '香港', '澳门', '台北'];
const STUDENT = /实习|应届|毕业生|校园|校招|intern|graduate/iu;
const MAX_QUERIES = 2;
const MAX_DETAILS = 10;
const MAX_RESPONSE_BYTES = 2_000_000;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('招聘来源返回了无法识别的数据结构');
  return value as RecordValue;
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''; }
function clean(value: unknown): string {
  return text(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
    .replace(/<br\s*\/?\s*>|<\/p>|<\/li>/giu, '\n').replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;|&#160;/gu, ' ').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/\r\n?/gu, '\n').replace(/\n[ \t]*\n[ \t]*\n/gu, '\n\n').trim();
}
function companyKey(company: CompanyCandidate): string {
  if (company.companyId) return company.companyId;
  if (/腾讯/u.test(company.name)) return 'tencent';
  if (/网易/u.test(company.name)) return 'netease';
  return company.id;
}

// Explicit role families keep incidental JD keywords from making an unrelated technical job a law match.
const ROLE_RULES = [
  { trigger: /法务|合规|法律|隐私|知识产权|政策/u, queries: ['合规', '法务'], title: /合规|法务|法律|隐私|知识产权|政策|安全策略/u },
  { trigger: /产品/u, queries: ['产品'], title: /产品经理|产品策划|产品运营|产品助理|游戏策划/u },
  { trigger: /运营/u, queries: ['运营'], title: /运营/u },
  { trigger: /数据分析|商业分析|经营分析/u, queries: ['数据分析', '商业分析'], title: /数据分析|商业分析|经营分析|商业策略/u },
  { trigger: /前端/u, queries: ['前端'], title: /前端|web开发/iu },
  { trigger: /算法|人工智能|机器学习/u, queries: ['算法'], title: /算法|机器学习|人工智能/u },
  { trigger: /后端|服务端|软件|开发|工程师/u, queries: ['开发'], title: /开发|工程|研发|软件/u },
  { trigger: /设计/u, queries: ['设计'], title: /设计/u },
  { trigger: /市场|营销|品牌|商务/u, queries: ['市场', '商务'], title: /市场|营销|品牌|商务/u },
  { trigger: /人力|招聘|组织/u, queries: ['人力'], title: /人力|招聘|组织/u },
  { trigger: /财务|审计|税务/u, queries: ['财务'], title: /财务|审计|税务/u },
  { trigger: /供应链|采购|物流/u, queries: ['供应链', '采购'], title: /供应链|采购|物流/u },
];
function termsFor(direction: CareerDirection): string[] {
  const rule = ROLE_RULES.find(rule => rule.trigger.test(direction.role));
  if (rule) return rule.queries;
  return direction.role.split(/[\s/、，,（()）·—-]+/u).map(part => part.replace(/实习生?|校招|应届|助理|支持|岗位|方向/gu, '').trim()).filter(part => part.length >= 2).slice(0, 2);
}
function queriesFor(directions: CareerDirection[]): string[] {
  const terms = directions.map(termsFor);
  // Give each selected direction its first term before spending the small request budget on synonyms.
  return [...new Set([...terms.map(list => list[0]), ...terms.flatMap(list => list.slice(1))].filter((term): term is string => Boolean(term)))].slice(0, MAX_QUERIES);
}
function matchesRole(title: string, description: string, direction: CareerDirection): boolean {
  const rule = ROLE_RULES.find(rule => rule.trigger.test(direction.role));
  if (rule) {
    if (!rule.title.test(title)) return false;
    // A privacy direction must actually mention privacy/data compliance, not any infrastructure licence job.
    if (/隐私|数据合规|个人信息/u.test(direction.role) && !/隐私|数据合规|个人信息|数据保护/u.test(`${title}\n${description}`)) return false;
    return true;
  }
  return termsFor(direction).some(term => title.toLowerCase().includes(term.toLowerCase()));
}
function matchingDirection(title: string, description: string, directions: CareerDirection[]): CareerDirection | undefined {
  return directions.find(direction => matchesRole(title, description, direction));
}
function wantedCities(city: string): string[] {
  const cities = CITY_NAMES.filter(name => city.includes(name));
  if (cities.length || !city.trim() || /不限|全国|待定|未定|都可以|不限制|灵活|无偏好|任意|无要求/u.test(city)) return cities;
  // An unknown city or remote preference must not silently become "all locations".
  return city.split(/[、,，/\s]+/u).map(value => value.trim()).filter(Boolean).slice(0, 5);
}
function locationMatches(location: string, cities: string[]): boolean { return !cities.length || cities.some(city => location.includes(city)); }
function requirements(value: unknown): string[] { return clean(value).split(/\n+/u).map(item => item.trim()).filter(Boolean).slice(0, 12); }
function studentLabel(value: string): string { return /实习|intern/iu.test(value) ? '实习' : '校园招聘'; }
function salary(value: unknown): string { return clean(value).slice(0, 100) || '未披露'; }

/** Factory exposes only transport/time injection for deterministic tests; production uses fixed allowlisted hosts. */
export function createJobDiscoverer(options: Options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedResponse>();
  const inFlight = new Map<string, Promise<CachedResponse>>();
  let nextRequestAt = 0;
  const interval = options.requestIntervalMs ?? 300;
  const jobspy = options.jobspy === false || process.env.JOBSPY_ENABLED === 'false' ? undefined : options.jobspy ?? createJobSpyDiscoverer({ now: options.now });

  async function request(url: string, body: RecordValue | undefined, totalSignal: AbortSignal): Promise<CachedResponse> {
    const parsed = new URL(url);
    if (![TENCENT, NETEASE].includes(parsed.origin)) throw new Error('招聘来源地址不在允许范围');
    const key = `${url}|${body ? JSON.stringify(body) : ''}`;
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now()) return existing;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const delay = Math.max(0, nextRequestAt - Date.now());
      nextRequestAt = Math.max(Date.now(), nextRequestAt) + interval;
      if (delay) await new Promise<void>((resolve, reject) => {
        if (totalSignal.aborted) { reject(new Error('招聘查询已超时')); return; }
        const timer = setTimeout(done, delay);
        function done() { totalSignal.removeEventListener('abort', abort); resolve(); }
        function abort() { clearTimeout(timer); reject(new Error('招聘查询已超时')); }
        totalSignal.addEventListener('abort', abort, { once: true });
      });
      const requestSignal = AbortSignal.any([totalSignal, AbortSignal.timeout(options.requestTimeoutMs ?? 6000)]);
      const response = await fetcher(url, {
        method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: requestSignal, redirect: 'error',
      });
      if (!response.ok) throw new Error(`招聘来源暂不可用（HTTP ${response.status}）`);
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('招聘来源响应过大');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('招聘来源未返回数据');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('招聘来源响应过大'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('招聘来源返回非 JSON 数据，可能需要人工访问'); }
      const cached = { value, fetchedAt: new Date(now()).toISOString(), expiresAt: now() + (options.cacheTtlMs ?? 5 * 60_000) };
      cache.set(key, cached);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return cached;
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { inFlight.delete(key); }
  }

  async function tencent(company: CompanyCandidate, directions: CareerDirection[], cities: string[], signal: AbortSignal) {
    const queries = queriesFor(directions);
    const postings = new Map<string, RecordValue>();
    const found: CompanyCandidate[] = []; let errors = 0; let scanned = 0;
    for (const keyword of queries) {
      const response = await request(`${TENCENT}/api/v1/position/searchPosition`, {
        keyword: keyword.slice(0, 30), pageIndex: 1, pageSize: 30, workCountryType: 1,
        bgList: [], workCityList: [], recruitCityList: [], positionFidList: [],
      }, signal);
      const envelope = record(response.value);
      if (envelope.status !== 0) throw new Error('腾讯校招接口返回异常，请前往官网核验');
      const data = record(envelope.data);
      if (!Array.isArray(data.positionList)) throw new Error('腾讯校招岗位列表结构已变化');
      for (const item of data.positionList.slice(0, 30)) {
        const post = record(item); scanned++;
        const id = text(post.postId); const title = clean(post.positionTitle);
        const label = `${text(post.projectName)} ${text(post.recruitLabelName)}`;
        if (!/^\d+$/u.test(id) || !title || !STUDENT.test(label) || !locationMatches(text(post.workCities), cities)) continue;
        if (!directions.some(direction => {
          const rule = ROLE_RULES.find(rule => rule.trigger.test(direction.role));
          return rule ? rule.title.test(title) : matchesRole(title, '', direction);
        })) continue;
        postings.set(id, post);
      }
    }
    for (const [id, post] of [...postings].slice(0, MAX_DETAILS)) {
      try {
        const response = await request(`${TENCENT}/api/v1/jobDetails/getJobDetailsByPostId?postId=${encodeURIComponent(id)}`, undefined, signal);
        const envelope = record(response.value);
        if (envelope.status !== 0) throw new Error('岗位详情不可用');
        const detail = record(envelope.data);
        if (text(detail.postId) !== id) throw new Error('岗位详情编号不匹配');
        const title = clean(detail.title) || clean(post.positionTitle);
        const description = clean(detail.desc); const requirement = clean(detail.request);
        if (!description || !requirement) throw new Error('岗位详情不完整');
        const label = `${text(detail.projectName)} ${text(detail.recruitLabelName)}`;
        if (!STUDENT.test(label)) continue;
        const jd = `岗位职责\n${description}\n\n任职要求\n${requirement}`;
        const direction = matchingDirection(title, jd, directions);
        const location = Array.isArray(detail.workCityList) ? detail.workCityList.map(text).filter(Boolean).join(' / ') : text(post.workCities);
        if (!direction || !locationMatches(location, cities)) continue;
        found.push({
          id: `official_tencent_${id}`, companyId: 'tencent', name: company.name, industry: company.industry,
          role: title, rationale: `官网职责与「${direction.role}」方向相关；请结合完整 JD 核对毕业届别、专业及实习时长。`,
          requirements: requirements(requirement), careerUrl: `${TENCENT}/post_detail.html?postid=${encodeURIComponent(id)}`,
          sourceLabel: '腾讯校园招聘官网', sourceKind: 'official_job', jdComplete: true, checkedAt: response.fetchedAt, hiringStatus: 'listed', selected: false,
          logoUrl: TENCENT_LOGO, location: location || '地点未披露', salary: salary(detail.salary), jobDescription: jd.slice(0, 16000),
          jobType: studentLabel(label), sourceJobId: id,
        });
      } catch { errors++; if (signal.aborted) break; }
    }
    return { candidates: found, scanned, errors, queries: queries.length };
  }

  async function netease(company: CompanyCandidate, directions: CareerDirection[], cities: string[], signal: AbortSignal) {
    const queries = queriesFor(directions);
    const found: CompanyCandidate[] = []; let scanned = 0;
    for (const keyword of queries) {
      // Verified against the official job-list bundle: searchStr/pageNumber silently return unfiltered social jobs.
      const response = await request(`${NETEASE}/api/hr163/position/queryPage`, {
        currentPage: 1, pageSize: 30, keyword, workType: '1', sortType: 2,
      }, signal);
      const envelope = record(response.value);
      if (envelope.code !== 200) throw new Error('网易招聘接口返回异常，请前往官网核验');
      const data = record(envelope.data);
      if (!Array.isArray(data.list)) throw new Error('网易招聘岗位列表结构已变化');
      for (const item of data.list.slice(0, 30)) {
        const post = record(item); scanned++;
        const id = text(post.id); const title = clean(post.name);
        const description = clean(post.description); const requirement = clean(post.requirement);
        // workType=1 is the official internship filter; reject social results even if server ignores the request.
        if (!/^\d+$/u.test(id) || text(post.workType) !== '1' || !title || !description || !requirement) continue;
        const location = Array.isArray(post.workPlaceNameList) ? post.workPlaceNameList.map(text).filter(Boolean).join(' / ') : '';
        if (!locationMatches(location, cities)) continue;
        const jd = `岗位职责\n${description}\n\n任职要求\n${requirement}`;
        const direction = matchingDirection(title, jd, directions);
        if (!direction) continue;
        found.push({
          id: `official_netease_${id}`, companyId: 'netease', name: company.name, industry: company.industry,
          role: title, rationale: `官网职责与「${direction.role}」方向相关；请按 JD 核对毕业届别、专业、城市和实习时长。`,
          requirements: requirements(requirement), careerUrl: `${NETEASE}/job-detail.html?id=${encodeURIComponent(id)}&lang=zh`,
          sourceLabel: '网易招聘官网 · 实习岗位', sourceKind: 'official_job', jdComplete: true, checkedAt: response.fetchedAt, hiringStatus: 'listed', selected: false,
          logoUrl: `${NETEASE}/favicon.ico`, location: location || '地点未披露', salary: salary(post.salary), jobDescription: jd.slice(0, 16000),
          jobType: /校招项目|届校招|应届毕业生/u.test(`${title}\n${description}`) ? '校园招聘' : '实习', sourceJobId: id,
        });
      }
    }
    return { candidates: [...new Map(found.map(candidate => [candidate.id, candidate])).values()].slice(0, 20), scanned, errors: 0, queries: queries.length };
  }

  return async function discover(input: DiscoveryInput): Promise<JobDiscoveryResult> {
    const fetchedAt = new Date(now()).toISOString(); const candidates: CompanyCandidate[] = []; const sources: JobSourceResult[] = [];
    const signal = AbortSignal.timeout(options.totalTimeoutMs ?? 25_000);
    // The bridge receives only search criteria. It runs alongside official
    // sources under its own bounded process deadline, without resume contents.
    const aggregate = jobspy ? jobspy({ city: input.profile.city, directions: input.directions }).catch(() => ({ candidates: [], sources: [{ id: 'jobspy', label: 'JobSpy 公开岗位', status: 'error' as const, count: 0, message: '公开岗位查询暂不可用，官网结果仍可使用。' }] })) : Promise.resolve({ candidates: [], sources: [] });
    const companies = [...new Map(input.companies.map(company => [companyKey(company), company])).entries()];
    const cities = wantedCities(input.profile.city);
    for (const [id, company] of companies.slice(0, 20)) {
      if (!['tencent', 'netease'].includes(id)) {
        sources.push({ id, label: `${company.name}官网`, status: 'unsupported', count: 0, message: '尚未接入此公司岗位采集，请通过官网入口查看。' });
        continue;
      }
      const label = id === 'tencent' ? '腾讯校园招聘官网' : '网易招聘官网 · 实习岗位';
      if (!input.directions.length) {
        sources.push({ id, label, status: 'ok', count: 0, message: '请先选择职业方向。' }); continue;
      }
      try {
        const result = await (id === 'tencent' ? tencent : netease)(company, input.directions, cities, signal);
        candidates.push(...result.candidates);
        const limitation = `每个方向关键词仅查首批岗位，本次共检索 ${result.queries} 个关键词、检查 ${result.scanned} 条记录；缓存最长 5 分钟。`;
        sources.push({ id, label, status: result.errors && !result.candidates.length ? 'error' : 'ok', count: result.candidates.length,
          message: `${result.candidates.length ? '已获取官网当前列出的校招 / 实习岗位。' : '本次未找到同时符合所选方向和城市的校招 / 实习岗位，不代表官网没有其他机会。'}${result.errors ? ` ${result.errors} 个岗位详情未能核验，已跳过。` : ''}${limitation}` });
      } catch (error) {
        const message = signal.aborted ? '本次招聘查询超时，请稍后刷新或访问官网。' : error instanceof Error && /^(招聘来源|腾讯校招|网易招聘)/u.test(error.message) ? error.message : '官网连接暂不可用，请稍后刷新或访问官网。';
        sources.push({ id, label, status: 'error', count: 0, message });
      }
    }
    const additional = await aggregate;
    return { candidates: mergeJobCandidates(candidates, additional.candidates), sources: [...sources, ...additional.sources], fetchedAt };
  };
}

export const discoverJobs = createJobDiscoverer();
