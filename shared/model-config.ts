export type ModelProvider = 'custom' | 'deepseek' | 'qwen';
export interface ModelProbeResult { at: string; latencyMs: number }
export interface ModelSettingsPublic {
  revision: number;
  mode: 'demo' | 'live';
  source: 'none' | 'environment' | 'local';
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  timeoutMs: number;
  hasApiKey: boolean;
  lastTest?: ModelProbeResult;
  keyProtection?: 'dpapi' | 'file';
}
export interface ModelSettingsInput {
  expectedRevision: number;
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  jsonMode: boolean;
  timeoutMs: number;
}
export const MODEL_PRESETS: Record<ModelProvider, {
  label: string; baseUrl: string; model: string; models: string[]; jsonMode: boolean; timeoutMs: number;
}> = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], jsonMode: true, timeoutMs: 90000 },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus'], jsonMode: true, timeoutMs: 90000 },
  custom: { label: '兼容接口', baseUrl: '', model: '', models: [], jsonMode: false, timeoutMs: 90000 },
};
