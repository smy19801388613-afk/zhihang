import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

// Synthetic split-panel DOM only. These fixtures do not claim to reproduce a
// logged-in BOSS build or establish that the live website is already validated.
const folder = resolve('extensions/zhihang-capture/adapters');
const scripts = ['common', 'boss', 'capture'].map(name => readFileSync(resolve(folder, `${name}.js`), 'utf8'));
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const idA = 'inlineJobA123'; const idB = 'inlineJobB456';
const jobUrl = (id: string) => `https://www.zhipin.com/job_detail/${id}.html`;
const card = (id: string, selected = false, company = '微帧', title = '初级海外商务', city = '北京') => `<li class="job-card-box ${selected ? 'active' : ''}"><a class="job-card-left" href="${jobUrl(id)}?securityId=SYNTHETIC_QUERY"><span class="job-name">${title}</span><span class="salary">8-13K</span><span class="job-area">${city}</span></a><div class="company-name">${company}</div><div class="job-summary">仅用于合成测试的列表摘要</div><div class="boss-info">PRIVATE_RECRUITER_CARD</div></li>`;
const panel = (identity = `data-job-id="${idA}"`, body = '<div class="job-sec-text">岗位职责：拓展海外合作伙伴，整理合作方案。<p>任职要求：英语沟通能力，能整理商务资料。</p></div>', header = `<h2 class="job-title">初级海外商务</h2><span class="salary">8-13K·13薪</span><span class="job-area">北京</span><div class="job-labels"><span>本科</span><span>经验不限</span></div>`) => `<section class="job-detail-container" ${identity}><header class="job-detail-header">${header}</header>${body}<div class="boss-info">PRIVATE_RECRUITER_RIGHT</div><div class="chat-panel">PRIVATE_CHAT_RIGHT</div></section>`;
const layout = (detail = panel(), cards = card(idA, true) + card(idB, false, '另一合成公司', '产品助理')) => `<div id="main"><ul class="job-list-box">${cards}</ul>${detail}<aside><input value="PRIVATE_PASSWORD">PRIVATE_ACCOUNT</aside></div>`;
async function extract(html: string, mutation?: string): Promise<any> {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif}.job-card-box{padding:10px}.job-detail-container{display:block}</style>${html}` }));
  await page.goto('https://www.zhipin.com/web/geek/jobs?query=synthetic-catalog&city=100010000&industry=&position=');
  try {
    for (const script of scripts.slice(0, -1)) await page.evaluate(script);
    if (mutation) await page.evaluate(mutation);
    return await page.evaluate(scripts.at(-1)!);
  } finally { await page.close(); }
}

test('split-panel full JD binds to matching selected-card ID and retains the card employer', async () => {
  const result = await extract(layout());
  assert.equal(result.jobs.length, 2); const job = result.jobs[0];
  assert.equal(job.sourceUrl, jobUrl(idA)); assert.equal(job.pageKind, 'detail');
  assert.equal(job.fields.company, '微帧'); assert.equal(job.fields.title, '初级海外商务');
  assert.equal(job.fields.salary, '8-13K·13薪'); assert.equal(job.fields.city, '北京');
  assert.equal(job.fields.education, '本科'); assert.equal(job.fields.experience, '经验不限');
  assert.equal(job.fields.jdComplete, true); assert.match(job.fields.jd, /拓展海外合作伙伴/);
  assert.equal(result.jobs[1].fields.jdComplete, false);
  assert.doesNotMatch(JSON.stringify(result.jobs), /PRIVATE_|SYNTHETIC_QUERY/);
});
test('visible header job URL may bind a split detail even when the panel has no job-id attribute', async () => {
  const header = `<h2 class="job-title"><a href="${jobUrl(idA)}?ka=detail">初级海外商务</a></h2>`;
  const result = await extract(layout(panel('', undefined, header)));
  assert.equal(result.jobs[0].fields.jdComplete, true); assert.equal(result.jobs[0].sourceUrl, jobUrl(idA));
});
test('unique explicit panel ID may identify an exact card without relying on an active CSS class', async () => {
  const result = await extract(layout(panel(), card(idA) + card(idB, false, '其他公司', '产品助理')));
  assert.equal(result.jobs[0].fields.jdComplete, true); assert.equal(result.jobs[0].fields.company, '微帧');
});
test('selected-card and panel ID conflict never mix old right-hand JD into the new selection', async () => {
  const result = await extract(layout(panel(`data-job-id="${idB}"`)));
  assert.ok(result.jobs.every((job: any) => !job.fields.jdComplete));
  assert.ok(result.jobs.every((job: any) => !job.fields.jd.includes('拓展海外合作伙伴')));
  assert.match(result.reason, /不一致/);
});
test('matching titles alone cannot bind a detail; missing identity stays partial', async () => {
  const result = await extract(layout(panel('')));
  assert.ok(result.jobs.every((job: any) => !job.fields.jdComplete)); assert.match(result.reason, /没有可核对的岗位标识/);
  assert.doesNotMatch(result.jobs[0].fields.jd, /拓展海外合作伙伴/);
});
test('panel root, header link and JD-container identities must agree', async () => {
  const header = `<h2 class="job-title"><a href="${jobUrl(idB)}">初级海外商务</a></h2>`;
  const first = await extract(layout(panel(`data-job-id="${idA}"`, undefined, header)));
  assert.ok(first.jobs.every((job: any) => !job.fields.jdComplete));
  const second = await extract(layout(panel(`data-job-id="${idA}"`, `<div data-job-id="${idB}"><div class="job-sec-text">错位旧岗位JD</div></div>`)));
  assert.ok(second.jobs.every((job: any) => !job.fields.jdComplete)); assert.doesNotMatch(second.jobs[0].fields.jd, /错位/);
});
test('title, city, employer or loading state disagreement keeps the left card partial', async () => {
  const variants = [
    panel().replace('<h2 class="job-title">初级海外商务</h2>', '<h2 class="job-title">其他岗位</h2>'),
    panel().replace('<span class="job-area">北京</span>', '<span class="job-area">上海</span>'),
    panel().replace('</section>', '<aside class="sider-company"><span class="company-name">另一个企业</span></aside></section>'),
    panel().replace('data-job-id=', 'aria-busy="true" data-job-id='),
  ];
  for (const detail of variants) {
    const result = await extract(layout(detail));
    assert.ok(result.jobs.every((job: any) => !job.fields.jdComplete));
  }
});
test('right panel with a matching ID but no complete JD remains partial', async () => {
  const result = await extract(layout(panel(undefined, '<div class="placeholder">详情尚未加载</div>')));
  assert.equal(result.jobs[0].fields.jdComplete, false); assert.match(result.reason, /详情待补充/);
  assert.equal(result.jobs[0].fields.jd, '仅用于合成测试的列表摘要');
});
test('recommended, hidden and recruiter job links cannot supply the right-panel identity', async () => {
  const header = `<h2 class="job-title">初级海外商务</h2><div class="recommend-job"><a href="${jobUrl(idA)}">推荐岗位</a></div><a hidden href="${jobUrl(idA)}">隐藏链接</a><div class="boss-info"><a href="${jobUrl(idA)}">PRIVATE_RECRUITER</a></div>`;
  const result = await extract(layout(panel('', undefined, header)));
  assert.ok(result.jobs.every((job: any) => !job.fields.jdComplete)); assert.doesNotMatch(JSON.stringify(result.jobs), /PRIVATE_/);
});
test('SPA switching during the bounded stability check discards the entire capture', async () => {
  const result = await extract(layout(), `setTimeout(() => { document.querySelector('.job-detail-container').setAttribute('data-job-id', '${idB}'); }, 40)`);
  assert.equal(result.jobs.length, 0); assert.match(result.reason, /发生切换/);
});
test('duplicate same-ID cards in different cities do not create an arbitrary detail association', async () => {
  const result = await extract(layout(panel(), card(idA, true, '微帧', '初级海外商务', '北京') + card(idA, false, '微帧', '初级海外商务', '上海')));
  assert.equal(result.jobs.length, 2); assert.ok(result.jobs.every((job: any) => !job.fields.jdComplete)); assert.match(result.reason, /不一致/);
});
test('a selected job below the first twenty rows is included first while total import stays at twenty', async () => {
  const cards = Array.from({ length: 23 }, (_, i) => card(`otherInline${i}`, false, `合成公司${i}`, `合成岗位${i}`)).join('') + card(idA, true);
  const result = await extract(layout(panel(), cards));
  assert.equal(result.jobs.length, 20); assert.equal(result.jobs[0].sourceUrl, jobUrl(idA)); assert.equal(result.jobs[0].fields.jdComplete, true);
});
test('recommendation descriptions preceding or nested in the right JD are never imported', async () => {
  const body = '<aside class="recommend-job"><div class="job-sec-text">RECOMMENDED_OTHER_JOB</div></aside><div class="job-description">当前岗位真实职责。<div class="recommend-list">NESTED_RECOMMENDATION</div><div class="chat-panel">PRIVATE_CHAT</div></div>';
  const result = await extract(layout(panel(undefined, body)));
  assert.equal(result.jobs[0].fields.jd, '当前岗位真实职责。'); assert.equal(result.jobs[0].fields.jdComplete, true);
});
test('job identity attributes on a visible header child are accepted without invoking its control', async () => {
  const header = `<h2 class="job-title">初级海外商务</h2><button data-job-id="${idA}" onclick="throw new Error('must never click')">立即沟通</button>`;
  const result = await extract(layout(panel('', undefined, header)));
  assert.equal(result.jobs[0].fields.jdComplete, true); assert.doesNotMatch(result.jobs[0].fields.jd, /立即沟通/);
});
test('recommendation cards inside a detail panel neither hide the valid detail nor enter the current result list', async () => {
  const detail = panel().replace('</section>', `<aside class="job-recommend">${card('recommendedId77', false, 'RECOMMENDED_COMPANY', 'RECOMMENDED_TITLE')}</aside></section>`);
  const result = await extract(layout(detail));
  assert.equal(result.jobs.length, 2); assert.equal(result.jobs[0].fields.jdComplete, true);
  assert.doesNotMatch(JSON.stringify(result.jobs), /RECOMMENDED_/);
  assert.deepEqual(result.inlineDiagnostics, { reason: 'matched', counts: { cards: 2, selectedCards: 1, panels: 1, identifiedPanels: 1, descriptionPanels: 1 } });
});
