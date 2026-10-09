import type { CareerDirection, ResearchSource } from '../shared/types.ts';
import { createHash } from 'node:crypto';
import { COMPANY_CATALOG, categoriesForIndustry } from './company-catalog.ts';
import { createCompanyResearcher, pageText, type ResearchOptions } from './company-research.ts';
import { fetchResearchPage, publicHttpsUrl, type FetchedPage } from './research-fetch.ts';

export interface CareerSearchEvidence { sources: ResearchSource[]; searchWarning?: string }
const publicNames = ['小米', '百度', '京东', '美团', '拼多多', '比亚迪', '宁德时代', '大疆', '联想', '携程', '快手', '小红书', '哔哩哔哩', '特斯拉', '微软', '亚马逊', '谷歌', '苹果'];
const publicIndustries = ['人工智能', '医疗', '医药', '生物科技', '教育', '能源', '物流', '交通', '房地产', '农业', '文旅', '酒店', '航空', '互联网', '制造', '金融', '咨询', '消费品'];
const aliases: Record<string, RegExp> = {
  tencent: /腾讯|tencent|微信/iu, netease: /网易|netease/iu, bytedance: /字节|bytedance|抖音/iu,
  alibaba: /阿里|alibaba|淘宝/iu, huawei: /华为|huawei/iu, midea: /美的|midea/iu,
  pwc: /普华永道|pwc/iu, deloitte: /德勤|deloitte/iu, unilever: /联合利华|unilever/iu,
  pg: /宝洁|procter|p&g/iu, cmb: /招商银行|招行/iu,
};

