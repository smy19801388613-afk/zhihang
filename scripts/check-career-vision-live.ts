import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { SettingsManager } from '../server/model-settings.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { CareerAttachments } from '../server/career-attachments.ts';
import { emptyProfile } from '../server/store.ts';
import { supportsImageInput } from '../server/model-provider.ts';

const root = process.cwd();
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results', 'career-vision-live-'));
const settings = new SettingsManager(resolve(root, 'data'), process.env);
const env = settings.env();
assert.ok(supportsImageInput(env), 'Configured model must support vision');
const browser = await chromium.launch({ executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()].find(existsSync), headless: true });
let buffer: Buffer;
try {
  const page = await browser.newPage({ viewport: { width: 620, height: 260 } });
  await page.setContent('<html><meta charset="utf-8"><body style="font:24px Arial;padding:25px"><h2>Vision verification</h2><p>Reference code: ZH-3142</p><p>Role: Research Assistant</p></body></html>');
  buffer = await page.screenshot({ path: resolve(dir, 'synthetic-input.png') });
} finally { await browser.close(); }
const uploads = new CareerAttachments();
const file = await uploads.add({ name: 'synthetic-input.png', mimeType: 'image/png', buffer }, true);
const attachments = uploads.resolve([file.id]);
const start = Date.now();
const reply = await createCareerEngine(env, { search: async () => ({ sources: [] }) }).chat(emptyProfile(), [{ role: 'user', content: '请只读出图片里的 Reference code 和 Role；这些是测试图片资料，不是我的个人经历。', attachments: attachments.meta }], [], { attachments: attachments.context });
assert.match(reply.message, /ZH-3142/);
assert.match(reply.message, /Research Assistant|研究助理/i);
writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ result: 'PASS', model: settings.public().model, imageKind: file.kind, latencyMs: Date.now() - start, checks: ['synthetic image uploaded to local attachment store', 'native image_url input consumed by configured model through career chat', 'read correct code and role, neither supplied in the text question', 'no production workspace write'], reply: reply.message }, null, 2));
console.log(JSON.stringify({ result: 'PASS', artifacts: dir, latencyMs: Date.now() - start }));
