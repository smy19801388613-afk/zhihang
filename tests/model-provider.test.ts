import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createJsonRequester, ModelProviderError, probeModel, readProviderConfig } from '../server/model-provider.ts';

const env = { MODEL_BASE_URL: 'https://model.example/v1', MODEL_NAME: 'example-model', MODEL_API_KEY: 'secret-never-print' };
const schema = z.object({ ok: z.literal(true) });
const answer = (content = '{"ok":true}', extra = {}) => new Response(JSON.stringify({ choices: [{ message: { content }, ...extra }] }));

test('an agent can own the entire repair budget without nested provider retries', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return answer('{"ok":false}'); });
  await assert.rejects(createJsonRequester(env, 'system', { formatRepair: false })!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'invalid_json');
  assert.equal(calls, 1);
});
test('long grounded outputs can use an explicit bounded budget without changing ordinary requests', async t => {
  let sent: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return answer(); });
  await createJsonRequester(env, 'system', { maxOutputTokens: 65536, formatRepair: false })!('', {}, schema);
  assert.equal(sent.max_tokens, 65536);
  for (const value of [0, 65537, 1.5, NaN]) assert.throws(() => createJsonRequester(env, 'system', { maxOutputTokens: value }), /输出预算/);
});

test('provider configuration validates complete credentials and safe transport', () => {
  assert.equal(createJsonRequester({}, 'system'), null);
  assert.throws(() => createJsonRequester({ MODEL_NAME: 'model' }, 'system'), /配置不完整/);
  for (const base of ['http://remote.example/v1', 'https://user:secret-never-print@example.com', 'https://example.com?api_key=secret-never-print', 'ftp://example.com', 'https://example.com/#secret-never-print']) {
    assert.throws(() => createJsonRequester({ ...env, MODEL_BASE_URL: base }, 'system'), error => error instanceof ModelProviderError && error.code === 'configuration' && !error.message.includes('secret-never-print'));
  }
  assert.equal(readProviderConfig({ ...env, MODEL_BASE_URL: 'http://127.0.0.1:1234/v1/chat/completions/' })!.endpoint.toString(), 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(readProviderConfig(env)!.timeoutMs, 90000);
  assert.throws(() => readProviderConfig({ ...env, MODEL_TIMEOUT_MS: '9999' }), /10000/);
  assert.throws(() => readProviderConfig({ ...env, MODEL_JSON_MODE: 'yes' }), /true 或 false/);
});

test('generic provider uses bounded JSON completion without vendor thinking parameters', async t => {
  let init!: RequestInit;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, value: RequestInit) => { init = value; return answer(); });
  assert.deepEqual(await createJsonRequester({ ...env, MODEL_JSON_MODE: 'true' }, 'system')!('instruction', { value: 'safe task data' }, schema), { ok: true });
  assert.equal(init.redirect, 'manual');
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer secret-never-print');
  const body = JSON.parse(String(init.body));
  assert.equal(body.temperature, 0.2); assert.equal(body.max_tokens, 8192);
  assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.thinking, undefined);
  assert.deepEqual(JSON.parse(body.messages[1].content), { data: { value: 'safe task data' } });
});

test('only verified DeepSeek endpoint and supported model receive thinking disabled', async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer(); });
  for (const config of [
    { ...env, MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'deepseek-flash' },
    { ...env, MODEL_BASE_URL: 'https://other.example', MODEL_NAME: 'deepseek-flash' },
    { ...env, MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'different-model' },
  ]) await createJsonRequester(config, 'system')!('instruction', {}, schema);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[1].thinking, undefined); assert.equal(bodies[2].thinking, undefined);
  assert.equal(bodies[0].response_format, undefined);
});

test('HTTP failures are typed and never copy upstream diagnostics or credentials', async t => {
  for (const [status, code] of [[401, 'authentication'], [402, 'quota'], [403, 'authentication'], [429, 'rate_limit'], [500, 'provider'], [307, 'redirect'], [400, 'provider']] as const) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('secret-never-print upstream diagnostic', { status }); });
    await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === code && error.status === status && !/secret-never-print|upstream diagnostic/.test(error.message));
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});

