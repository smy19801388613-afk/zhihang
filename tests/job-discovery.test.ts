import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobDiscoverer } from '../server/job-discovery.ts';
import type { CompanyCandidate, CareerDirection, Profile } from '../shared/types.ts';

const profile: Profile = { name: 'PRIVATE NAME', email: 'private@example.invalid', phone: 'PRIVATE PHONE', school: 'PRIVATE SCHOOL', education: '本科', graduation: '2027', city: '上海', availability: '每周三天', targetRole: '', experienceText: 'PRIVATE RESUME', facts: [] };
const direction: CareerDirection = { id: 'd1', industry: '互联网', role: '法务与合规', rationale: '', transferableSkills: [], gaps: [], entryRequirements: '', salaryContext: '' };
const company: CompanyCandidate = { id: 'c1', companyId: 'tencent', name: '腾讯', industry: '互联网与数字服务', role: '法务', rationale: '', requirements: [], careerUrl: 'https://join.qq.com/', sourceLabel: '官网入口', checkedAt: '', hiringStatus: 'unverified', selected: false };
const input = () => ({ profile, directions: [direction], companies: [company] });
const post = (id: string, title = '法务实习生', city = '上海') => ({ postId: id, positionTitle: title, workCities: city, projectName: '应届实习', recruitLabelName: '应届实习' });
const detail = (id: string) => ({ postId: id, title: '法务实习生', desc: '协助合同审查与合规研究。', request: '1、本科及以上学历\n2、法学专业', workCityList: ['上海'], projectName: '应届实习', recruitLabelName: '实习' });
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }); }

test('official discovery fetches JD, uses stable vacancy IDs and discloses missing salary without sending personal data', async () => {
  const sent: Array<{ url: string; body: string }> = [];
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, now: () => 1790950000000, fetch: async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') });
    return String(url).includes('searchPosition') ? json({ status: 0, data: { positionList: [post('101'), post('102')] } }) : json({ status: 0, data: detail(new URL(String(url)).searchParams.get('postId')!) });
  } });
  const result = await discover(input());
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map(candidate => candidate.id), ['official_tencent_101', 'official_tencent_102']);
  const candidate = result.candidates[0];
  assert.equal(candidate.salary, '未披露'); assert.equal(candidate.hiringStatus, 'listed'); assert.equal(candidate.selected, false);
  assert.equal(candidate.sourceJobId, '101'); assert.equal(candidate.checkedAt, new Date(1790950000000).toISOString());
  assert.equal(candidate.careerUrl, 'https://join.qq.com/post_detail.html?postid=101');
  assert.match(candidate.jobDescription!, /合同审查/); assert.equal(candidate.jobType, '实习');
  assert.equal(sent.length, 4); assert.doesNotMatch(JSON.stringify(sent), /PRIVATE|private@example/);
});

test('filters senior jobs, wrong cities, irrelevant titles and incidental compliance keywords', async () => {
  const details: string[] = [];
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async url => {
    if (String(url).includes('searchPosition')) return json({ status: 0, data: { positionList: [post('1', '法务', '北京'), post('2', '数据工程'), { ...post('3'), projectName: '社会招聘', recruitLabelName: '社招' }, post('4')] } });
    details.push(String(url)); return json({ status: 0, data: detail('4') });
  } });
  const result = await discover(input());
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].sourceJobId, '4'); assert.equal(details.length, 1);
});

test('privacy direction requires actual privacy evidence and never treats all compliance jobs as privacy', async () => {
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async url => String(url).includes('searchPosition')
    ? json({ status: 0, data: { positionList: [post('1', '资质合规管理'), post('2', '数据合规实习')] } })
    : json({ status: 0, data: { ...detail(new URL(String(url)).searchParams.get('postId')!), title: String(url).endsWith('1') ? '资质合规管理' : '数据合规实习', desc: String(url).endsWith('1') ? '建设工程资质报批。' : '个人信息与隐私保护研究。' } }) });
  const result = await discover({ ...input(), directions: [{ ...direction, role: '数据合规与隐私保护' }] });
  assert.deepEqual(result.candidates.map(candidate => candidate.sourceJobId), ['2']);
});

test('cache preserves original checkedAt, applies fresh city filtering and expires without modifying user decisions', async () => {
  let now = 1790950000000; let calls = 0;
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, cacheTtlMs: 5000, now: () => now, fetch: async url => {
    calls++; return String(url).includes('searchPosition') ? json({ status: 0, data: { positionList: [post('101')] } }) : json({ status: 0, data: detail('101') });
  } });
  const first = await discover(input()); first.candidates[0].selected = true;
  now += 1000; const second = await discover(input());
  assert.equal(calls, 3); assert.equal(second.candidates[0].checkedAt, first.candidates[0].checkedAt); assert.equal(second.candidates[0].selected, false);
  const third = await discover({ ...input(), profile: { ...profile, city: '北京' } }); assert.equal(third.candidates.length, 0); assert.equal(calls, 3);
  now += 6000; await discover(input()); assert.equal(calls, 6);
});

