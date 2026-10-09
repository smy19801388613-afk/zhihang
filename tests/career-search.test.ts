import test from 'node:test';
import assert from 'node:assert/strict';
import { careerPublicSearchQuery, careerSearchCompanies, careerSearchSnippets, createCareerSearcher } from '../server/career-search.ts';

const body = '这是合成页面中的公开公司业务介绍，描述产品与技术服务，不代表任何实际职位开放。'.repeat(5);
const page = (url: string, text = body) => ({ url, html: `<html><title>合成公司业务</title><main>${text}</main></html>` });
const searchHtml = Array.from({ length: 5 }, (_, i) => `<li class="b_algo"><h2><a href="https://public-${i}.example/news">合成公开来源 ${i}</a></h2><p>这是一段用于测试搜索摘要的公开业务文字，不是已读取的网页正文或真实招聘信息。</p></li>`).join('');

test('search queries contain only public company or industry keywords, not user background', () => {
  assert.equal(careerPublicSearchQuery('我在秘密学校，手机号13800001234，邮箱secret@example.com。搜索腾讯最近业务。', []), '腾讯 公司业务 最新新闻 校园招聘');
  assert.equal(careerPublicSearchQuery('查询小米最新动态', []), '小米 公司业务 最新新闻 校园招聘');
  assert.equal(careerPublicSearchQuery('查询同花顺最近新闻', []), '同花顺 公司业务 最新新闻 校园招聘');
  assert.equal(careerPublicSearchQuery('了解“合成新公司”的业务', []), '合成新公司 公司业务 最新新闻 校园招聘');
  assert.equal(careerPublicSearchQuery('想了解医疗企业最新情况', []), '医疗 公司业务 最新新闻 校园招聘');
  assert.equal(careerPublicSearchQuery('上海，希望成长。', []), undefined);
  assert.equal(careerPublicSearchQuery('搜索“我的13800001234电话”', []), undefined);
  assert.equal(careerPublicSearchQuery('详细介绍这些岗位的日常任务。', []), undefined);
  const oldDirection = { id: 'old', industry: '互联网', role: '法务', rationale: '', transferableSkills: [], gaps: [], entryRequirements: '', salaryContext: '' };
  assert.deepEqual(careerSearchCompanies('查询小米最新动态', [oldDirection]), []);
  assert.deepEqual(careerSearchCompanies('介绍医疗企业最新信息', [oldDirection]), []);
});

test('search results are bounded and distinguish fetched pages from unavailable snippets', async () => {
  const requested: string[] = [];
  const search = createCareerSearcher({ fetchPage: async url => { requested.push(url); if (url.includes('bing.com/search')) return { url, html: searchHtml }; if (url.includes('public-1')) throw new Error('blocked'); return page(url); }, now: () => Date.parse('2026-10-06T00:00:00Z') });
  const result = await search('查询小米最新动态', []);
  assert.equal(requested.filter(url => url.includes('bing.com/search')).length, 1); assert.equal(requested.length, 4);
  assert.equal(result.sources.length, 3); assert.equal(result.sources.filter(source => source.readMethod === 'page').length, 2);
  assert.equal(result.sources.find(source => source.url.includes('public-1'))?.readMethod, 'search_snippet');
  assert.ok(result.sources.every(source => source.fetchedAt === '2026-10-06T00:00:00.000Z' && !source.publishedAt));
  assert.match(result.searchWarning || '', /仅有搜索摘要/);
});

test('private and unsafe links are excluded before any page fetch', () => {
  const unsafe = ['http://public.example/a', 'https://127.0.0.1/a', 'https://10.0.0.2/a', 'javascript:alert(1)'];
  const html = unsafe.map(url => `<li class="b_algo"><h2><a href="${url}">危险链接</a></h2><p>${body}</p></li>`).join('');
  assert.deepEqual(careerSearchSnippets(html, new Date().toISOString()), []);
});

test('unknown companies accept a public homepage without leaking its tracking query', async () => {
  const requested: string[] = [];
  const search = createCareerSearcher({ fetchPage: async url => { requested.push(url); return url.includes('bing.com') ? { url, html: '' } : page(url); } });
  const result = await search('了解这家公司 https://unknown-company.example/about?email=private@example.com', []);
  assert.ok(requested.includes('https://unknown-company.example/about')); assert.ok(requested.every(url => !url.includes('private') && !url.includes('email=')));
  assert.equal(result.sources[0].url, 'https://unknown-company.example/about'); assert.match(result.searchWarning || '', /公开搜索受限/);
});

test('unavailable public search keeps useful official reading and reports the limitation', async () => {
  const search = createCareerSearcher({ fetchPage: async url => { if (url.includes('bing.com')) throw new Error('challenge'); return page(url, `腾讯公开业务说明。${body}`); } });
  const result = await search('查询腾讯最新业务', []);
  assert.ok(result.sources.some(source => source.url.includes('tencent.com'))); assert.match(result.searchWarning || '', /公开搜索受限/);
  assert.ok(result.sources.every(source => source.readMethod === 'page'));
});
