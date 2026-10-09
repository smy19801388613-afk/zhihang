import { renderResumeHtml as renderTemplate, toResumeDocument } from '../shared/resume-template.ts';
import { createHash } from 'node:crypto';
import { inspectResumePdf, readResumePrintMetrics, type ResumePrintMetrics } from './resume-quality.ts';
import type { ResumeQualityReport } from '../shared/resume-design.ts';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Application, ResumeDocument, ResumeVersion } from '../shared/types.js';

interface SandboxArgs {
  baseUrl: string;
  application: Application;
  resume: ResumeVersion;
  token: string;
  evidenceDir: string;
}

interface SandboxSession {
  context: BrowserContext;
  page: Page;
  origin: string;
  resumeId: string;
  token: string;
  touchedAt: number;
}

const sessions = new Map<string, SandboxSession>();
const pdfCache = new Map<string, { html: string; pdf: Promise<Buffer> }>();
let browserPromise: Promise<Browser> | undefined;
class BrowserUnavailableError extends Error {}

function executablePaths(): string[] {
  const candidates = [
    chromium.executablePath(),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return [...new Set(candidates)].filter(candidate => existsSync(candidate));
}

export function browserAvailable(): boolean {
  return executablePaths().length > 0;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const executables = executablePaths();
    if (!executables.length) throw new BrowserUnavailableError('未找到 Chromium、Edge 或 Chrome。请先安装可用浏览器，再重试简历导出或模拟填写。');
    browserPromise = (async () => {
      const errors: string[] = [];
      for (const executable of executables) {
        try { return await chromium.launch({ executablePath: executable, headless: true }); }
        catch (error) { errors.push(String(error).split('\n')[0]); }
      }
      throw new BrowserUnavailableError(`浏览器启动失败：${errors.join('；')}`);
    })().then(browser => {
      browser.on('disconnected', () => { browserPromise = undefined; sessions.clear(); });
      return browser;
    }).catch(error => { browserPromise = undefined; throw error; });
  }
  return browserPromise;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** Content comes only from the immutable resume version; no model-generated markup is executed. */
export function renderResumeHtml(resume: ResumeVersion): string { return renderTemplate(resume); }

export async function renderResumePdf(resume: ResumeVersion): Promise<Buffer> {
  const html = renderResumeHtml(resume);
  const cached = pdfCache.get(resume.id);
  if (cached?.html === html) return cached.pdf;
  const pdf = generatePdf(html, resume.document?.design?.marginMm);
  cachePdf(resume.id, html, pdf);
  try { return await pdf; }
  catch (error) { if (pdfCache.get(resume.id)?.pdf === pdf) pdfCache.delete(resume.id); throw error; }
}

function cachePdf(resumeId: string, html: string, pdf: Promise<Buffer>): void {
  pdfCache.set(resumeId, { html, pdf });
  // Pin files in active sessions so the submit endpoint can compare the uploaded bytes.
  for (const key of pdfCache.keys()) {
    if (pdfCache.size <= 64) break;
    if (key !== resumeId && !Array.from(sessions.values()).some(session => session.resumeId === key)) pdfCache.delete(key);
  }
}

async function createPdfArtifact(html: string, marginMm = 17, inspect = false): Promise<{ pdf: Buffer; metrics?: ResumePrintMetrics }> {
  const browser = await getBrowser();
  // Match the printable A4 width. The screen's responsive styles must not affect print QA.
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: Math.ceil((210 - marginMm * 2) * 96 / 25.4), height: 1123 } });
  try {
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const metrics = inspect ? await readResumePrintMetrics(page) : undefined;
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    return { pdf, metrics };
  } finally {
    await context.close();
  }
}

async function generatePdf(html: string, marginMm?: number): Promise<Buffer> {
  return (await createPdfArtifact(html, marginMm)).pdf;
}

