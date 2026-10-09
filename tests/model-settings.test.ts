import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SettingsManager, ModelSettingsError, type SecretProtector } from '../server/model-settings.ts';
import type { ModelSettingsInput } from '../shared/model-config.ts';

const protector: SecretProtector = { kind: 'test-only', protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString('utf8') };
const input: ModelSettingsInput = { expectedRevision: 0, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'secret-never-print', jsonMode: true, timeoutMs: 90000 };
const probe = { at: '2026-10-02T12:00:00.000Z', latencyMs: 120 };
function directory(t: TestContext) {
  const base = resolve(tmpdir()); const path = mkdtempSync(join(base, 'zhihang-model-settings-'));
  t.after(() => { const target = resolve(path); if (!target.startsWith(base + sep) || !target.includes('zhihang-model-settings-')) throw new Error('Unsafe temporary cleanup'); rmSync(target, { recursive: true, force: true }); });
  return path;
}

test('public settings contain no key and an uncommitted candidate changes nothing', t => {
  const manager = new SettingsManager(directory(t), {}, protector);
  assert.equal(manager.public().mode, 'demo'); assert.equal(manager.public().source, 'none');
  const candidate = manager.prepare(input);
  assert.equal(candidate.env.MODEL_API_KEY, input.apiKey);
  assert.equal(manager.public().hasApiKey, false); assert.equal(manager.public().revision, 0);
  assert.deepEqual(manager.env(), {});
  assert.doesNotMatch(JSON.stringify(manager.public()), /secret-never-print|apiKey/);
});

test('successful commit persists protected key and JSON probe metadata across restart', t => {
  const path = directory(t); const manager = new SettingsManager(path, {}, protector);
  const saved = manager.commit(manager.prepare(input), probe);
  assert.equal(saved.revision, 1); assert.equal(saved.mode, 'live'); assert.equal(saved.source, 'local'); assert.deepEqual(saved.lastTest, probe);
  assert.doesNotMatch(JSON.stringify(saved), /secret-never-print/);
  assert.doesNotMatch(readFileSync(join(path, 'model-settings.json'), 'utf8'), /secret-never-print/);
  const restored = new SettingsManager(path, { MODEL_API_KEY: 'different-env-key' }, protector);
  assert.equal(restored.env().MODEL_API_KEY, input.apiKey); assert.deepEqual(restored.public(), saved);
  if (process.platform !== 'win32') assert.equal(statSync(join(path, 'model-settings.json')).mode & 0o777, 0o600);
});

test('blank key can be reused only for the same provider and normalized origin/path', t => {
  const manager = new SettingsManager(directory(t), {}, protector);
  manager.commit(manager.prepare(input), probe);
  const reused = manager.prepare({ ...input, expectedRevision: 1, apiKey: '', baseUrl: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-pro' });
  assert.equal(reused.env.MODEL_API_KEY, input.apiKey);
  for (const change of [{ provider: 'custom' as const }, { baseUrl: 'https://other.example' }, { baseUrl: 'https://api.deepseek.com/other' }]) {
    assert.throws(() => manager.prepare({ ...input, expectedRevision: 1, apiKey: '', ...change }), /不能复用/);
  }
});

test('stale candidates cannot overwrite newer configuration and test metadata is required', t => {
  const manager = new SettingsManager(directory(t), {}, protector);
  const first = manager.prepare(input); const stale = manager.prepare(input);
  assert.throws(() => manager.commit(first, { at: 'not-a-date', latencyMs: 0 }), /测试记录/);
  manager.commit(first, probe);
  assert.throws(() => manager.commit(stale, probe), /其他页面更新/);
  assert.throws(() => manager.disable(0), error => error instanceof ModelSettingsError && error.status === 409);
  assert.throws(() => manager.commit({ ...first }, probe), /候选无效/);
});

test('disable persists demo mode and retains protected credentials for explicit reuse', t => {
  const path = directory(t); const manager = new SettingsManager(path, {}, protector);
  manager.commit(manager.prepare(input), probe);
  const disabled = manager.disable(1);
  assert.equal(disabled.revision, 2); assert.equal(disabled.mode, 'demo'); assert.equal(disabled.hasApiKey, true); assert.deepEqual(manager.env(), {});
  const restored = new SettingsManager(path, { MODEL_BASE_URL: 'https://other.example', MODEL_NAME: 'other', MODEL_API_KEY: 'environment-key' }, protector);
  assert.equal(restored.public().mode, 'demo'); assert.deepEqual(restored.env(), {});
  assert.equal(restored.prepare({ ...input, expectedRevision: 2, apiKey: '' }).env.MODEL_API_KEY, input.apiKey);
});

test('environment config is visible without key and can be promoted or disabled', t => {
  const manager = new SettingsManager(directory(t), { MODEL_BASE_URL: input.baseUrl, MODEL_NAME: input.model, MODEL_API_KEY: input.apiKey }, protector);
  assert.equal(manager.public().source, 'environment'); assert.equal(manager.public().provider, 'deepseek');
  assert.equal(manager.public().lastTest, undefined);
  assert.doesNotMatch(JSON.stringify(manager.public()), /secret-never-print/);
  assert.equal(manager.prepare({ ...input, apiKey: '' }).env.MODEL_API_KEY, input.apiKey);
  manager.disable(0); assert.deepEqual(manager.env(), {});
});

test('failed key protection never activates or writes a replacement configuration', t => {
  const manager = new SettingsManager(directory(t), {}, { kind: 'failing', protect: () => { throw new Error('Protection unavailable'); }, unprotect: value => value });
  assert.throws(() => manager.commit(manager.prepare(input), probe), error => error instanceof ModelSettingsError && error.status === 500 && !error.message.includes('Protection unavailable'));
  assert.equal(manager.public().revision, 0); assert.equal(manager.public().mode, 'demo');
});

test('default Windows protector round trips an actual DPAPI secret', { skip: process.platform !== 'win32' }, t => {
  const path = directory(t); const manager = new SettingsManager(path, {});
  const saved = manager.commit(manager.prepare(input), probe);
  assert.equal(saved.keyProtection, 'dpapi');
  assert.doesNotMatch(readFileSync(join(path, 'model-settings.json'), 'utf8'), /secret-never-print/);
  assert.equal(new SettingsManager(path, {}).env().MODEL_API_KEY, input.apiKey);
});
