import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import type { JobAnalysis, ResumeVersion } from '../shared/types.ts';

// Offline only: replay preserved synthetic replies through the actual model
// adapters and validators. No settings, credentials, or network are used.
const directory = resolve('test-results/four-steps');
const sourcePath = resolve(directory, 'live-model.json');
const original = readFileSync(sourcePath, 'utf8');
const saved = JSON.parse(original) as {
  cases: Array<{ id: string; analysis: JobAnalysis; resume?: ResumeVersion }>;
  calls: Array<{ stage: string; syntheticReply: string }>;
};
const env = { MODEL_BASE_URL: 'https://offline-replay.invalid/v1', MODEL_API_KEY: 'offline-dummy', MODEL_NAME: 'preserved-synthetic-reply' };
let expectedReply: string | undefined; let replayedCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  assert.equal(new URL(input instanceof Request ? input.url : String(input)).hostname, 'offline-replay.invalid');
  assert.ok(expectedReply, 'No saved response was selected; network fallback is forbidden.');
  replayedCalls++;
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: expectedReply } }] }), { headers: { 'content-type': 'application/json' } });
};
const output: { source: string; operation: string; networkRequests: number; replayedCalls?: number; cases: Array<{ id: string; resume: ResumeVersion }>; edit?: unknown } = {
  source: 'live-model.json (preserved unchanged)', operation: 'Offline syntheticReply replay through updated grounding; not a new model run', networkRequests: 0, cases: [],
};
try {
  const engine = createModelEngine(env);
  for (const testCase of saved.cases.filter(testCase => testCase.resume)) {
    const base = testCase.resume!;
    expectedReply = saved.calls.find(call => call.stage === `${testCase.id}:draft`)?.syntheticReply;
    const draft = await engine.draftResume(base.profile, base.job, testCase.analysis);
    const english = draft.document!.sections.flatMap(section => section.items).find(item => item.title === '英语')!;
    assert.match(english.content, /简单/u);
    assert.doesNotMatch(english.content, /未提供.*(?:成绩|证明)/u);
    assert.ok(draft.reviewNotes?.some(note => /未提供考试成绩或专业英语能力证明/u.test(note)));
    output.cases.push({ id: testCase.id, resume: { ...base, ...draft } });
  }
  const base = saved.cases.find(testCase => testCase.id === 'law-privacy-intern')!.resume!;
  expectedReply = saved.calls.find(call => call.stage === 'resume-edit')?.syntheticReply;
  if (expectedReply) output.edit = await createCareerEngine(env).editResume(base, '回放原先保存的简历修改回复，验证审核说明分离。');
  output.replayedCalls = replayedCalls;
  assert.equal(readFileSync(sourcePath, 'utf8'), original);
  const path = resolve(directory, 'grounding-replay.json');
  writeFileSync(path, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ path, cases: output.cases.length, replayedCalls, networkRequests: 0, originalPreserved: true }));
} finally { globalThis.fetch = originalFetch; }
