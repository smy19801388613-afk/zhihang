import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Link2, LoaderCircle, Puzzle, RefreshCw, Unplug } from 'lucide-react';

interface Connection { id: string; clientName: string; origin: string; createdAt: string; lastUsedAt?: string; expiresAt: string; revokedAt?: string }
interface ConnectionList { connections: Connection[]; extensionPath: string; extensionVersion: string; extensionDownloadUrl: string; serviceUrl: string }
const when = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '尚未使用';

export default function BrowserConnectionsPanel() {
  const [data, setData] = useState<ConnectionList | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const request = useRef(false);
  async function load() {
    const response = await fetch('/api/browser-connections', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法读取扩展连接，请确认本机服务仍在运行。');
    setData(result);
  }
  async function run(name: string, work: () => Promise<void>) {
    if (request.current) return;
    request.current = true; setBusy(name); setError(''); setNotice('');
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : '连接操作未完成，请重试。'); }
    finally { request.current = false; setBusy(''); }
  }
  useEffect(() => {
    void run('load', load);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const refresh = () => { if (!document.hidden) void run('load', load); };
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  const alive = (item: Connection) => !item.revokedAt && Date.parse(item.expiresAt) > now;
  const remaining = pair ? Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - now) / 1000)) : 0;
  async function createCode() {
    await run('pair', async () => {
      const response = await fetch('/api/browser-connections/pairing-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '配对码未能生成。');
      setPair(result); setNow(Date.now());
    });
  }
  async function revoke(item: Connection) {
    await run(item.id, async () => {
      const response = await fetch(`/api/browser-connections/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '断开失败，请重试。');
      await load(); setNotice(`已断开 ${item.clientName}，此前导入的岗位仍然保留。`);
    });
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label}已复制。`); }
    catch { setNotice(`浏览器未允许复制，请手动选择并复制${label}。`); }
  }
  async function downloadExtension() {
    await run('download', async () => {
      const response = await fetch(data?.extensionDownloadUrl || '/api/browser-extension/download', { cache: 'no-store' });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || '扩展下载失败，请重试。'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url;
      link.download = `zhihang-capture${data?.extensionVersion ? `-v${data.extensionVersion}` : ''}.zip`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('已发起扩展下载。请解压 ZIP，并加载解压后含 manifest.json 的文件夹。');
    });
  }
  return <section className="card browser-connections" data-testid="browser-connections" aria-labelledby="browser-connections-title">
    <div className="capture-section-heading"><span className="capture-heading-icon"><Puzzle size={23} /></span><div><h2 id="browser-connections-title">浏览器连接</h2><p>在 Chrome / Edge 查看岗位，确认后导入职航。</p></div></div>
    <div className="capture-setup-grid"><div className="capture-setup-step"><b>01</b><h3>下载并安装扩展{data?.extensionVersion && <small> · v{data.extensionVersion}</small>}</h3><button className="button secondary" disabled={!!busy} onClick={() => void downloadExtension()}>{busy === 'download' ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}下载扩展 ZIP</button><p>将 ZIP 解压到自己电脑上准备长期保留的位置。</p><p>Chrome 打开 <code>chrome://extensions</code>；Edge 打开 <code>edge://extensions</code>。启用「开发者模式」，选择「加载已解压的扩展程序」，加载刚才解压后含 <code>manifest.json</code> 的文件夹。</p><details className="capture-install-notes"><summary>高级：使用本机项目内的扩展</summary><p>已在这台电脑运行源码时，也可直接加载项目里的扩展。下载安装无需这个路径。</p><label className="field"><span>本机源码扩展目录（可选）</span><input readOnly value={data?.extensionPath || '正在读取本机路径…'} aria-label="扩展文件夹" /></label><button className="button quiet" disabled={!data?.extensionPath} onClick={() => data && void copy(data.extensionPath, '扩展路径')}><Copy size={14} />复制路径</button></details></div>
      <div className="capture-setup-step"><b>02</b><h3>与本机职航配对</h3><p>请在同一台电脑启动职航。将配对码填入扩展，5 分钟内有效，仅可使用一次。</p><label className="field"><span>本机服务地址</span><input readOnly value={data?.serviceUrl || 'http://127.0.0.1:4317'} aria-label="本机服务地址" /></label>{pair && <div className={`capture-pair-code ${remaining ? '' : 'expired'}`} role="status"><strong>{pair.code}</strong><span>{remaining ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒 · 一次性` : '配对码已过期，请重新生成'}</span>{!!remaining && <button className="button quiet" onClick={() => void copy(pair.code, '配对码')} aria-label="复制配对码"><Copy size={15} /></button>}</div>}<button className="button secondary" disabled={!!busy} onClick={() => void createCode()}>{busy === 'pair' ? <LoaderCircle size={14} className="spin" /> : <Link2 size={14} />}{pair ? '生成新配对码' : '生成配对码'}</button></div>
      <div className="capture-setup-step"><b>03</b><h3>预览后确认导入</h3><p>打开 BOSS直聘岗位，点击扩展「导入职航」，核对后确认。</p><p>每次最多 20 个已展示岗位；「详情待补充」可再次采集或手动填写。</p><details className="capture-install-notes"><summary>采集范围与限制</summary><p>首版实验适配：合成页面已测试，真实登录页仍待验收。结构不符可手动粘贴。</p><p>登录、验证码和访问限制请在原页面自行处理。</p></details></div></div>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="capture-notice" role="status"><Check size={15} />{notice}</p>}
    <div className="capture-section-heading compact"><div><h3>已配对的浏览器</h3><p>仅允许岗位导入，30 天有效，可随时断开。</p></div><button className="button quiet" disabled={!!busy} onClick={() => void run('load', load)}><RefreshCw size={14} className={busy === 'load' ? 'spin' : ''} />刷新连接状态</button></div>
    {data?.connections.length ? <div className="browser-connection-list">{data.connections.map(item => <article key={item.id}><div><strong>{item.clientName}</strong><span className={`tag ${alive(item) ? 'green' : 'neutral'}`}>{item.revokedAt ? '已断开' : alive(item) ? '已授权岗位导入' : '已过期'}</span><p>配对于 {when(item.createdAt)} · 最近使用 {when(item.lastUsedAt)}</p><small>有效至 {when(item.expiresAt)}</small><details><summary>浏览器扩展标识</summary><code>{item.origin}</code></details></div>{alive(item) && <button className="button quiet" disabled={!!busy} onClick={() => void revoke(item)}><Unplug size={14} />断开连接</button>}</article>)}</div> : <p className="capture-empty">尚未配对。安装扩展后，生成配对码完成首次连接。</p>}
  </section>;
}
