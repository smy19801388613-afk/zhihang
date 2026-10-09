import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettingsManager } from '../server/model-settings.ts';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { Store } from '../server/store.ts';
import { Workflow } from '../server/workflow.ts';
import { prepareResume, renderResumePdf, closeBrowser } from '../server/browser.ts';

// Explicitly opt-in paid check. Reads settings only; never loads the user's workspace.
if (!process.argv.includes('--run')) {
  console.log('Paid synthetic design check: npx tsx scripts/check-live-design.ts --run'); process.exit(0);
}
const settingsPath = resolve('data/model-settings.json');
const hash = () => createHash('sha256').update(readFileSync(settingsPath)).digest('hex');
const initialHash = hash();
const settings = new SettingsManager(resolve('data'), {}), env = settings.env();
assert.equal(settings.public().mode, 'live', 'Requires a configured live model');
const key = env.MODEL_API_KEY!;
const redact = (value: string) => value.replaceAll(key, '[REDACTED]');
const store = new Store(':memory:');
const seed = store.read();
const source = '2025年3月至6月，我在示例大学参与隐私政策课程研究，负责检索公开资料，对比三家虚构平台的条款，并整理研究表格。';
seed.profile = { name: '林澄', phone: '', email: 'example@example.com', school: '示例大学', education: '本科', major: '法学', graduation: '2027年6月', city: '上海', availability: '', targetRole: '合规实习生', experienceText: source,
  facts: [{ id: 'synthetic-course', text: source, source, confirmed: true, experience: { id: 'synthetic-project', title: '隐私政策课程研究', kind: 'project', role: '参与成员' } }] };
seed.job = { company: '虚构科技公司', title: '合规实习生', text: '协助隐私政策公开资料检索、条款对比与研究表格整理。要求法学在读，具备资料检索和文字整理能力。', url: '' };
seed.analysis = { summary: '课程研究中的资料检索与条款整理可迁移到岗位任务，尚需实际业务验证。',
  matches: [{ requirement: '资料检索与条款整理', evidence: source, factIds: ['synthetic-course'], status: 'supported' }], questions: [], directionAdvice: [] };
let state = store.save(seed, seed.revision);
const workflow = new Workflow(store, createModelEngine(env), { fill: async () => { throw new Error('No application operations'); }, submit: async () => { throw new Error('No application operations'); }, prepareResume }, createCareerEngine(env));
mkdirSync(resolve('test-results'), { recursive: true });
const dir = mkdtempSync(resolve('test-results/live-design-'));
const originalFetch = globalThis.fetch;
const calls: Array<Record<string, unknown>> = [];
globalThis.fetch = async (input, init) => {
  const host = new URL(input instanceof Request ? input.url : input.toString()).hostname;
  assert.equal(host, new URL(settings.public().baseUrl).hostname, 'Only the configured provider is contacted');
  const response = await originalFetch(input, init);
  const entry: Record<string, unknown> = { status: response.status }; calls.push(entry);
  if (response.ok) { const payload = await response.clone().json(); entry.usage = payload.usage; entry.model = payload.model; entry.finishReason = payload.choices?.[0]?.finish_reason; }
  return response;
};
let result = 'FAIL', failure: string | undefined;
try {
  state = await workflow.act({ type: 'preview_resume_design', expectedRevision: state.revision, name: '法学实习清晰单页', preset: 'clean', instructions: '使用黑白配色与无衬线字体。正文11磅，页边距16毫米，尽量一页，教育背景放最后。清晰正式，不放头像。' });
  const plan = state.resumeDesign!.preview!;
  assert.equal(plan.mode, 'live'); assert.equal(plan.accent, 'ink'); assert.equal(plan.design.bodyFontPt, 11);
  assert.equal(plan.design.educationPosition, 'last'); assert.equal(plan.design.pageGoal, 1);
  state = await workflow.act({ type: 'save_resume_design', expectedRevision: state.revision, setDefault: true });
  state = await workflow.act({ type: 'generate_resume', expectedRevision: state.revision });
  const resume = state.resumes.at(-1)!;
  assert.equal(resume.generation?.mode, 'live'); assert.equal(resume.designSkill?.id, plan.id);
  assert.ok(['passed', 'warning'].includes(resume.quality?.status || ''), JSON.stringify(resume.quality));
  assert.equal(resume.quality?.textComplete, true); assert.equal(resume.quality?.overflow, false);
  assert.ok(resume.document?.sections.flatMap(section => section.items).every(item => item.factIds.includes('synthetic-course')));
  writeFileSync(resolve(dir, 'synthetic-resume.pdf'), await renderResumePdf(resume));
  writeFileSync(resolve(dir, 'synthetic-output.json'), redact(JSON.stringify({ plan, resume }, null, 2)));
  result = 'PASS';
} catch (error) { failure = redact(error instanceof Error ? error.message : String(error)); throw new Error(failure); }
finally {
  globalThis.fetch = originalFetch; await closeBrowser(); store.close();
  const report = { result, ...(failure ? { failure } : {}), provider: settings.public().provider, model: settings.public().model, syntheticDataOnly: true, workspaceUntouched: true, settingsUnchanged: initialHash === hash(), calls, dir };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  assert.equal(initialHash, hash());
}
