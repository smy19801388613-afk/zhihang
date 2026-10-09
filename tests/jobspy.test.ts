import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobSpyQueries, createJobSpyDiscoverer, mergeJobCandidates, normalizeJobSpyRow } from '../server/jobspy.ts';
import { createJobDiscoverer } from '../server/job-discovery.ts';
import type { CareerDirection, CompanyCandidate, Profile } from '../shared/types.ts';

const direction: CareerDirection = { id: 'd1', industry: '互联网', role: '法务与合规', rationale: '', transferableSkills: [], gaps: [], entryRequirements: '', salaryContext: '' };
const input = { city: '上海', directions: [direction] };
const checkedAt = '2026-10-05T01:00:00.000Z';
const query = { id: 'q0', source: 'linkedin' as const, term: 'compliance intern', location: 'Shanghai' };
const row = { id: '100', title: '合规实习生', company: '测试基金', location: 'Pudong, Shanghai, China', job_url: 'https://www.linkedin.com/jobs/view/100',
  description: '岗位职责：协助法规检索和合规材料归档，整理法规比较表格。任职要求：法学在校本科生，每周到岗三天，持续三个月。', job_type: 'internship' };
const candidate = (id: string, overrides: Partial<CompanyCandidate> = {}): CompanyCandidate => ({ ...normalizeJobSpyRow({ ...row, job_url: `https://www.linkedin.com/jobs/view/${id}` }, query, checkedAt, input)!, ...overrides });

test('query planner uses English role and city normalization across selected directions, with a six-query bound', () => {
  const queries = buildJobSpyQueries({ city: '上海 / 杭州', directions: [direction, { ...direction, id: 'product', role: '产品经理' }, { ...direction, id: 'algorithm', role: '算法工程师' }] });
  assert.equal(queries.length, 6);
  assert.deepEqual(queries.map(query => [query.term, query.location]), [
    ['compliance intern', 'Shanghai'], ['product manager intern', 'Shanghai'], ['machine learning intern', 'Shanghai'],
    ['compliance intern', 'Hangzhou'], ['product manager intern', 'Hangzhou'], ['machine learning intern', 'Hangzhou'],
  ]);
  assert.deepEqual(buildJobSpyQueries(input).map(query => query.source), ['linkedin', 'indeed']);
});

test('query planner preserves specific privacy and product compliance interests', () => {
  assert.equal(buildJobSpyQueries({ ...input, directions: [{ ...direction, role: '数据合规与隐私保护' }] })[0].term, 'privacy compliance intern');
  assert.equal(buildJobSpyQueries({ ...input, directions: [{ ...direction, role: '制造业产品合规' }] })[0].term, 'product compliance intern');
});

test('normalizer keeps complete JD and provenance, without inferring employer industry or salary', () => {
  const result = normalizeJobSpyRow(row, query, checkedAt, input)!;
  assert.equal(result.jobDescription, row.description); assert.equal(result.checkedAt, checkedAt);
  assert.equal(result.careerUrl, row.job_url); assert.equal(result.salary, '未披露');
  assert.equal(result.industry, '行业待核实'); assert.equal(result.hiringStatus, 'listed'); assert.equal(result.selected, false);
  assert.equal(result.location, 'Pudong, Shanghai, China');
});

test('local verification rejects wrong country/city, social senior jobs, unsafe URL and incomplete JD', () => {
  for (const changed of [
    { location: 'Hangzhou, Zhejiang, China' }, { location: 'Shanghai, United States' }, { location: '' },
    { title: '高级合规经理' }, { title: 'Compliance Manager', job_type: 'fulltime' },
    { description: '法律实习' }, { job_url: 'http://127.0.0.1/private' }, { job_url: 'javascript:alert(1)' },
    { description: `${row.description} 任职要求具有5年以上工作经验。` },
  ]) assert.equal(normalizeJobSpyRow({ ...row, ...changed }, query, checkedAt, input), undefined, JSON.stringify(changed));
});

test('does not turn unknown city or remote preference into all China; English city input still works', () => {
  assert.equal(normalizeJobSpyRow(row, query, checkedAt, { ...input, city: '悉尼' }), undefined);
  assert.equal(normalizeJobSpyRow(row, query, checkedAt, { ...input, city: '远程' }), undefined);
  assert.ok(normalizeJobSpyRow(row, query, checkedAt, { ...input, city: 'Shanghai' }));
});

test('mislabelled fulltime can still be an explicit internship, but generic internship metadata requires JD evidence', () => {
  assert.ok(normalizeJobSpyRow({ ...row, job_type: 'fulltime' }, query, checkedAt, input));
  assert.ok(normalizeJobSpyRow({ ...row, title: '合规研究' }, query, checkedAt, input));
  assert.equal(normalizeJobSpyRow({ ...row, title: '合规研究', description: '开展合同审查及合规研究，整理企业相关法律信息，沟通业务部门需求，编写法律问题分析报告。' }, query, checkedAt, input), undefined);
});

