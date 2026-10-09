import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import type { ModelProvider, ModelSettingsInput, ModelSettingsPublic, ModelProbeResult } from '../shared/model-config.ts';
import { normalizeBaseUrl, readProviderConfig } from './model-provider.ts';

export interface SecretProtector { kind: string; protect(value: string): string; unprotect(value: string): string }
export interface PreparedModelSettings { expectedRevision: number; env: NodeJS.ProcessEnv; settings: Omit<ModelSettingsPublic, 'revision' | 'source' | 'lastTest'> }
export class ModelSettingsError extends Error {
  constructor(public readonly status: 400 | 409 | 500, message: string) { super(message); this.name = 'ModelSettingsError'; }
}
const inputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), provider: z.enum(['custom', 'deepseek', 'qwen']),
  baseUrl: z.string().trim().min(1).max(2048), model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(4096).optional(), jsonMode: z.boolean(), timeoutMs: z.number().int().min(10000).max(180000),
}).strict();
const probeSchema = z.object({ at: z.string().datetime(), latencyMs: z.number().int().nonnegative() }).strict();
const storedSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), mode: z.enum(['demo', 'live']),
  provider: z.enum(['custom', 'deepseek', 'qwen']), baseUrl: z.string(), model: z.string(),
  jsonMode: z.boolean(), timeoutMs: z.number().int().min(10000).max(180000),
  secret: z.object({ kind: z.string(), value: z.string() }).optional(), lastTest: probeSchema.optional(),
}).strict();
type StoredSettings = z.infer<typeof storedSchema>;

function defaultProtector(): SecretProtector {
  if (process.platform !== 'win32') return { kind: 'file', protect: value => value, unprotect: value => value };
  const transform = (value: string, operation: 'protect' | 'unprotect'): string => {
    // The secret is sent over stdin. Process arguments contain only this fixed script.
    const script = operation === 'protect'
      ? 'Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($v); $c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($c))'
      : 'Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $c=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($c))';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0 || result.error || !result.stdout.trim()) throw new ModelSettingsError(500, '无法访问本机 API Key 保护服务，配置未保存。请检查当前 Windows 账户。');
    return result.stdout.trim();
  };
  return { kind: 'dpapi', protect: value => transform(value, 'protect'), unprotect: value => transform(value, 'unprotect') };
}
function inferProvider(base: string): ModelProvider {
  try {
    const host = new URL(base).hostname;
    if (host === 'api.deepseek.com') return 'deepseek';
    if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host)) return 'qwen';
  } catch { /* Keep malformed configuration out of the public URL field. */ }
  return 'custom';
}
function safeBase(base: string): string { try { return normalizeBaseUrl(base); } catch { return ''; } }
function settingsEnv(settings: { baseUrl: string; model: string; jsonMode: boolean; timeoutMs: number }, key: string): NodeJS.ProcessEnv {
  return { MODEL_BASE_URL: settings.baseUrl, MODEL_NAME: settings.model, MODEL_API_KEY: key, MODEL_JSON_MODE: String(settings.jsonMode), MODEL_TIMEOUT_MS: String(settings.timeoutMs) };
}

export class SettingsManager {
  private readonly path: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly protector: SecretProtector;
  private saved?: StoredSettings;
  private secret = '';
  private readonly candidates = new WeakSet<PreparedModelSettings>();

  constructor(private readonly dataDir: string, env: NodeJS.ProcessEnv, protector?: SecretProtector) {
    this.path = join(dataDir, 'model-settings.json'); this.environment = { ...env }; this.protector = protector || defaultProtector();
    if (existsSync(this.path)) {
      try {
        const content = readFileSync(this.path, 'utf8');
        if (content.length > 65536) throw new Error();
        this.saved = storedSchema.parse(JSON.parse(content));
        if (this.saved.secret) {
          if (this.saved.secret.kind !== this.protector.kind) throw new Error();
          this.secret = this.protector.unprotect(this.saved.secret.value);
        }
        if (this.saved.mode === 'live') readProviderConfig(settingsEnv(this.saved, this.secret));
      } catch { throw new ModelSettingsError(500, '无法读取本机模型配置。文件可能已损坏，或密钥属于其他系统账户；原文件已保留。'); }
    }
  }

