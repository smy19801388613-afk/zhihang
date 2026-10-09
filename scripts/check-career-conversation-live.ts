import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCareerEngine } from '../server/career-engine.ts';
import { SettingsManager } from '../server/model-settings.ts';
import { emptyProfile } from '../server/store.ts';
import type { CareerDirection, InterviewMessage } from '../shared/types.ts';

if (!process.argv.includes('--run')) { console.log('Opt in to 3 paid synthetic requests: npx tsx scripts/check-career-conversation-live.ts --run'); process.exit(0); }
const settings = new SettingsManager(resolve('data'), {}); const env = settings.env();
assert.equal(settings.public().mode, 'live');
const engine = createCareerEngine(env);
const profile = { ...emptyProfile(), name: '合成测试同学', major: '法学', education: '本科', city: '上海', facts: [{ id: 'synthetic-law', text: '参与法律案例课程研究，检索公开判决并整理比较表。', source: '参与法律案例课程研究，检索公开判决并整理比较表。', confirmed: true }] };
const messages: InterviewMessage[] = []; let directions: CareerDirection[] = []; let ready = false;
const turns: Array<Record<string, unknown>> = [];
mkdirSync(resolve('test-results'), { recursive: true }); const dir = mkdtempSync(resolve('test-results/career-conversation-live-'));
for (const question of ['我还没定方向。请介绍几种律师以外的实习选择。', '我希望做研究分析，收入与成长都重要。请比较互联网合规和制造业合规的日常区别，不要复述我的背景。', '可以进入找岗位了。先查腾讯最近的业务信息，并给我下一步。']) {
  messages.push({ role: 'user', content: question }); const started = Date.now();
  let reply: Awaited<ReturnType<typeof engine.chat>> | undefined;
  try {
    reply = await engine.chat(profile, messages, directions, { forceReady: ready });
    assert.ok(reply.directions.length >= 2 && reply.directions.length <= 4);
    assert.ok(reply.directions.every(direction => !/^各类/u.test(direction.industry) && !/^(?:企业)?法务(?:与合规)?$/u.test(direction.industry)));
    const questions = reply.message.match(/[？?]/g) || []; assert.ok(questions.length <= 1);
    if (ready || turns.length === 2) { assert.equal(reply.conversationPhase, 'ready'); assert.equal(questions.length, 0); }
    if (turns.length === 2) assert.ok(reply.sources?.length || reply.searchWarning);
    turns.push({ question, ...reply, elapsedMs: Date.now() - started, result: 'PASS' });
    ready = reply.conversationPhase === 'ready'; directions = reply.directions; messages.push({ role: 'assistant', content: reply.message });
    console.log(JSON.stringify({ turn: turns.length, phase: reply.conversationPhase, sources: reply.sources?.length || 0, questions: questions.length, elapsedMs: Date.now() - started, result: 'PASS' }));
  } catch (error) {
    turns.push({ question, ...reply, result: 'FAIL', error: error instanceof Error ? error.message.replaceAll(env.MODEL_API_KEY || 'missing-key', '[REDACTED]') : 'Unknown error' });
    throw error;
  } finally {
    const report = { syntheticDataOnly: true, noWorkspaceWrites: true, model: settings.public().model, provider: settings.public().provider, turns };
    writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2).replaceAll(env.MODEL_API_KEY || 'missing-key', '[REDACTED]'));
  }
}
console.log(JSON.stringify({ result: 'PASS', artifacts: dir }));
