import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, CircleCheck, FlaskConical, KeyRound, LoaderCircle, PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import { MODEL_PRESETS, type ModelProvider, type ModelSettingsPublic } from '../shared/model-config';
import './model-settings.css';

type SettingsDraft = {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  jsonMode: boolean;
  timeoutMs: number;
};
type ConnectionTest = { at: string; latencyMs: number };
type Props = {
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onSaved: (settings: ModelSettingsPublic) => Promise<void>;
};

const initialDraft = (): SettingsDraft => ({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '', jsonMode: true, timeoutMs: 90_000 });
const draftFrom = (saved: ModelSettingsPublic): SettingsDraft => saved.source === 'none' && !saved.hasApiKey
  ? initialDraft()
  : { provider: saved.provider, baseUrl: saved.baseUrl, model: saved.model, apiKey: '', jsonMode: saved.jsonMode, timeoutMs: saved.timeoutMs };
const endpoint = (value: string) => value.trim().replace(/\/+$/, '');
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function ModelSettingsPanel({ disabled, onDirty, onBusy, onSaved }: Props) {
  const [saved, setSaved] = useState<ModelSettingsPublic | null>(null);
  const [draft, setDraft] = useState<SettingsDraft>(initialDraft);
  const [pending, setPending] = useState<'load' | 'test' | 'save' | 'disable' | ''>('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const requestLock = useRef(false);
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(draftFrom(saved));
  const busy = !!pending || disabled;
  const canReuseKey = !!saved?.hasApiKey && saved.provider === draft.provider && endpoint(saved.baseUrl) === endpoint(draft.baseUrl);
  const keyNeeded = !canReuseKey && !draft.apiKey.trim();
  const valid = !!draft.baseUrl.trim() && !!draft.model.trim() && !keyNeeded && Number.isFinite(draft.timeoutMs) && draft.timeoutMs >= 10_000 && draft.timeoutMs <= 180_000;

  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    const handleUnload = (event: BeforeUnloadEvent) => { if (dirty || (pending && pending !== 'load')) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [dirty, pending]);

  async function load() {
    setPending('load'); setError('');
    try {
      const response = await fetch('/api/model-settings', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '模型设置暂时无法加载，请重试。');
      const settings = result as ModelSettingsPublic;
      setSaved(settings); setDraft(draftFrom(settings));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '模型设置暂时无法加载，请重试。'); }
    finally { setPending(''); }
  }
  useEffect(() => { void load(); }, []);

  function update<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft(previous => ({ ...previous, [key]: value })); setTest(null); setError(''); setNotice('');
  }
  function selectProvider(provider: ModelProvider) {
    const preset = MODEL_PRESETS[provider];
    setDraft({ provider, baseUrl: preset.baseUrl, model: preset.model, apiKey: '', jsonMode: preset.jsonMode, timeoutMs: preset.timeoutMs });
    setTest(null); setError(''); setNotice('');
  }
  function discard() {
    if (!saved) return;
    setDraft(draftFrom(saved)); setTest(null); setError(''); setNotice('未保存的设置已撤销。');
  }

  async function perform(action: 'test' | 'save' | 'disable') {
    if (!saved || requestLock.current || disabled || (action !== 'disable' && !valid)) return;
    requestLock.current = true; setPending(action); onBusy(true); setError(''); setNotice('');
    try {
      const body = action === 'disable' ? { expectedRevision: saved.revision } : {
        expectedRevision: saved.revision,
        provider: draft.provider, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
        jsonMode: draft.jsonMode, timeoutMs: draft.timeoutMs,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      };
      const response = await fetch(action === 'test' ? '/api/model-settings/test' : action === 'disable' ? '/api/model-settings/disable' : '/api/model-settings', {
        method: action === 'save' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (response.status === 409) {
        const latestResponse = await fetch('/api/model-settings', { cache: 'no-store' });
        if (latestResponse.ok) setSaved(await latestResponse.json() as ModelSettingsPublic);
        throw new Error('模型配置已在其他页面更新。你的输入仍保留，请核对当前连接信息后重新操作。');
      }
      if (!response.ok) throw new Error(result.error || '连接没有完成，请核对模型 ID、密钥和服务地址。');
      if (action === 'test') {
        setTest(result as ConnectionTest); setNotice('连接测试通过。点击“验证并启用”后，工作台才会使用这组配置。');
      } else {
        const settings = result as ModelSettingsPublic;
        setSaved(settings); setDraft(draftFrom(settings)); setTest(null); onDirty(false);
        await onSaved(settings);
        setNotice(action === 'save' ? `已启用 ${settings.model}。后续内容生成将调用真实模型，现有资料和简历版本已保留。` : '已切回本地演示模式，现有资料和简历版本已保留。');
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '连接没有完成，请稍后重试。';
      setError(draft.apiKey.trim() ? message.replaceAll(draft.apiKey.trim(), '••••••') : message);
    } finally { requestLock.current = false; setPending(''); onBusy(false); }
  }

  if (!saved) return <section className="card model-settings-loading">{pending === 'load' ? <><LoaderCircle size={22} className="spin" /><p>正在读取模型连接设置…</p></> : <><CircleAlert size={22} /><p role="alert">{error}</p><button className="button secondary" onClick={() => void load()}><RefreshCw size={15} />重新加载</button></>}</section>;

  return <div className="model-settings-layout">
    <section className="card model-settings-card">
      <div className="card-heading"><span className="model-settings-icon"><PlugZap size={21} /></span><div><h2>连接你的模型</h2><p>连接后，使用真实模型完成对话与简历生成。</p></div><span className={`tag ${saved.mode === 'live' ? 'green' : 'neutral'}`}>{saved.mode === 'live' ? '真实模型已启用' : '尚在演示模式'}</span></div>

      <div className={`model-current ${saved.mode === 'live' ? 'connected' : ''}`}>
        {saved.mode === 'live' ? <CircleCheck size={18} /> : <FlaskConical size={18} />}
        <div><strong>{saved.mode === 'live' ? saved.model : '本地规则演示'}</strong><p>{saved.mode === 'live' ? `${MODEL_PRESETS[saved.provider].label} · ${saved.source === 'environment' ? '环境变量配置' : '本机配置'}` : '填写下方配置，启用真实模型。'}</p>{saved.mode === 'live' && <small>{saved.baseUrl}</small>}{saved.lastTest && saved.mode === 'live' && <small>最近验证：{formatTime(saved.lastTest.at)} · {(saved.lastTest.latencyMs / 1000).toFixed(1)} 秒</small>}</div>
      </div>

      {error && <div className="alert error model-settings-feedback" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
      {notice && <div className="alert success model-settings-feedback" role="status"><CircleCheck size={17} /><span>{notice}</span></div>}

      <form onSubmit={event => { event.preventDefault(); void perform('save'); }} autoComplete="off">
        <fieldset disabled={busy} className="model-settings-fields">
          <label className="field"><span>模型服务商</span><select aria-label="模型服务商" value={draft.provider} onChange={event => selectProvider(event.target.value as ModelProvider)}>{(['deepseek', 'qwen', 'custom'] as const).map(provider => <option key={provider} value={provider}>{MODEL_PRESETS[provider].label}</option>)}</select></label>
          <label className="field"><span>API 服务地址</span><input aria-label="API 基础地址" type="url" value={draft.baseUrl} maxLength={2000} spellCheck={false} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.deepseek.com" required /><small>填写服务商提供的 API 基础地址。</small></label>
          <label className="field"><span>模型 ID</span><input aria-label="模型名称" value={draft.model} maxLength={200} list="model-id-options" onChange={event => update('model', event.target.value)} placeholder={draft.provider === 'custom' ? '填写服务商的准确模型 ID' : MODEL_PRESETS[draft.provider].model} spellCheck={false} required /><datalist id="model-id-options">{MODEL_PRESETS[draft.provider].models.map(model => <option value={model} key={model} />)}</datalist><small>使用当前账户可调用的模型 ID。</small></label>
          <label className="field"><span><KeyRound size={13} /> API 密钥</span><input aria-label="API Key" type="password" name="model-api-key" autoComplete="new-password" value={draft.apiKey} maxLength={4096} spellCheck={false} onChange={event => update('apiKey', event.target.value)} placeholder={canReuseKey ? '本机已有密钥；留空沿用，填写则替换' : '粘贴服务商的 API Key'} required={!canReuseKey} /><small>{canReuseKey ? '留空沿用已有密钥，填写则替换。' : saved.hasApiKey ? '服务商或地址已变更，请重新填写对应密钥。' : '密钥仅保存在本机服务端。'}</small></label>

          <div className="model-settings-links">
            {draft.provider === 'deepseek' && <><a href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">获取 DeepSeek 密钥<ArrowUpRight size={13} /></a><a href="https://api-docs.deepseek.com/" target="_blank" rel="noreferrer">官方接入文档<ArrowUpRight size={13} /></a></>}
            {draft.provider === 'qwen' && <p>默认地址为百炼中国内地区域，API 密钥需要与所选服务地域匹配。</p>}
            {draft.provider === 'custom' && <p>支持兼容 Chat Completions 的服务。模型需能按要求返回结构化 JSON。</p>}
          </div>

          <details className="model-advanced"><summary>高级设置<span>结构化输出与请求时限</span></summary><div><label className="model-checkbox"><input aria-label="启用 JSON 模式" type="checkbox" checked={draft.jsonMode} onChange={event => update('jsonMode', event.target.checked)} /><span><strong>请求 JSON 格式输出</strong><small>服务商支持时建议开启。关闭后，模型仍须返回合法 JSON。</small></span></label><label className="field"><span>请求超时（秒）</span><input aria-label="请求超时（秒）" type="number" min={10} max={180} step={1} value={draft.timeoutMs ? draft.timeoutMs / 1000 : ''} onChange={event => update('timeoutMs', Number(event.target.value) * 1000)} /><small>允许 10–180 秒；较长的简历生成可能需要更多时间。</small></label></div></details>

          <div className="model-settings-actions"><button type="button" className="button secondary" disabled={!valid || busy} onClick={() => void perform('test')}>{pending === 'test' ? <LoaderCircle size={16} className="spin" /> : <PlugZap size={16} />}测试连接</button><button className="button primary" type="submit" disabled={!valid || busy}>{pending === 'save' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}验证并启用</button>{dirty && <button type="button" className="button quiet" onClick={discard}>放弃未保存修改</button>}</div>
          {test && <p className="model-test-result"><CircleCheck size={14} />本次输入已通过测试 · {(test.latencyMs / 1000).toFixed(1)} 秒 · 尚未保存启用</p>}
          {pending === 'test' || pending === 'save' ? <p className="model-wait-note" role="status">正在联系模型服务，请稍候。最长等待 {draft.timeoutMs / 1000} 秒。</p> : null}
        </fieldset>
      </form>
      {saved.mode === 'live' && <div className="model-disable"><div><strong>暂时使用演示模式</strong><p>停止新的模型请求，继续查看和编辑已有资料。</p></div><button type="button" className="button quiet" disabled={busy || dirty} onClick={() => void perform('disable')}>{pending === 'disable' ? <LoaderCircle size={15} className="spin" /> : <FlaskConical size={15} />}切回演示模式</button></div>}
    </section>

    <aside className="model-settings-aside"><section className="guide-card"><h2>连接后会怎样？</h2><ol><li><span>1</span><div><strong>填写并测试</strong><p>测试只发送固定的连接测试文本，不包含个人档案。</p></div></li><li><span>2</span><div><strong>验证并启用</strong><p>任务所需经历与岗位文本会发送给模型服务商，可能产生调用费用。</p></div></li><li><span>3</span><div><strong>继续审核结果</strong><p>生成内容由你审核；不会自动提交申请。</p></div></li></ol></section><section className="model-security-note"><ShieldCheck size={19} /><div><strong>密钥保存在本机服务端</strong><p>{saved.keyProtection === 'dpapi' ? '保存时使用 Windows 当前用户加密保护。' : '密钥不会显示在页面或随个人档案返回。'} 密钥输入不会写入浏览器存储，保存后会清空。</p></div></section><section className="model-simulation-note"><FlaskConical size={18} /><p><strong>模型接入与投递执行分开</strong>真实模型负责理解和生成；自动投递目前仍只在本地测试站运行。</p></section></aside>
  </div>;
}
