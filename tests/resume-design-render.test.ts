import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';
import { closeBrowser, prepareResume, renderResumePdf } from '../server/browser.ts';
import { containsResumeText, inspectResumePdf, normalizeResumeText } from '../server/resume-quality.ts';
import { renderResumeHtml } from '../shared/resume-template.ts';
import { DEFAULT_RESUME_DESIGN, DESIGN_PRESETS } from '../shared/resume-design.ts';
import type { ResumeVersion } from '../shared/types.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const output = mkdtempSync(resolve('test-results', 'resume-design-render-'));
const reports: unknown[] = [];
after(async () => { await closeBrowser(); writeFileSync(resolve(output, 'report.json'), JSON.stringify({ syntheticOnly: true, realModelCalls: 0, reports }, null, 2)); console.log(`Resume design PDF artifacts: ${output}`); });

function fixture(id: string): ResumeVersion {
  return { id, version: 1, createdAt: '2026-10-07T00:00:00Z', approved: false,
    profile: { name: '合成测试同学', email: 'synthetic@example.com', phone: '', school: '示例大学', education: '本科', major: '法学', graduation: '2027年6月', city: '上海', availability: '每周三天', targetRole: '', experienceText: '', facts: [] },
    job: { company: '虚构公司', title: '产品合规实习', text: '', url: '' }, bullets: [], rationale: '',
    document: { headline: '产品合规实习', summary: '以课程研究和校园协作为基础，探索产品合规岗位。', theme: 'modern', accent: 'navy', design: { ...DEFAULT_RESUME_DESIGN }, sections: [{ id: 'research', title: '课程与项目实践', items: [{ id: 'privacy', title: '隐私政策对比研究', subtitle: '课程项目｜个人负责资料检索与比较表', date: '2025年3月—2025年6月', content: '整理公开政策资料，按条款主题制作对比表，保留原始出处。\n向课程小组说明研究范围与结论，记录尚未解决的问题。', factIds: [] }] }] },
  };
}