  public(): ModelSettingsPublic {
    if (this.saved) {
      const { revision, mode, provider, baseUrl, model, jsonMode, timeoutMs, lastTest } = this.saved;
      return { revision, mode, source: 'local', provider, baseUrl, model, jsonMode, timeoutMs, hasApiKey: !!this.secret,
        ...(lastTest ? { lastTest: { ...lastTest } } : {}), keyProtection: this.protector.kind === 'dpapi' ? 'dpapi' : 'file' };
    }
    const env = this.environment;
    const base = env.MODEL_BASE_URL?.trim() || ''; const model = env.MODEL_NAME?.trim() || ''; const key = env.MODEL_API_KEY?.trim() || '';
    const hasConfig = !!(base || model || key);
    return { revision: 0, mode: base && model && key ? 'live' : 'demo', source: hasConfig ? 'environment' : 'none', provider: inferProvider(base),
      baseUrl: safeBase(base), model: /[\r\n\x00-\x1f]/.test(model) ? '' : model.slice(0, 200), jsonMode: env.MODEL_JSON_MODE?.toLowerCase() === 'true',
      timeoutMs: Math.max(10000, Math.min(180000, Number(env.MODEL_TIMEOUT_MS) || 90000)), hasApiKey: !!key };
  }

  env(): NodeJS.ProcessEnv {
    if (this.saved) return this.saved.mode === 'live' ? settingsEnv(this.saved, this.secret) : {};
    return { ...this.environment };
  }

  private assertRevision(expectedRevision: number) {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== this.public().revision) throw new ModelSettingsError(409, '模型配置已在其他页面更新，请刷新后再操作。');
  }

  prepare(input: ModelSettingsInput): PreparedModelSettings {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ModelSettingsError(400, '模型配置格式无效，请检查服务商、API 地址、模型名称和超时时间。');
    const value = parsed.data; this.assertRevision(value.expectedRevision);
    const current = this.public(); const baseUrl = normalizeBaseUrl(value.baseUrl);
    let key = value.apiKey?.trim() || '';
    if (!key && current.provider === value.provider && current.baseUrl === baseUrl) key = this.saved ? this.secret : this.environment.MODEL_API_KEY?.trim() || '';
    if (!key) throw new ModelSettingsError(400, '请输入 API Key；更换服务商或 API 地址后不能复用原密钥。');
    const env = settingsEnv({ ...value, baseUrl }, key);
    readProviderConfig(env);
    const candidate: PreparedModelSettings = {
      expectedRevision: value.expectedRevision, env,
      settings: { mode: 'live', provider: value.provider, baseUrl, model: value.model, jsonMode: value.jsonMode, timeoutMs: value.timeoutMs, hasApiKey: true, keyProtection: this.protector.kind === 'dpapi' ? 'dpapi' : 'file' },
    };
    Object.freeze(candidate.env); Object.freeze(candidate.settings); Object.freeze(candidate);
    this.candidates.add(candidate);
    return candidate;
  }

  commit(candidate: PreparedModelSettings, test: ModelProbeResult): ModelSettingsPublic {
    if (!this.candidates.has(candidate)) throw new ModelSettingsError(400, '模型配置候选无效，请重新测试连接。');
    this.assertRevision(candidate.expectedRevision);
    const verified = probeSchema.safeParse(test);
    if (!verified.success) throw new ModelSettingsError(400, '连接测试记录无效，配置未保存。');
    const config = readProviderConfig(candidate.env)!;
    const next: StoredSettings = {
      version: 1, revision: candidate.expectedRevision + 1, mode: 'live', provider: candidate.settings.provider,
      baseUrl: config.baseUrl, model: config.model, jsonMode: config.jsonMode, timeoutMs: config.timeoutMs,
      secret: this.protectKey(config.apiKey), lastTest: verified.data,
    };
    this.persist(next); this.saved = next; this.secret = config.apiKey; this.candidates.delete(candidate);
    return this.public();
  }

  disable(expectedRevision: number): ModelSettingsPublic {
    this.assertRevision(expectedRevision);
    const current = this.public();
    const key = this.saved ? this.secret : this.environment.MODEL_API_KEY?.trim() || '';
    const next: StoredSettings = {
      version: 1, revision: expectedRevision + 1, mode: 'demo', provider: current.provider, baseUrl: current.baseUrl,
      model: current.model, jsonMode: current.jsonMode, timeoutMs: Math.round(current.timeoutMs),
      ...(key ? { secret: this.protectKey(key) } : {}),
      ...(current.lastTest ? { lastTest: current.lastTest } : {}),
    };
    this.persist(next); this.saved = next; this.secret = key; return this.public();
  }

  private protectKey(key: string): { kind: string; value: string } {
    try { return { kind: this.protector.kind, value: this.protector.protect(key) }; }
    catch { throw new ModelSettingsError(500, '无法保护本机 API Key，配置未保存。请检查当前系统账户。'); }
  }

  private persist(settings: StoredSettings) {
    const temporary = join(this.dataDir, `.model-settings-${randomUUID()}.tmp`);
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch {
      try { unlinkSync(temporary); } catch { /* Only clean up this operation's temporary file. */ }
      throw new ModelSettingsError(500, '无法保存本机模型配置，请检查数据目录权限；原配置仍然有效。');
    }
  }
}