test('strict JSON rejects fences while legacy-compatible mode accepts a fenced object', async t => {
  t.mock.method(globalThis, 'fetch', async () => answer('```json\n{"ok":true}\n```'));
  assert.deepEqual(await createJsonRequester(env, 'system')!('', {}, schema), { ok: true });
  await assert.rejects(createJsonRequester(env, 'system', { strictJson: true })!('', {}, schema), /JSON 结构/);
});

test('truncated output and absent content never count as successful JSON generation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return answer('{"ok":true}', { finish_reason: 'length' }); });
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'truncated');
  assert.equal(calls, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => answer(''));
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), /没有返回可用内容/);
});

const resumeSchema = z.object({
  document: z.object({
    headline: z.string(), summary: z.string(), theme: z.enum(['modern', 'classic']), accent: z.enum(['forest', 'navy', 'plum']),
    sections: z.array(z.object({ id: z.string(), title: z.string(), items: z.array(z.object({
      id: z.string(), title: z.string(), subtitle: z.string(), date: z.string(), content: z.string(), factIds: z.array(z.string()),
    })) })),
  }),
  rationale: z.string(), reviewNotes: z.array(z.string()),
});
const resumeOutput = {
  document: { headline: '合规实习', summary: '', theme: 'modern', accent: 'navy', sections: [{ id: 'experience', title: '项目经历', items: [{ id: 'research', title: '课程研究', subtitle: '', date: '', content: '参与课程资料检索。', factIds: ['fact-research'] }] }] },
  rationale: '按已确认经历整理。', reviewNotes: [],
};

test('one format repair fixes malformed nested resume JSON or misplaced required fields', async t => {
  const invalidOutputs = [
    JSON.stringify(resumeOutput).replace('"rationale":', '}"rationale":'),
    JSON.stringify({ document: { ...resumeOutput.document, rationale: resumeOutput.rationale, reviewNotes: [] } }),
  ];
  for (const invalid of invalidOutputs) {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answer(bodies.length === 1 ? invalid : JSON.stringify(resumeOutput));
    });
    const originalData = { confirmedFacts: [{ id: 'fact-research', text: '参与课程资料检索。' }] };
    const result = await createJsonRequester(env, '原系统约束', { strictJson: true })!('原任务：调整简历结构', originalData, resumeSchema);
    assert.deepEqual(result, resumeOutput); assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].messages[1], bodies[1].messages[1]);
    assert.deepEqual(JSON.parse(bodies[1].messages[1].content), { data: originalData });
    const repair = bodies[1].messages[0].content;
    assert.match(repair, /原系统约束/); assert.match(repair, /原任务：调整简历结构/); assert.match(repair, /唯一一次格式修复/);
    const schemaText = repair.split('JSON Schema：\n')[1];
    assert.deepEqual(JSON.parse(schemaText), z.toJSONSchema(resumeSchema, { unrepresentable: 'any' }));
    assert.ok(!repair.includes(invalid));
    t.mock.restoreAll();
  }
});

test('a second malformed result fails explicitly after exactly two calls', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return answer('{"private-provider-detail":'); });
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'invalid_json' && error.message.includes('一次格式修复仍未通过') && !error.message.includes('private-provider-detail'));
  assert.equal(calls, 2);
});

test('agent format diagnostics expose schema paths without private values or dynamic record keys', async t => {
  let calls = 0;
  const targetSchema = z.object({ requirements: z.array(z.object({ category: z.enum(['required', 'preferred']) }).strict()), notes: z.record(z.string(), z.number()) }).strict();
  t.mock.method(globalThis, 'fetch', async () => { calls++; return answer(JSON.stringify({ requirements: [{ category: 'private-output-value', 'private-extra-key': 'secret' }], notes: { 'private-person@example.com': 'secret' } })); });
  await assert.rejects(createJsonRequester(env, 'system', { formatRepair: false })!('', {}, targetSchema), error => {
    assert.ok(error instanceof ModelProviderError);
    assert.equal(error.code, 'invalid_json');
    assert.ok(error.schemaIssues?.some(issue => issue.path === '$.requirements[0].category'));
    assert.ok(error.schemaIssues?.some(issue => issue.path === '$.notes[field]'));
    assert.doesNotMatch(JSON.stringify(error), /private-|secret|example.com/);
    assert.ok((error.schemaIssues?.length || 0) <= 16);
    return true;
  });
  assert.equal(calls, 1);
});

