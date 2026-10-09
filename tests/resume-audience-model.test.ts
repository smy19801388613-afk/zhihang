import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelEngine } from '../server/model.ts';
import { createCareerEngine } from '../server/career-engine.ts';
import { emptyProfile } from '../server/store.ts';
import type { ResumeDocument, ResumeVersion } from '../shared/types.ts';
import type { ResumeScope } from '../shared/resume-scope.ts';

const env = { MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'synthetic', MODEL_API_KEY: 'test-only' };
const fact = '校园招聘会志愿者，协助参会企业对接与现场安排。';
const profile = { ...emptyProfile(), facts: [{ id: 'f1', text: fact, source: fact, confirmed: true }] };
const document: ResumeDocument = { headline: '活动运营', summary: '', theme: 'modern', accent: 'navy', sections: [{ id: 'campus', title: '校园经历', items: [{ id: 'volunteer', title: '校园招聘会', subtitle: '志愿者', date: '', content: '协助参会企业对接与现场安排。', factIds: ['f1'] }] }] };
const job = { company: '', title: '通用运营', text: '', url: '' };
const analysis = { summary: '运营', matches: [], questions: [], directionAdvice: [] };
function reply(value: unknown) { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })); }

test('live general and multi drafting receive explicit audience and complete separate target JDs', async t => {
  let audience: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { audience = JSON.parse(JSON.parse(String(init.body)).messages[1].content).data; return reply({ document, rationale: '依据原始事实组织经历；不同岗位资格仍待核对。', reviewNotes: [] }); });
  for (const kind of ['general', 'multi'] as const) {
    const scope: ResumeScope = { kind, name: '通用运营', focus: '活动与内容运营', targetJobs: kind === 'general' ? [] : [{ ...job, company: '合成甲', title: '活动运营', text: '协助活动组织。' }, { ...job, company: '合成乙', title: '社区运营', text: '梳理用户反馈，要求到岗。' }] };
    const draft = await createModelEngine(env).draftResume(profile, job, analysis, undefined, scope);
    assert.equal(audience.resumeScope.kind, kind); assert.deepEqual(audience.resumeScope.targetJobs, scope.targetJobs);
    assert.equal(audience.job.company, ''); assert.deepEqual(audience.facts.map((f: any) => f.id), ['f1']);
    assert.match(draft.reviewNotes!.join(''), kind === 'general' ? /通用简历/ : /多个岗位/);
    assert.deepEqual(draft.document, document);
  }
});

test('chat edits preserve universal audience and original facts in the model request', async t => {
  let input: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { input = JSON.parse(JSON.parse(String(init.body)).messages[1].content).data; return reply({ document, message: '无需修改。', reviewNotes: [] }); });
  const resume: ResumeVersion = { id: 'test', version: 1, createdAt: '', profile, job, document, bullets: [], approved: true, rationale: '', scope: { kind: 'general', name: '运营', focus: '运营', targetJobs: [] } };
  await createCareerEngine(env).editResume(resume, '保留真实经历，检查措辞');
  assert.equal(input.resumeScope.kind, 'general'); assert.match(input.audienceRule, /不自动改为/);
});