/** Run before persisting a new immutable version; adjustments are returned, never silently applied on export. */
export async function prepareResume(resume: ResumeVersion): Promise<{ document: ResumeDocument; quality: ResumeQualityReport }> {
  const inputDocument = toResumeDocument(resume);
  let document = inputDocument;
  const check = async () => {
    const html = renderResumeHtml({ ...resume, document });
    const contentHash = createHash('sha256').update(html).digest('hex');
    const artifact = await createPdfArtifact(html, document.design?.marginMm, true);
    const quality = await inspectResumePdf(artifact.pdf, artifact.metrics!, document.design?.pageGoal || 'auto', contentHash);
    return { ...artifact, html, quality };
  };
  try {
    let checked = await check();
    const design = document.design;
    if (design && design.pageGoal !== 'auto' && checked.quality.pageCount! > design.pageGoal && checked.quality.status !== 'failed') {
      const tightened = { ...design, lineHeight: Math.max(1.35, Number((design.lineHeight - 0.05).toFixed(2))), sectionGapPx: Math.max(6, Math.floor(design.sectionGapPx * 0.8)), itemGapPx: Math.max(4, Math.floor(design.itemGapPx * 0.8)) };
      if (JSON.stringify(tightened) !== JSON.stringify(design)) {
        const previous = checked;
        const original = document;
        document = { ...document, design: tightened };
        try { checked = await check(); }
        catch {
          document = original; checked = previous;
          checked.quality.warnings.push('自动收紧间距未完成，已保留此前通过文字与边界检查的原版式。');
          checked.quality.status = 'warning';
        }
        if (checked.quality.status === 'failed') { document = original; checked = previous; checked.quality.warnings.push('收紧间距后的检查未通过，已保留原版式。'); checked.quality.status = 'warning'; }
        else if (document !== original) checked.quality.adjustments.push('为接近页数目标，已进行一次行距及栏目、条目间距调整；内容、字号和页边距保持不变。');
      }
    }
    cachePdf(resume.id, checked.html, Promise.resolve(checked.pdf));
    return { document, quality: checked.quality };
  } catch (error) {
    // Only a positively identified missing/unlaunchable browser may defer QA.
    // Render/PDF-parser failures must not persist an unchecked version or changed design.
    if (!(error instanceof BrowserUnavailableError)) throw new Error('简历 PDF 渲染或检查未完成，本次简历版本未保存，请重试。');
    return { document: inputDocument, quality: { status: 'not_checked', checkedAt: new Date().toISOString(), warnings: ['无法完成实际 PDF 检查：未找到可启动的浏览器。请安装可用的 Chrome/Edge 后重新检查，并在投递前预览导出文件。'], adjustments: [] } };
  }
}

function sandboxOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('模拟执行器只允许访问本机职航测试站。');
  }
  return url.origin;
}

function assertIdentity(application: Application, resume: ResumeVersion): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(application.id) || !/^[a-zA-Z0-9_-]{1,100}$/.test(resume.id)) throw new Error('申请或简历标识无效。');
  if (!application.simulated || application.resumeId !== resume.id) throw new Error('申请与简历版本不一致。');
}

function fieldValues(resume: ResumeVersion): Record<string, string> {
  const p = resume.profile;
  return {
    fullName: p.name, email: p.email, phone: p.phone, school: p.school,
    education: p.education, graduation: p.graduation, city: p.city,
    availability: p.availability, experience: resume.bullets.map(b => b.text).join('\n'),
  };
}

async function verifyFields(page: Page, resume: ResumeVersion): Promise<void> {
  for (const [id, expected] of Object.entries(fieldValues(resume))) {
    if (await page.locator(`#${id}`).inputValue() !== expected) throw new Error(`字段 ${id} 回读不一致，请重新填写。`);
  }
  const attachment = await page.locator('#resume').evaluate(input => {
    const file = (input as HTMLInputElement).files?.[0];
    return file ? { name: file.name, size: file.size, type: file.type } : null;
  });
  if (!attachment || attachment.name !== `${resume.id}.pdf` || !attachment.size || attachment.type !== 'application/pdf') throw new Error('简历附件核验失败，请重新填写。');
  if (!await page.locator('#consent').isChecked()) throw new Error('模拟申请确认项未选中。');
  if (!await page.locator('#applicationForm').evaluate(form => (form as HTMLFormElement).checkValidity())) throw new Error('申请资料不完整或格式无效，请补充个人档案后生成新简历。');
}

