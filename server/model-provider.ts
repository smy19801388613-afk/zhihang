import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ModelProbeResult } from '../shared/model-config.ts';

export type ModelErrorCode = 'configuration' | 'authentication' | 'quota' | 'rate_limit' | 'provider' | 'network' | 'timeout' | 'redirect' | 'too_large' | 'truncated' | 'invalid_json' | 'invalid_response';
export class ModelProviderError extends Error {
  schemaIssues?: Array<{ path: string; code: string }>;
  constructor(public readonly code: ModelErrorCode, message: string, public readonly status: number | undefined = code === 'configuration' ? 400 : undefined) {
    super(message); this.name = 'ModelProviderError';
  }
}
// Return schema-owned field names only. Record keys and rejected values may contain
// private or adversarial text, so neither Zod messages nor unknown keys leave here.
function safeSchemaIssues(schema: z.ZodType, issues: z.core.$ZodIssue[]): Array<{ path: string; code: string }> {
  const fieldNames = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as Record<string, unknown>;
    if (object.properties && typeof object.properties === 'object') Object.keys(object.properties).forEach(key => fieldNames.add(key));
    Object.values(object).forEach(visit);
  };
  try { visit(z.toJSONSchema(schema, { unrepresentable: 'any' })); } catch { /* Root-level codes remain useful. */ }
  return issues.slice(0, 16).map(issue => ({
    path: '$' + issue.path.slice(0, 10).map(part => typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 10000
      ? `[${part}]` : typeof part === 'string' && fieldNames.has(part) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part) ? `.${part}` : '[field]').join(''),
    code: issue.code,
  }));
}
export interface ProviderConfig { baseUrl: string; endpoint: URL; model: string; apiKey: string; jsonMode: boolean; timeoutMs: number }
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const invalidUrl = () => new ModelProviderError('configuration', 'MODEL_BASE_URL 格式无效：使用无凭据和查询参数的 HTTPS 地址，本地服务可使用 HTTP。');

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalidUrl(); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw invalidUrl();
  return url.toString().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

export function readProviderConfig(env: NodeJS.ProcessEnv): ProviderConfig | null {
  const base = env.MODEL_BASE_URL?.trim(); const model = env.MODEL_NAME?.trim(); const apiKey = env.MODEL_API_KEY?.trim();
  if (!base && !model && !apiKey) return null;
  if (!base || !model || !apiKey) throw new ModelProviderError('configuration', '模型配置不完整：MODEL_BASE_URL、MODEL_NAME、MODEL_API_KEY 必须同时设置。');
  if (model.length > 200 || /[\r\n\x00-\x1f]/.test(model) || apiKey.length > 4096 || /[\r\n\x00-\x1f]/.test(apiKey)) throw new ModelProviderError('configuration', '模型名称或 API Key 格式无效。');
  const baseUrl = normalizeBaseUrl(base);
  const jsonValue = env.MODEL_JSON_MODE?.trim().toLowerCase();
  if (jsonValue && !['true', 'false'].includes(jsonValue)) throw new ModelProviderError('configuration', 'MODEL_JSON_MODE 只能设置为 true 或 false。');
  const timeoutMs = env.MODEL_TIMEOUT_MS?.trim() ? Number(env.MODEL_TIMEOUT_MS) : 90000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 180000) throw new ModelProviderError('configuration', 'MODEL_TIMEOUT_MS 必须是 10000 至 180000 毫秒的整数。');
  return { baseUrl, endpoint: new URL(baseUrl + '/chat/completions'), model, apiKey, jsonMode: jsonValue === 'true', timeoutMs };
}

