import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { closeBrowser, renderResumePdf } from '../server/browser.ts';
import { renderResumeHtml } from '../shared/resume-template.ts';
import type { ResumeVersion } from '../shared/types.ts';

// Browser regression for the chosen appearance, including the CSS print cascade.
// This uses synthetic content only, and never reads model settings or calls an API.
const resume: ResumeVersion = {
  id: 'appearance-test', version: 1, createdAt: '2026-10-02T00:00:00.000Z', approved: false,
  profile: { name: '测试同学', email: 'example@example.com', phone: '', school: '示例大学', education: '本科', major: '法学', graduation: '2027年6月', city: '上海', availability: '', targetRole: '', experienceText: '', facts: [] },
  job: { company: '示例公司', title: '合规实习', text: '', url: '' }, bullets: [], rationale: '',
  document: { headline: '合规实习', summary: '具备课程研究与资料整理经历。', theme: 'classic', accent: 'navy', sections: [{ id: 'experience', title: '项目经历', items: [{ id: 'research', title: '课程研究', subtitle: '', date: '2025年', content: '参与公开资料检索和条款对比。', factIds: [] }] }] },
};
const candidates = [chromium.executablePath(), resolve(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'), resolve(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')].filter(existsSync);
let browser: Browser | undefined;
for (const executablePath of candidates) {
  try { browser = await chromium.launch({ executablePath, headless: true }); break; } catch { /* Try the next installed browser, as the PDF exporter does. */ }
}
assert.ok(browser, 'A working Chromium, Edge or Chrome is needed for appearance verification.');
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'resume-appearance-'));
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  const colors = { forest: 'rgb(40, 92, 73)', navy: 'rgb(36, 72, 111)', plum: 'rgb(110, 67, 94)' };
  for (const theme of ['modern', 'classic'] as const) {
    for (const accent of ['forest', 'navy', 'plum'] as const) {
      resume.document!.theme = theme; resume.document!.accent = accent;
      await page.setContent(renderResumeHtml(resume));
      for (const media of ['screen', 'print'] as const) {
        await page.emulateMedia({ media });
        const actual = await page.evaluate(() => ({
          heading: getComputedStyle(document.querySelector('h1')!).color,
          section: getComputedStyle(document.querySelector('h2')!).color,
          headline: getComputedStyle(document.querySelector('.headline')!).color,
          border: getComputedStyle(document.querySelector('header')!).borderBottomColor,
          layout: getComputedStyle(document.querySelector('.name-row')!).justifyContent,
          monogram: getComputedStyle(document.querySelector('.monogram')!).display,
        }));
        const context = `${theme} / ${accent} / ${media}`;
        for (const property of ['heading', 'section', 'headline', 'border'] as const) assert.equal(actual[property], colors[accent], `${context}: ${property} should follow the chosen colour`);
        assert.equal(actual.layout, theme === 'classic' ? 'center' : 'space-between', `${context}: layout`);
        assert.equal(actual.monogram, theme === 'classic' ? 'none' : 'flex', `${context}: monogram`);
      }
    }
  }
  resume.document!.theme = 'classic'; resume.document!.accent = 'navy';
  const pdf = await renderResumePdf(resume);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  writeFileSync(resolve(dir, 'classic-navy.pdf'), pdf);
  await page.setContent(renderResumeHtml(resume));
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: resolve(dir, 'classic-navy-browser.png'), fullPage: true });
  const readPdf = async (data: Buffer) => {
    const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true });
    const doc = await task.promise;
    try {
      const pages: string[] = [];
      for (let number = 1; number <= doc.numPages; number++) {
        const content = await (await doc.getPage(number)).getTextContent();
        pages.push(content.items.map(item => 'str' in item ? item.str : '').join('').replace(/\s+/g, ''));
      }
      return pages;
    } finally { await task.destroy(); }
  };
  const pagination: Array<{ id: string; pages: number; headingsKeptWithContent: boolean }> = [];
  const fixturesPath = resolve('test-results/four-steps/live-model.json');
  if (existsSync(fixturesPath)) {
    const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { syntheticOnly: boolean; cases: Array<{ id: string; resume?: ResumeVersion }> };
    assert.equal(fixtures.syntheticOnly, true, 'Appearance checks must only use synthetic resumes');
    for (const fixture of fixtures.cases.filter(item => item.resume)) {
      const bytes = await renderResumePdf(fixture.resume!);
      const pages = await readPdf(bytes);
      assert.equal(pages.length, 1, `${fixture.id}: this moderate-length student resume should fit one page`);
      for (const section of fixture.resume!.document!.sections) {
        assert.ok(pages[0].includes(section.title.replace(/\s+/g, '')), `${fixture.id}: missing heading ${section.title}`);
        for (const item of section.items) for (const line of item.content.split(/\n+/).filter(Boolean)) assert.ok(pages[0].includes(line.replace(/^[-•]\s*/, '').replace(/\s+/g, '')), `${fixture.id}: full content must remain in the PDF`);
      }
      const name = fixture.id.includes('manufacturing') ? 'manufacturing-layout-fixed.pdf' : 'privacy-layout-fixed.pdf';
      writeFileSync(resolve('test-results/four-steps', name), bytes);
      pagination.push({ id: fixture.id, pages: pages.length, headingsKeptWithContent: true });
    }
  }
  const longResume = structuredClone(resume);
  longResume.id = 'appearance-multiple-pages'; longResume.document!.theme = 'modern';
  longResume.document!.sections = ['一', '二', '三', '四', '五', '六', '七', '八'].map((number, index) => ({
    id: `section-${index}`, title: `分页栏目${number}`, items: [{ id: `long-${index}`, title: `对应内容${number}`, subtitle: '课程研究与校园实践', date: '2025年', factIds: [], content: Array.from({ length: 6 }, (_, line) => `记录${index + 1}-${line + 1}：在课程研究中整理公开资料，按主题对比不同条款，记录引用来源并讨论适用范围。根据已确认信息完成研究摘要，保留课程项目身份与个人职责。`).join('\n') }],
  }));
  await page.setContent(renderResumeHtml(longResume));
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.item-body p').first().evaluate(element => getComputedStyle(element).fontSize), '13px', 'Long resumes retain the original readable body font size');
  const longPdf = await renderResumePdf(longResume);
  const longPages = await readPdf(longPdf);
  assert.ok(longPages.length > 1, 'Long content must paginate instead of shrinking into one page');
  for (const section of longResume.document!.sections) {
    const headingPage = longPages.findIndex(text => text.includes(section.title));
    const contentPage = longPages.findIndex(text => text.includes(section.items[0].title));
    assert.ok(headingPage >= 0); assert.equal(headingPage, contentPage, `Heading ${section.title} must stay with its first content`);
    for (const line of section.items[0].content.split('\n')) assert.ok(longPages.join('').includes(line.replace(/\s+/g, '')), 'Paginating must preserve all text');
  }
  writeFileSync(resolve(dir, 'long-resume-pagination.pdf'), longPdf);
  pagination.push({ id: longResume.id, pages: longPages.length, headingsKeptWithContent: true });
  writeFileSync(resolve(dir, 'pagination-report.json'), JSON.stringify({ result: 'PASS', pagination }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', combinations: 12, checked: ['selected colour on visible headings and border', 'layout independent of colour', 'screen and print cascade', 'actual PDF generation', 'short resumes fit one page without dropping text', 'long resumes paginate at unchanged font size with headings attached'], pagination, artifacts: dir }, null, 2));
} finally { await browser.close(); await closeBrowser(); }