async function takeEvidence(page: Page, evidenceDir: string, id: string): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const evidence = path.resolve(evidenceDir, `${id}.png`);
  await page.screenshot({ path: evidence, fullPage: true, animations: 'disabled' });
  return evidence;
}

async function expireSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.touchedAt > 30 * 60 * 1000) {
      sessions.delete(id);
      await session.context.close().catch(() => {});
    }
  }
}

export async function fillSandbox(args: SandboxArgs): Promise<{ evidence: string }> {
  const origin = sandboxOrigin(args.baseUrl);
  assertIdentity(args.application, args.resume);
  await expireSessions();
  const previous = sessions.get(args.application.id);
  if (previous) { sessions.delete(args.application.id); await previous.context.close().catch(() => {}); }
  const pdf = await renderResumePdf(args.resume);
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    // This executor has no ability to navigate to a company URL supplied in a job description.
    await context.route('**/*', async route => {
      const requested = new URL(route.request().url());
      if (requested.origin === origin && (requested.pathname === '/sandbox' || requested.pathname.startsWith('/api/sandbox/'))) await route.continue();
      else await route.abort('blockedbyclient');
    });
    const target = new URL('/sandbox', origin);
    target.searchParams.set('applicationId', args.application.id);
    target.searchParams.set('token', args.token);
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.ready === 'true' || Boolean(document.getElementById('submissionError')?.textContent?.trim()));
    const initializationError = await page.locator('#submissionError').innerText();
    if (initializationError.trim()) throw new Error(initializationError);
    for (const [id, value] of Object.entries(fieldValues(args.resume))) {
      if (id === 'education') await page.locator(`#${id}`).selectOption({ label: value });
      else await page.locator(`#${id}`).fill(value);
    }
    await page.locator('#resume').setInputFiles({ name: `${args.resume.id}.pdf`, mimeType: 'application/pdf', buffer: pdf });
    await page.locator('#consent').check();
    await verifyFields(page, args.resume);
    const evidence = await takeEvidence(page, args.evidenceDir, args.application.id);
    sessions.set(args.application.id, { context, page, origin, resumeId: args.resume.id, token: args.token, touchedAt: Date.now() });
    return { evidence };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function submitSandbox(args: SandboxArgs): Promise<{ receipt: string; evidence: string }> {
  const origin = sandboxOrigin(args.baseUrl);
  assertIdentity(args.application, args.resume);
  const session = sessions.get(args.application.id);
  if (!session || session.page.isClosed() || session.origin !== origin || session.resumeId !== args.resume.id || session.token !== args.token) throw new Error('填写会话已失效，请先重新执行模拟填写，再确认提交。');
  session.touchedAt = Date.now();
  await verifyFields(session.page, args.resume);
  await session.page.locator('#submitApplication').click();
  try {
    await session.page.waitForFunction(() => Boolean(document.querySelector('[data-testid="receipt"]')?.textContent?.trim()) || Boolean(document.getElementById('submissionError')?.textContent?.trim()));
    const receipt = (await session.page.getByTestId('receipt').innerText()).trim();
    if (!receipt) {
      const message = (await session.page.locator('#submissionError').innerText()).trim();
      throw new Error(message || '尚未取得有效回执，请核验申请记录。');
    }
    const evidence = await takeEvidence(session.page, args.evidenceDir, args.application.id);
    sessions.delete(args.application.id);
    await session.context.close();
    return { receipt, evidence };
  } catch (error) {
    await takeEvidence(session.page, args.evidenceDir, args.application.id).catch(() => {});
    throw error;
  }
}

export async function closeBrowser(): Promise<void> {
  for (const session of sessions.values()) await session.context.close().catch(() => {});
  sessions.clear();
  const current = browserPromise;
  browserPromise = undefined;
  if (current) { const browser = await current.catch(() => undefined); await browser?.close(); }
}

/** Release only the deleted simulation's isolated browser context. */
export async function removeApplicationSession(applicationId: string): Promise<void> {
  const session = sessions.get(applicationId);
  sessions.delete(applicationId);
  if (session) await session.context.close().catch(() => {});
}

export async function removeResumeCache(resumeId: string): Promise<void> {
  pdfCache.delete(resumeId);
}