test('privacy/product compliance require evidence and product management does not match incidental design/sales', () => {
  const privacy = { ...input, directions: [{ ...direction, role: '隐私合规' }] };
  assert.equal(normalizeJobSpyRow(row, query, checkedAt, privacy), undefined);
  assert.ok(normalizeJobSpyRow({ ...row, description: `${row.description} 研究个人信息保护和隐私政策。` }, query, checkedAt, privacy));
  const manufacturing = { ...input, directions: [{ ...direction, role: '制造业产品合规' }] };
  assert.equal(normalizeJobSpyRow(row, query, checkedAt, manufacturing), undefined);
  assert.ok(normalizeJobSpyRow({ ...row, description: `${row.description} 整理 RoHS / REACH 产品合规法规。` }, query, checkedAt, manufacturing));
  for (const title of ['产品设计实习生', '产品销售实习生']) assert.equal(normalizeJobSpyRow({ ...row, title }, query, checkedAt, { ...input, directions: [{ ...direction, role: '产品经理' }] }), undefined);
});

test('salary keeps raw currency and unit with verification notice, never converts suspicious internship monthly values', () => {
  const result = normalizeJobSpyRow({ ...row, min_amount: 80, max_amount: 100, currency: 'CN¥', interval: 'monthly' }, query, checkedAt, input)!;
  assert.equal(result.salary, 'CN¥ 80–100 / 月（聚合来源，金额与单位待核验）');
  assert.match(normalizeJobSpyRow({ ...row, min_amount: 100 }, query, checkedAt, input)!.salary!, /币种未注明.*单位未注明/);
});

test('cache retains the original checkedAt and re-applies current filters, without storing user decisions', async () => {
  let calls = 0; let now = Date.parse(checkedAt);
  const discover = createJobSpyDiscoverer({ now: () => now, cacheTtlMs: 2000, run: async queries => {
    calls++; return { results: queries.map(query => ({ id: query.id, rows: query.source === 'linkedin' ? [row] : [], checkedAt })) };
  } });
  const first = await discover(input); first.candidates[0].selected = true;
  now += 1000; const second = await discover(input);
  assert.equal(calls, 1); assert.equal(second.candidates[0].checkedAt, checkedAt); assert.equal(second.candidates[0].selected, false);
  now += 1500; await discover(input); assert.equal(calls, 2);
});

test('failed source is explicit, preserves completed results, and is not cached as successful empty output', async () => {
  let calls = 0;
  const discover = createJobSpyDiscoverer({ run: async () => { calls++; return { results: [{ id: 'q0', rows: [row], checkedAt }], error: '公开查询超时' }; } });
  const result = await discover(input); await discover(input);
  assert.equal(calls, 2); assert.equal(result.candidates.length, 1); assert.ok(result.sources.every(source => source.status === 'error'));
  assert.match(result.sources[0].message!, /超时/);
});

test('native library silent HTTP failure is displayed as source failure, not successful zero matches', async () => {
  const discover = createJobSpyDiscoverer({ run: async queries => ({ results: queries.map(query => ({ id: query.id, rows: [], checkedAt })), failures: { linkedin: 1 } }) });
  const result = await discover(input);
  assert.equal(result.sources[0].status, 'error'); assert.equal(result.sources[1].status, 'ok');
});

test('missing Python environment is actionable and returns no fabricated fallback', async () => {
  const discover = createJobSpyDiscoverer({ python: '/nonexistent/zhihang/python' });
  const result = await discover(input);
  assert.equal(result.candidates.length, 0); assert.equal(result.sources[0].status, 'error');
  assert.match(result.sources[0].message!, /setup-jobspy/);
});

test('merge prefers official duplicate but preserves distinct official postings and reserves other employers', () => {
  const official = Array.from({ length: 45 }, (_, i) => candidate(String(i), {
    id: `official_tencent_${i}`, companyId: 'tencent', name: '腾讯', role: `合规实习生 ${i}`, sourceLabel: '腾讯官网', location: '上海', careerUrl: `https://join.qq.com/post_detail.html?postid=${i}`,
  }));
  const duplicate = candidate('duplicate', { companyId: 'tencent', name: 'Tencent', role: '合规实习生 0' });
  const other = candidate('other'); const merged = mergeJobCandidates(official, [duplicate, other]);
  assert.equal(merged.length, 40); assert.ok(merged.some(item => item.id === other.id)); assert.ok(!merged.some(item => item.id === duplicate.id));
  assert.equal(mergeJobCandidates([official[0], { ...official[0], id: 'official_tencent_999', careerUrl: 'https://join.qq.com/post_detail.html?postid=999' }], []).length, 2);
});

test('discovery passes only search criteria to JobSpy and includes independent failures alongside official results', async () => {
  const profile = { name: 'PRIVATE NAME', email: 'private@example.invalid', city: '上海', experienceText: 'PRIVATE RESUME' } as Profile;
  let received: unknown;
  const discover = createJobDiscoverer({ jobspy: async criteria => { received = criteria; return { candidates: [candidate('new')], sources: [{ id: 'jobspy_linkedin', label: 'LinkedIn', status: 'ok', count: 1 }] }; } });
  const result = await discover({ profile, directions: [direction], companies: [] });
  assert.deepEqual(received, input); assert.doesNotMatch(JSON.stringify(received), /PRIVATE|private@example/);
  assert.equal(result.candidates.length, 1); assert.equal(result.sources[0].id, 'jobspy_linkedin');
});