test('strict JSON permits one repair of a fenced response but never accepts unchanged fences', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => answer(++calls === 1 ? '```json\n{"ok":true}\n```' : '{"ok":true}'));
  assert.deepEqual(await createJsonRequester(env, 'system', { strictJson: true })!('', {}, schema), { ok: true });
  assert.equal(calls, 2);
  t.mock.restoreAll(); calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return answer('```json\n{"ok":true}\n```'); });
  await assert.rejects(createJsonRequester(env, 'system', { strictJson: true })!('', {}, schema), /一次格式修复仍未通过/);
  assert.equal(calls, 2);
});

test('initial output and format repair share one total deadline and AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let firstBody!: ReadableStreamDefaultController<Uint8Array>;
  let repairCancelled = false;
  const signals: Array<AbortSignal | null | undefined> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    signals.push(init.signal);
    return new Response(signals.length === 1
      ? new ReadableStream<Uint8Array>({ start(controller) { firstBody = controller; } })
      : new ReadableStream<Uint8Array>({ cancel() { repairCancelled = true; } }));
  });
  const pending = createJsonRequester({ ...env, MODEL_TIMEOUT_MS: '10000' }, 'system')!('', {}, schema);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(6000);
  firstBody.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '{"ok":' }, finish_reason: 'stop' }] })));
  firstBody.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(signals.length, 2); assert.equal(signals[0], signals[1]);
  t.mock.timers.tick(3999); assert.equal(signals[1]?.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, error => error instanceof ModelProviderError && error.code === 'timeout');
  assert.equal(repairCancelled, true); assert.equal(signals.length, 2);
});

test('unusable API envelopes and schema-valid business content do not trigger format repair', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('upstream-not-JSON'); });
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), /未返回有效 JSON/);
  assert.equal(calls, 1);
  t.mock.restoreAll(); calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return answer('{"factIds":["unknown-id"]}'); });
  const result = await createJsonRequester(env, 'system')!('', {}, z.object({ factIds: z.array(z.string()) }));
  assert.deepEqual(result.factIds, ['unknown-id']); // Caller must apply factual-reference checks.
  assert.equal(calls, 1);
});

test('non-stop completion reasons reject even otherwise valid JSON', async t => {
  for (const reason of ['content_filter', 'aborted', 'insufficient_system_resource', 'tool_calls']) {
    t.mock.method(globalThis, 'fetch', async () => answer('{"ok":true}', { finish_reason: reason }));
    await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'invalid_response');
    t.mock.restoreAll();
  }
});

test('request deadline includes a streaming response body after successful headers', async t => {
  let cancelled = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const result = createJsonRequester({ ...env, MODEL_TIMEOUT_MS: '10000' }, 'system')!('', {}, schema);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  await assert.rejects(result, error => error instanceof ModelProviderError && error.code === 'timeout');
  assert.equal(cancelled, true);
});

test('oversized and malformed upstream bodies are rejected without exposing their content', async t => {
  for (const response of [new Response('small', { headers: { 'content-length': String(3 * 1024 * 1024) } }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'too_large');
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('private HTML diagnostic'));
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'invalid_json' && !error.message.includes('private'));
});

test('timeouts in fetch or streaming body remain explicit without fallback', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('secret-never-print', 'TimeoutError'); });
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), /超时/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('secret-never-print', 'TimeoutError')); } })));
  await assert.rejects(createJsonRequester(env, 'system')!('', {}, schema), error => error instanceof ModelProviderError && error.code === 'timeout' && !error.message.includes('secret-never-print'));
});

test('probe sends no profile data and requires the exact success object', async t => {
  let body = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { body = String(init.body); return answer(); });
  const result = await probeModel(env);
  assert.ok(Number.isFinite(Date.parse(result.at))); assert.ok(result.latencyMs >= 0);
  assert.match(body, /connection_test/); assert.doesNotMatch(body, /email|resume|phone/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => answer('{"ok":false}'));
  await assert.rejects(probeModel(env), /JSON 结构/);
});