test('source failure and unsupported companies are explicit and never become old or fabricated jobs', async () => {
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async () => new Response('', { status: 403 }) });
  const result = await discover({ ...input(), companies: [company, { ...company, id: 'm1', companyId: 'midea', name: '美的' }] });
  assert.equal(result.candidates.length, 0); assert.equal(result.sources[0].status, 'error'); assert.match(result.sources[0].message!, /403/);
  assert.equal(result.sources[1].status, 'unsupported');
});

test('bad detail identity, unavailable JD and malformed source envelopes never produce verified cards', async () => {
  for (const value of [{ status: 1 }, { status: 0, data: {} }, { status: 0, data: { ...detail('wrong') } }, { status: 0, data: { ...detail('1'), request: '' } }]) {
    const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async url => String(url).includes('searchPosition') ? json({ status: 0, data: { positionList: [post('1')] } }) : json(value) });
    const result = await discover(input()); assert.equal(result.candidates.length, 0); assert.equal(result.sources[0].status, 'error');
  }
});

test('limits source requests and details even when source returns too many postings', async () => {
  let calls = 0;
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async url => {
    calls++;
    return String(url).includes('searchPosition') ? json({ status: 0, data: { positionList: Array.from({ length: 80 }, (_, i) => post(String(i + 1))) } }) : json({ status: 0, data: detail(new URL(String(url)).searchParams.get('postId')!) });
  } });
  const result = await discover(input()); assert.equal(result.candidates.length, 10); assert.equal(calls, 12);
});

test('total timeout ends discovery with diagnostics and no retry', async () => {
  let calls = 0;
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, totalTimeoutMs: 25, requestTimeoutMs: 100, fetch: async (_url, init) => {
    calls++; await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 500); init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true }); }); return json({});
  } });
  const start = Date.now(); const result = await discover(input());
  assert.equal(result.sources[0].status, 'error'); assert.match(result.sources[0].message!, /超时/); assert.equal(calls, 1); assert.ok(Date.now() - start < 400);
});

test('NetEase uses current official keyword/currentPage/workType contract and keeps only matching internships', async () => {
  const bodies: unknown[] = [];
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async (url, init) => {
    assert.equal(String(url), 'https://hr.163.com/api/hr163/position/queryPage');
    bodies.push(JSON.parse(String(init?.body)));
    const base = { name: '法务实习生', workType: '1', description: '<p>协助合同审查</p><script>alert(1)</script>', requirement: '法学专业\n每周4天', workPlaceNameList: ['上海市'] };
    return json({ code: 200, data: { list: [{ ...base, id: 100 }, { ...base, id: 101, workType: '0' }, { ...base, id: 102, name: '算法实习生', description: '算法需遵守合规要求' }, { ...base, id: 103, workPlaceNameList: ['北京市'] }] } });
  } });
  const result = await discover({ ...input(), companies: [{ ...company, companyId: 'netease', name: '网易' }] });
  assert.equal(result.candidates.length, 1); const candidate = result.candidates[0];
  assert.equal(candidate.id, 'official_netease_100'); assert.equal(candidate.salary, '未披露'); assert.equal(candidate.jobType, '实习');
  assert.equal(candidate.careerUrl, 'https://hr.163.com/job-detail.html?id=100&lang=zh'); assert.doesNotMatch(candidate.jobDescription!, /script|alert|<p>/);
  assert.deepEqual(bodies[0], { currentPage: 1, pageSize: 30, keyword: '合规', workType: '1', sortType: 2 });
  assert.equal(result.sources[0].status, 'ok');
});

test('NetEase request envelope errors are reported, not silently shown as no jobs', async () => {
  for (const value of [{ code: 403, data: null }, { code: 200, data: { changedList: [] } }]) {
    const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async () => json(value) });
    const result = await discover({ ...input(), companies: [{ ...company, companyId: 'netease', name: '网易' }] });
    assert.equal(result.candidates.length, 0); assert.equal(result.sources[0].status, 'error');
  }
});

test('query budget prioritizes each direction and algorithm engineers do not become generic development searches', async () => {
  const keywords: string[] = [];
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async (_url, init) => {
    keywords.push(JSON.parse(String(init?.body)).keyword); return json({ status: 0, data: { positionList: [] } });
  } });
  await discover({ ...input(), directions: [direction, { ...direction, id: 'algorithm', role: '算法工程师' }] });
  assert.deepEqual(keywords, ['合规', '算法']);
});

test('product direction does not accidentally recommend product design or commercial sales', async () => {
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async url => String(url).includes('searchPosition')
    ? json({ status: 0, data: { positionList: [post('1', '产品体验设计'), post('2', '技术产品商务培训生'), post('3', '产品经理')] } })
    : json({ status: 0, data: { ...detail('3'), title: '产品经理' } }) });
  const result = await discover({ ...input(), directions: [{ ...direction, role: '产品经理' }] });
  assert.deepEqual(result.candidates.map(candidate => candidate.sourceJobId), ['3']);
});

test('unrecognized cities and remote-only preferences never silently match all domestic locations', async () => {
  const discover = createJobDiscoverer({ jobspy: false, requestIntervalMs: 0, fetch: async url => String(url).includes('searchPosition')
    ? json({ status: 0, data: { positionList: [post('1')] } }) : json({ status: 0, data: detail('1') }) });
  for (const city of ['远程', '悉尼']) {
    const result = await discover({ ...input(), profile: { ...profile, city } }); assert.equal(result.candidates.length, 0);
  }
});