/** Search planning uses allowlisted public names only, never personal text or arbitrary URLs. */
export function careerSearchCompanies(latest: string, directions: CareerDirection[]) {
  if (!/最新|实时|目前|现在|近况|最近|新闻|动态|大厂|公司|企业|腾讯|网易|字节|阿里|华为|美的|德勤|宝洁|招行|tencent|netease|bytedance|alibaba|huawei/iu.test(latest)) return [];
  const named = COMPANY_CATALOG.filter(company => aliases[company.id]?.test(latest));
  if (named.length) return named.slice(0, 2);
  if (publicNames.some(name => latest.includes(name)) || requestedCompanyName(latest) || /https:\/\//i.test(latest)) return [];
  // "How do I start company selection?" is a workflow question, not a request to fetch news.
  if (!/最新|实时|近况|最近|新闻|动态|大厂|哪些|哪家|了解|介绍|研究/u.test(latest)) return [];
  const categories = categoriesForIndustry(latest);
  if (!categories.length && publicIndustries.some(industry => latest.includes(industry))) return [];
  if (!categories.length && /大厂/u.test(latest)) categories.push('internet');
  if (!categories.length) for (const direction of directions) categories.push(...categoriesForIndustry(direction.industry));
  return COMPANY_CATALOG.filter(company => categories.includes(company.category)).slice(0, 2);
}

const sourceId = (url: string) => `career_${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
function requestedCompanyName(latest: string): string | undefined {
  const name = latest.match(/(?:搜索|查询|查一下|搜一下|查查|了解|介绍|研究)\s*[“「"']([^”」"'\n]{2,40})[”」"']/u)?.[1]
    || latest.match(/(?:搜索|查询|查一下|搜一下|查查)\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·&（）() -]{1,30}?)(?=的?(?:最近|最新|近况|业务|招聘|新闻|怎么样|是什么|$))/u)?.[1];
  if (!name || /我|简历|电话|邮箱|同学|学校|专业|项目|背景|经历|资料|附件|\d{6}|[@:/]/u.test(name)) return;
  return name.trim();
}
function explicitPublicUrl(latest: string): string | undefined {
  const candidate = latest.match(/https:\/\/[^\s<>"'，。；！？）]+/u)?.[0];
  if (!candidate) return;
  try {
    const url = publicHttpsUrl(candidate);
    if (/(?:^|\/)(?:login|signin|account|chat|inbox|messages|passport|private)(?:\/|$)/i.test(url.pathname)) return;
    // Tracking and form/query values are not needed for a public company homepage.
    url.search = ''; return url.href;
  } catch { return; }
}
export function careerPublicSearchQuery(latest: string, directions: CareerDirection[]): string | undefined {
  const named = COMPANY_CATALOG.find(company => aliases[company.id]?.test(latest))?.name || publicNames.find(name => latest.includes(name)) || requestedCompanyName(latest);
  const homepage = explicitPublicUrl(latest);
  const industry = publicIndustries.find(word => latest.includes(word));
  const requested = /搜索|查查|查询|查一下|搜一下|最新|实时|近况|最近|新闻|动态|大厂|哪些公司|哪家|了解|介绍|研究/u.test(latest);
  if (!requested && !homepage) return;
  if (!named && !homepage && !/搜索|查查|查询|查一下|搜一下|最新|实时|近况|最近|新闻|动态|大厂|公司|企业/u.test(latest)) return;
  const keyword = named || (homepage ? new URL(homepage).hostname : industry || (/大厂/u.test(latest) ? '互联网' : publicIndustries.find(word => directions.some(direction => direction.industry.includes(word)))));
  return keyword ? `${keyword} 公司业务 最新新闻 校园招聘` : undefined;
}

function resultUrl(value: string): string | undefined {
  try {
    let url = new URL(value.replace(/&amp;/g, '&'), 'https://www.bing.com');
    if (url.hostname.endsWith('bing.com') && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u');
      if (!encoded?.startsWith('a1')) return;
      url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    }
    if (url.hostname.endsWith('bing.com') || url.hostname.endsWith('microsoft.com') && url.pathname.includes('privacy')) return;
    return publicHttpsUrl(url.href).href;
  } catch { return; }
}
export function careerSearchSnippets(html: string, fetchedAt: string): ResearchSource[] {
  const items = html.match(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
  const sources: ResearchSource[] = [];
  for (const item of items.slice(0, 8)) {
    const heading = item.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
    const link = heading?.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const url = link && resultUrl(link[1]); const title = link && pageText(link[2]);
    const excerpt = pageText(item.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
    if (url && title && excerpt.length >= 20 && !sources.some(source => source.url === url)) sources.push({ id: sourceId(url), title: title.slice(0, 180), url, fetchedAt, excerpt: excerpt.slice(0, 700), readMethod: 'search_snippet' });
    if (sources.length === 3) break;
  }
  return sources;
}

function sourceFromPage(page: FetchedPage, fetchedAt: string): ResearchSource | undefined {
  const url = publicHttpsUrl(page.url);
  if (/(?:^|\/)(?:login|signin|account|chat|inbox|messages|passport|private)(?:\/|$)/i.test(url.pathname)) return;
  const excerpt = pageText(page.html);
  if (excerpt.length < 100 || /验证码|访问受限|access denied|verify you are human/i.test(excerpt.slice(0, 350))) return;
  const rawDate = page.html.match(/(?:"datePublished"\s*:\s*"|(?:property|name)=["']article:published_time["'][^>]*content=["'])(\d{4}-\d{2}-\d{2}[^"']*)/i)?.[1];
  const publishedAt = rawDate && Number.isFinite(Date.parse(rawDate)) ? rawDate.slice(0, 10) : undefined;
  const title = pageText(page.html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || new URL(page.url).hostname).slice(0, 180);
  return { id: sourceId(page.url), title, url: page.url, fetchedAt, ...(publishedAt ? { publishedAt } : {}), excerpt: excerpt.slice(0, 1000), readMethod: 'page' };
}

export function createCareerSearcher(options: ResearchOptions = {}) {
  // This reader never invokes a model and receives only fixed catalog identifiers.
  const research = createCompanyResearcher({}, { ...options, totalTimeoutMs: options.totalTimeoutMs ?? 8000 });
  const fetchPage = options.fetchPage || fetchResearchPage;
  return async (latest: string, directions: CareerDirection[]): Promise<CareerSearchEvidence> => {
    const companies = careerSearchCompanies(latest, directions);
    const query = careerPublicSearchQuery(latest, directions); const homepage = explicitPublicUrl(latest);
    if (!companies.length && !query && !homepage) return { sources: [], ...(/最新|实时|近况|最近|新闻|动态|大厂/u.test(latest) ? { searchWarning: '这次未识别到公开公司关键词。可以指定公司或提供 HTTPS 官网；实时岗位仍需以具体招聘页为准。' } : {}) };
    const fetchedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    const signal = AbortSignal.timeout(options.totalTimeoutMs ?? 8000);
    let searchLimited = false;
    async function searchPublic(): Promise<ResearchSource[]> {
      if (!query) return [];
      try {
        const result = await fetchPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, signal);
        const snippets = careerSearchSnippets(result.html, fetchedAt);
        if (!snippets.length) { searchLimited = true; return []; }
        return await Promise.all(snippets.map(async snippet => {
          try { return sourceFromPage(await fetchPage(snippet.url, signal), fetchedAt) || snippet; }
          catch { return snippet; }
        }));
      } catch { searchLimited = true; return []; }
    }
    const [reports, found, supplied] = await Promise.all([Promise.all(companies.map(company => research({
      id: company.id, companyId: company.id, name: company.name, industry: company.industry,
      role: '', rationale: '', requirements: [], careerUrl: company.careerUrl,
      checkedAt: company.checkedAt, sourceLabel: '公司官网', hiringStatus: 'unverified', selected: false,
    }))), searchPublic(), homepage ? fetchPage(homepage, signal).then(page => sourceFromPage(page, fetchedAt)).catch(() => undefined) : undefined]);
    const sources = [...new Map([...(supplied ? [supplied] : []), ...reports.flatMap(report => report.sources), ...found].map(source => [source.url, source])).values()].slice(0, 8);
    const unavailable = reports.filter(report => !report.sources.length).map(report => report.companyName);
    const warnings = [
      unavailable.length ? `${unavailable.join('、')}官网本次未能读取，不能据此确认最新动态。` : '',
      searchLimited ? '本次公开搜索受限或未返回可核对结果；下列来源仅代表实际读取到的材料。' : '',
      homepage && !supplied ? '提供的网页暂未取得可读正文；可检查链接或换用公开官网页面。' : '',
      sources.some(source => source.readMethod === 'search_snippet') ? '部分结果仅有搜索摘要，尚未取得正文，需打开原文核对。' : '',
      sources.length && !sources.some(source => source.publishedAt) ? '已读取当前官网材料，但没有可确认的发布日期；获取时间不代表新闻发布时间。' : '',
      sources.length ? '公司材料用于了解业务，不代表已确认职位在招或具体薪资。' : '',
    ].filter(Boolean);
    return { sources, ...(warnings.length ? { searchWarning: warnings.join('') } : {}) };
  };
}
