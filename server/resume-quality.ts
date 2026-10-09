import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Page } from 'playwright';
import type { ResumeQualityReport, ResumeDesignSpec } from '../shared/resume-design.ts';

export interface ResumePrintMetrics { text: string; horizontalOverflow: boolean; clipped: boolean }

/** Read only visible resume text and its print-layout bounds. No candidate text enters reports. */
export async function readResumePrintMetrics(page: Page): Promise<ResumePrintMetrics> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) throw new Error('Resume root missing');
    const bounds = main.getBoundingClientRect();
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    let horizontalOverflow = false;
    let clipped = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      if (!rects.length) continue;
      let hidden = false;
      for (let ancestor: Element | null = node.parentElement; ancestor && main.contains(ancestor); ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) { hidden = true; break; }
        const box = ancestor.getBoundingClientRect();
        if (['hidden', 'clip'].includes(style.overflowX) && rects.some(rect => rect.left < box.left - 1 || rect.right > box.right + 1)) clipped = true;
        if (['hidden', 'clip'].includes(style.overflowY) && rects.some(rect => rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) clipped = true;
      }
      if (hidden) continue;
      texts.push(node.textContent);
      if (rects.some(rect => rect.left < bounds.left - 1.5 || rect.right > bounds.right + 1.5)) horizontalOverflow = true;
    }
    return { text: texts.join('\n'), horizontalOverflow, clipped };
  });
}

// Whitespace and invisible layout controls can legitimately change during PDF line breaking.
// Keep punctuation, digits, case, and repeated characters intact.
export function normalizeResumeText(value: string): string {
  return value.normalize('NFC').replace(/[\s\u200b-\u200d\ufeff\u00ad]/gu, '');
}

/** Character multiplicities catch missing repeated content without assuming flex-column read order. */
export function containsResumeText(expected: string, actual: string): boolean {
  const counts = new Map<string, number>();
  for (const character of normalizeResumeText(actual)) counts.set(character, (counts.get(character) || 0) + 1);
  for (const character of normalizeResumeText(expected)) {
    const count = counts.get(character) || 0;
    if (count === 0) return false;
    counts.set(character, count - 1);
  }
  return true;
}

export async function inspectResumePdf(pdf: Buffer, metrics: ResumePrintMetrics, pageGoal: ResumeDesignSpec['pageGoal'], contentHash: string): Promise<ResumeQualityReport> {
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  try {
    const document = await task.promise;
    const pageTexts: string[] = [];
    let pdfOverflow = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(item => 'str' in item);
      pageTexts.push(items.map(item => item.str).join(''));
      for (const item of items) {
        if (!item.str.trim()) continue;
        const [x, y] = [item.transform[4], item.transform[5]];
        if (x < -1.5 || x + item.width > viewport.width + 1.5 || y < -1.5 || y + item.height > viewport.height + 1.5) pdfOverflow = true;
      }
    }
    const textComplete = containsResumeText(metrics.text, pageTexts.join(''));
    const overflow = metrics.horizontalOverflow || metrics.clipped || pdfOverflow;
    const warnings: string[] = [];
    if (!textComplete) warnings.push('PDF 文字完整性检查未通过：存在无法回读的文字，请检查导出文件。');
    if (overflow) warnings.push('检测到文字超出打印边界或被裁切，请调整版式后重试。');
    if (pageGoal !== 'auto' && document.numPages > pageGoal) warnings.push(`当前内容为 ${document.numPages} 页，超过 ${pageGoal} 页目标；已保留全部内容，未强制裁切。`);
    return {
      status: !textComplete || overflow ? 'failed' : warnings.length ? 'warning' : 'passed',
      checkedAt: new Date().toISOString(), engine: 'chromium', pageCount: document.numPages,
      textComplete, overflow, warnings, adjustments: [], contentHash,
    };
  } finally { await task.destroy(); }
}