async function readPdf(pdf: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  try { const doc = await task.promise; const pages: string[] = []; for (let i = 1; i <= doc.numPages; i++) pages.push(normalizeResumeText((await (await doc.getPage(i)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(''))); return pages; }
  finally { await task.destroy(); }
}

test('legacy resumes retain their original layout, and design parameters cannot inject CSS or HTML', () => {
  const resume = fixture('legacy'); delete resume.document!.design;
  const legacy = renderResumeHtml(resume);
  assert.match(legacy, /@page\{size:A4;margin:15mm 17mm\}/);
  assert.match(legacy, /font-size:13px;line-height:1\.8/);
  assert.match(legacy, /\.item\{margin-bottom:12px;break-inside:avoid/);
  assert.doesNotMatch(legacy, /data-resume-design/);
  const designed = fixture('escaped');
  designed.document!.sections[0].items[0].content = '<script>globalThis.stolen=1</script><img src="https://invalid.example/secret">';
  const html = renderResumeHtml(designed);
  assert.doesNotMatch(html, /<script|<img|@import|url\(/);
  assert.match(html, /&lt;script&gt;/);
  assert.throws(() => renderResumeHtml({ ...designed, document: { ...designed.document!, design: { ...DEFAULT_RESUME_DESIGN, bodyFontPt: '10; color:red' as never } } }));
});

test('text completeness counts repeated text and ignores only whitespace/layout controls', () => {
  assert.equal(containsResumeText('重复重复', '重复'), false);
  assert.equal(containsResumeText('中文 A4：123', '中 文\nA4：123'), true);
  assert.equal(containsResumeText('20份', '2份'), false);
  assert.equal(containsResumeText('Ａ', 'A'), false);
  assert.equal(containsResumeText('个人项目', '个⼈项⽬'), false, 'The chosen font must preserve actual Chinese text, not unrelated radical code points');
});

test('real Chromium PDF preserves Chinese, applies serif/education order, and caches the checked final HTML', async () => {
  const resume = fixture('classic-serif'); resume.document!.design = { ...DESIGN_PRESETS.classic.design, educationPosition: 'last' }; resume.document!.theme = 'classic'; resume.document!.accent = 'ink';
  resume.document!.sections[0].items[0].content += '\n整理用户需求，绘制页面原型，个人负责项目资料。';
  const original = structuredClone(resume);
  const prepared = await prepareResume(resume);
  assert.equal(prepared.quality.status, 'passed', JSON.stringify(prepared.quality));
  assert.equal(prepared.quality.pageCount, 1); assert.equal(prepared.quality.textComplete, true); assert.equal(prepared.quality.overflow, false);
  assert.deepEqual(resume, original, 'QA does not mutate the saved input');
  const final = { ...resume, document: prepared.document };
  const html = renderResumeHtml(final);
  assert.match(html, /"SimSun"/); assert.ok(html.indexOf('课程与项目实践</h2>') < html.indexOf('教育背景</h2>'));
  assert.equal(prepared.quality.contentHash, createHash('sha256').update(html).digest('hex'));
  const bytes = await renderResumePdf(final); assert.deepEqual(await renderResumePdf(final), bytes);
  const pages = await readPdf(bytes); assert.ok(pages[0].includes('隐私政策对比研究')); assert.ok(pages[0].includes('尚未解决的问题')); assert.ok(pages[0].includes('用户需求')); assert.ok(pages[0].includes('页面原型')); assert.doesNotMatch(pages.join(''), /[\u2e80-\u2eff\u2f00-\u2fdf]/u);
  writeFileSync(resolve(output, 'classic-serif.pdf'), bytes); reports.push({ id: resume.id, quality: prepared.quality });
});

test('long URL, title and date wrap without horizontal clipping, including literal untrusted markup', async () => {
  const resume = fixture('long-fields');
  resume.profile.email = `https://example.com/${'portfolio-path-'.repeat(25)}`;
  const item = resume.document!.sections[0].items[0];
  item.title = '超长课程研究与项目协作标题'.repeat(12); item.date = '二〇二五年三月至二〇二六年六月'.repeat(8);
  item.content += '\n<script>这只是正文</script> & "文字完整"';
  const prepared = await prepareResume(resume);
  assert.equal(prepared.quality.status, 'passed', JSON.stringify(prepared.quality));
  const bytes = await renderResumePdf({ ...resume, document: prepared.document });
  const pages = await readPdf(bytes); assert.ok(pages.join('').includes('<script>这只是正文</script>'));
  writeFileSync(resolve(output, 'long-fields.pdf'), bytes); reports.push({ id: resume.id, quality: prepared.quality });
});

for (const goal of [1, 2] as const) test(`long single item naturally spans pages; ${goal}-page goal warns after at most one spacing adjustment`, async () => {
  const resume = fixture(`long-goal-${goal}`); resume.document!.design!.pageGoal = goal;
  const item = resume.document!.sections[0].items[0];
  item.content = Array.from({ length: 65 }, (_, i) => `第${i + 1}项记录：检索公开资料并登记条款来源，按研究主题进行比较，向课程小组解释适用范围和待确认的问题。保留课程实践身份、职责边界与真实成果。`).join('\n');
  const prepared = await prepareResume(resume);
  assert.equal(prepared.quality.status, 'warning', JSON.stringify(prepared.quality));
  assert.ok(prepared.quality.pageCount! > goal); assert.equal(prepared.quality.textComplete, true); assert.equal(prepared.quality.overflow, false);
  assert.equal(prepared.quality.adjustments.length, 1); assert.match(prepared.quality.warnings.join(''), /未强制裁切/);
  assert.equal(prepared.document.design!.bodyFontPt, DEFAULT_RESUME_DESIGN.bodyFontPt); assert.equal(prepared.document.design!.marginMm, DEFAULT_RESUME_DESIGN.marginMm);
  assert.deepEqual(prepared.document.sections, resume.document!.sections); assert.ok(prepared.document.design!.lineHeight >= 1.35);
  const bytes = await renderResumePdf({ ...resume, document: prepared.document });
  const pages = await readPdf(bytes);
  for (const line of item.content.split('\n')) assert.ok(pages.join('').includes(line), 'Every complete input paragraph survives pagination');
  writeFileSync(resolve(output, `long-goal-${goal}.pdf`), bytes); reports.push({ id: resume.id, quality: prepared.quality });
});

test('missing PDF text or detected clipping fails instead of returning a quality pass', async () => {
  const resume = fixture('negative-checks');
  const bytes = await renderResumePdf(resume);
  const missing = await inspectResumePdf(bytes, { text: '实际PDF不存在的罕见字龘'.repeat(3), horizontalOverflow: false, clipped: false }, 'auto', 'test');
  assert.equal(missing.status, 'failed'); assert.equal(missing.textComplete, false);
  const clipped = await inspectResumePdf(bytes, { text: '合成测试同学', horizontalOverflow: true, clipped: false }, 'auto', 'test');
  assert.equal(clipped.status, 'failed'); assert.equal(clipped.overflow, true);
  assert.doesNotMatch(JSON.stringify(missing), /龘/, 'Diagnostics contain no candidate text');
});

test('a positively unavailable browser returns the unchanged document and explicit not_checked', async t => {
  await closeBrowser();
  t.mock.method(chromium, 'launch', async () => { throw new Error('synthetic launch unavailable'); });
  const resume = fixture('no-browser'); const original = structuredClone(resume.document);
  const result = await prepareResume(resume);
  assert.equal(result.quality.status, 'not_checked'); assert.deepEqual(result.document, original); assert.equal(result.quality.textComplete, undefined); assert.equal(result.quality.engine, undefined);
});

test('runtime render failure is rejected rather than silently persisting an unchecked design', async t => {
  await closeBrowser(); const launch = chromium.launch.bind(chromium);
  t.mock.method(chromium, 'launch', async (options?: Parameters<typeof chromium.launch>[0]) => {
    const browser = await launch(options);
    t.mock.method(browser, 'newContext', async () => { throw new Error('private synthetic runtime detail'); });
    return browser;
  });
  await assert.rejects(prepareResume(fixture('runtime-failure')), error => error instanceof Error && /未保存/.test(error.message) && !/private/.test(error.message));
  await closeBrowser();
});

test('failed second render restores the first checked document and cached PDF', async t => {
  await closeBrowser(); const launch = chromium.launch.bind(chromium); let contextCount = 0;
  t.mock.method(chromium, 'launch', async (options?: Parameters<typeof chromium.launch>[0]) => {
    const browser = await launch(options); const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, 'newContext', async (options?: Parameters<typeof browser.newContext>[0]) => {
      contextCount++; if (contextCount === 2) throw new Error('synthetic retry render failed'); return newContext(options);
    }); return browser;
  });
  const resume = fixture('retry-failure'); resume.document!.design!.pageGoal = 1;
  resume.document!.sections[0].items[0].content = '完整保留的中文资料与用户页面记录。'.repeat(600);
  const result = await prepareResume(resume);
  assert.equal(contextCount, 2); assert.equal(result.quality.status, 'warning'); assert.equal(result.quality.textComplete, true);
  assert.deepEqual(result.document, resume.document); assert.equal(result.quality.adjustments.length, 0); assert.match(result.quality.warnings.join(''), /已保留此前/);
  const pdf = await renderResumePdf({ ...resume, document: result.document }); assert.equal(contextCount, 2, 'Export uses the previously checked PDF'); assert.ok(pdf.length > 1000);
  await closeBrowser();
});