function statusError(status: number): ModelProviderError {
  if (status === 401) return new ModelProviderError('authentication', 'API Key 无效或已失效（HTTP 401），请检查密钥；未切换到演示模式。', status);
  if (status === 403) return new ModelProviderError('authentication', '模型服务拒绝访问（HTTP 403），请检查账号权限和模型访问权限；未切换到演示模式。', status);
  if (status === 402) return new ModelProviderError('quota', '模型服务余额或额度不足（HTTP 402），请检查服务商账户；未切换到演示模式。', status);
  if (status === 429) return new ModelProviderError('rate_limit', '模型服务限流或额度不足（HTTP 429），请稍后重试并检查账户额度；未切换到演示模式。', status);
  if (status >= 300 && status < 400) return new ModelProviderError('redirect', '模型服务返回重定向，已停止请求以保护 API Key。请填写最终 API 地址。', status);
  if (status >= 500) return new ModelProviderError('provider', `模型服务暂时不可用（HTTP ${status}），请稍后重试；未切换到演示模式。`, status);
  return new ModelProviderError('provider', `模型服务请求失败（HTTP ${status}），请检查 API 地址、模型名称及 JSON 模式设置；未切换到演示模式。`, status);
}

async function readLimitedBody(response: Response, signal: AbortSignal): Promise<string> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) { void response.body?.cancel().catch(() => {}); throw new ModelProviderError('too_large', '模型响应超过大小限制，当前结果未保存。'); }
  if (!response.body) throw new ModelProviderError('invalid_response', '模型服务返回了空响应，请检查 API 地址。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let result = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { cancel(); throw new ModelProviderError('too_large', '模型响应超过大小限制，当前结果未保存。'); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function supportsImageInput(env: NodeJS.ProcessEnv): boolean {
  const config = readProviderConfig(env);
  return !!config && (config.endpoint.hostname === 'api.deepseek.com' && config.model === 'deepseek-flash' || ['localhost', '127.0.0.1', '[::1]'].includes(config.endpoint.hostname));
}
export function createJsonRequester(env: NodeJS.ProcessEnv, systemPrompt: string, options: { strictJson?: boolean; formatRepair?: boolean; maxOutputTokens?: number } = {}) {
  const config = readProviderConfig(env);
  if (!config) return null;
  const maxOutputTokens = options.maxOutputTokens ?? 8192;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 512 || maxOutputTokens > 65536) throw new ModelProviderError('configuration', '模型输出预算必须在 512 至 65,536 tokens 之间。');
  return async function request<T>(instruction: string, data: unknown, schema: z.ZodType<T>, media: { imageDataUrls?: string[] } = {}): Promise<T> {
    const images = media.imageDataUrls || [];
    if (images.length && !supportsImageInput(env)) throw new ModelProviderError('configuration', '当前连接未启用图片能力，请在模型设置选择 DeepSeek 的 deepseek-flash；文件文字仍可使用。');
    if (images.length > 3 || images.some(url => url.length > 12 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url))) throw new ModelProviderError('configuration', '图片输入格式或大小不符合要求，请重新上传。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), config!.timeoutMs);
    timer.unref();
    try {
      const deepSeek = config!.endpoint.hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(config!.model);
      const taskPrompt = `${systemPrompt}\n${instruction}\n只输出要求结构的 JSON。`;
      let repairPrompt = '';
      // Only the model content's syntax/shape can trigger this single repair.
      // Both requests share the original deadline; transport and business failures never retry here.
      for (let attempt = 0; attempt < (options.formatRepair === false ? 1 : 2); attempt++) {
        controller.signal.throwIfAborted();
        const response = await fetch(config!.endpoint, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { Authorization: `Bearer ${config!.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config!.model, temperature: 0.2, max_tokens: maxOutputTokens,
            ...(config!.jsonMode ? { response_format: { type: 'json_object' } } : {}),
            ...(deepSeek ? { thinking: { type: 'disabled' } } : {}),
            messages: [{ role: 'system', content: taskPrompt + repairPrompt }, { role: 'user', content: images.length ? [{ type: 'text', text: JSON.stringify({ data }) }, ...images.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } }))] : JSON.stringify({ data }) }],
          }),
        });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw statusError(response.status); }
        const body = await readLimitedBody(response, controller.signal);
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { throw new ModelProviderError('invalid_json', '模型服务未返回有效 JSON，请检查 API 地址。'); }
        const envelope = z.object({ choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable().optional() }) })).min(1) }).safeParse(payload);
        if (!envelope.success) throw new ModelProviderError('invalid_response', '模型响应格式无效，当前结果未保存；请检查接口兼容性。');
        const choice = envelope.data.choices[0];
        if (choice.finish_reason === 'length') throw new ModelProviderError('truncated', '模型输出达到长度限制，当前结果未保存。请缩短输入后重试。');
        if (choice.finish_reason != null && choice.finish_reason !== 'stop') throw new ModelProviderError('invalid_response', '模型未正常完成输出，当前结果未保存。请检查内容限制或稍后重试。');
        if (!choice.message.content?.trim()) throw new ModelProviderError('invalid_response', '模型没有返回可用内容，当前结果未保存。请检查模型和 JSON 模式设置。');
        let content = choice.message.content.trim();
        if (!options.strictJson) content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/, '').trim();
        let parsed: unknown;
        let structureError = '';
        let schemaIssues: ModelProviderError['schemaIssues'];
        try { parsed = JSON.parse(content); }
        catch { structureError = '输出不是合法的纯 JSON；请核对括号闭合、逗号、引号及转义，不要输出 Markdown 围栏。'; }
        if (!structureError) {
          const checked = schema.safeParse(parsed);
          if (checked.success) return checked.data;
          // Issue codes describe constraints without echoing untrusted values, keys, or diagnostics.
          const codes = [...new Set(checked.error.issues.map(issue => issue.code))].slice(0, 6);
          schemaIssues = safeSchemaIssues(schema, checked.error.issues);
          structureError = `JSON 字段缺失、类型或约束不符合目标结构（${codes.join('、')}）。请核对必填字段、层级、数组及字段类型。`;
        }
        if (options.formatRepair === false) {
          const error = new ModelProviderError('invalid_json', '模型返回的 JSON 结构不符合要求，交由本次整理的有限复核处理，当前结果未保存。');
          error.schemaIssues = schemaIssues;
          throw error;
        }
        if (attempt === 1) throw new ModelProviderError('invalid_json', '模型返回的 JSON 结构不符合要求，已尝试一次格式修复仍未通过，当前结果未保存；请重试。');
        let targetSchema: string;
        try { targetSchema = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' })); }
        catch { throw new ModelProviderError('invalid_json', '模型返回的 JSON 结构不符合要求，无法生成格式修复约束，当前结果未保存。'); }
        repairPrompt = `\n这是唯一一次格式修复请求。上次结构错误：${structureError}\n请依据上述原任务及原始 data 重新输出，仅修正 JSON 格式和字段结构，不得新增事实、经历、资格或数字，不得改变原任务约束。输出必须满足下面完整的 JSON Schema：\n${targetSchema}`;
      }
      throw new ModelProviderError('invalid_json', '模型返回的 JSON 结构不符合要求，当前结果未保存。');
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (controller.signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw new ModelProviderError('timeout', '模型请求超时，请重试；未切换到演示模式。');
      throw new ModelProviderError('network', '无法连接模型服务，请检查网络与配置；未切换到演示模式。');
    } finally { clearTimeout(timer); }
  };
}

export async function probeModel(env: NodeJS.ProcessEnv): Promise<ModelProbeResult> {
  const request = createJsonRequester(env, '这是连接和 JSON 能力探针。只输出 {"ok":true}。', { strictJson: true });
  if (!request) throw new ModelProviderError('configuration', '请先完整填写模型配置，再测试连接。');
  const start = performance.now();
  await request('只输出 JSON 对象 {"ok":true}，不附加其他内容。', { purpose: 'connection_test' }, z.object({ ok: z.literal(true) }).strict());
  return { at: new Date().toISOString(), latencyMs: Math.max(0, Math.round(performance.now() - start)) };
}
