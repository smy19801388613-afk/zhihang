import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettingsManager } from '../server/model-settings.ts';
import { createModelEngine } from '../server/model.ts';
import { Store } from '../server/store.ts';
import { Workflow } from '../server/workflow.ts';
import { prepareResume, renderResumePdf, closeBrowser } from '../server/browser.ts';

if (!process.argv.includes('--run')) { console.log('Paid synthetic reuse check: npx tsx scripts/check-live-reuse.ts --run'); process.exit(0); }
const settingsPath = resolve('data/model-settings.json');
const settingsHash = () => createHash('sha256').update(readFileSync(settingsPath)).digest('hex'); const beforeHash = settingsHash();
const settings = new SettingsManager(resolve('data'), {}), env = settings.env(); assert.equal(settings.public().mode, 'live');
const redact = (value: string) => value.replaceAll(env.MODEL_API_KEY!, '[REDACTED]');
const store = new Store(':memory:'); let state = store.read();
const text = '2025年3月至6月，我在示例大学参与隐私政策课程研究，检索公开资料，对比三家虚构平台的条款，并整理研究表格。';
state.profile = { ...state.profile, name: '合成测试同学', email: 'example@example.test', school: '示例大学', education: '本科', major: '法学', graduation: '2027年6月', targetRole: '合规实习生', experienceText: text,
  facts: [{ id: 'synthetic-course', text, source: text, confirmed: true, experience: { id: 'course-project', title: '隐私政策课程研究', kind: 'project', role: '参与成员' } }] };
state.exploration = { messages: [], directions: [], selectedDirectionIds: [], stage: 'companies', companies: ['甲', '乙'].map((name, index) => ({ id: `synthetic-${index}`, name: `虚构公司${name}`, role: index ? '研究助理实习生' : '合规实习生', industry: '科技', location: '北京', careerUrl: `https://example.test/job/${index}`, sourceKind: 'user_jd', sourceLabel: '合成测试', jobDescription: index ? '检索公开资料，整理比较表，要求法学在读及细致的文字处理能力。' : '协助隐私政策资料检索和条款对比。要求法学在读，能整理公开资料。', jdComplete: true, hiringStatus: 'unverified', selected: true, checkedAt: new Date().toISOString(), rationale: '', requirements: [] })) };
state = store.save(state, state.revision);
const workflow = new Workflow(store, createModelEngine(env), { fill: async () => { throw new Error('No application writes'); }, submit: async () => { throw new Error('No application writes'); }, prepareResume });
mkdirSync(resolve('test-results'), { recursive: true }); const dir = mkdtempSync(resolve('test-results/live-reuse-'));
const originalFetch = globalThis.fetch; const calls: unknown[] = [];
globalThis.fetch = async (input, init) => {
  const hostname = new URL(input instanceof Request ? input.url : input.toString()).hostname;
  assert.equal(hostname, new URL(settings.public().baseUrl).hostname);
  const response = await originalFetch(input, init);
  const entry: Record<string, unknown> = { status: response.status }; calls.push(entry);
  if (response.ok) { const result = await response.clone().json(); entry.usage = result.usage; entry.model = result.model; entry.finishReason = result.choices?.[0]?.finish_reason; }
  return response;
};
let result = 'FAIL', failure: string | undefined;
try {
  state = await workflow.act({ type: 'generate_general_resume', expectedRevision: state.revision, name: '合规与研究通用', focus: '强调公开资料检索与条款对比，保持课程身份。' });
  state = await workflow.act({ type: 'generate_multi_resume', expectedRevision: state.revision, name: '合规与研究多岗', focus: '突出两个岗位共同需要的资料检索与比较能力。', candidateIds: ['synthetic-0', 'synthetic-1'] });
  assert.equal(state.resumes.length, 2); assert.ok(state.resumes.every(resume => !resume.stale));
  for (const resume of state.resumes) {
    assert.equal(resume.generation?.mode, 'live'); assert.equal(resume.quality?.textComplete, true); assert.equal(resume.quality?.overflow, false);
    assert.ok(resume.document?.sections.flatMap(section => section.items).every(item => item.factIds.includes('synthetic-course')));
    writeFileSync(resolve(dir, `${resume.scope!.kind}.pdf`), await renderResumePdf(resume));
  }
  writeFileSync(resolve(dir, 'synthetic-output.json'), redact(JSON.stringify(state.resumes, null, 2))); result = 'PASS';
} catch (error) { failure = redact(error instanceof Error ? error.message : String(error)); throw new Error(failure); }
finally {
  globalThis.fetch = originalFetch; await closeBrowser(); store.close();
  const report = { result, failure, provider: settings.public().provider, model: settings.public().model, syntheticOnly: true, workspaceUntouched: true, settingsUnchanged: beforeHash === settingsHash(), calls, dir };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); assert.equal(beforeHash, settingsHash());
}
