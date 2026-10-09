import { useEffect, useState } from 'react';
import { ExternalLink, ShieldCheck, RefreshCw, Trash2, Unplug, Copy } from 'lucide-react';
import type { Job, ResumeVersion } from '../../shared/types.ts';
import { bytedanceTarget, REAL_STATUS, type RealApplicationRun } from '../../shared/real-application.ts';
import { resumeLabel } from '../../shared/resume-scope.ts';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作未完成，请重试。'); return data;
}
export default function RealApplicationPanel({ resume, candidateIds, includeCurrentJob, targets, busy, blocked }: {
  resume: ResumeVersion; candidateIds: string[]; includeCurrentJob: boolean; targets: Job[]; busy: boolean; blocked: boolean;
}) {
  const [urls, setUrls] = useState(''); const [running, setRunning] = useState(false);
  const [error, setError] = useState(''); const [approved, setApproved] = useState(false);
  const [connection, setConnection] = useState<{ run: RealApplicationRun; code: string; codeExpiresAt: string }>();
  const allOfficial = targets.length > 0 && targets.every(target => !!bytedanceTarget(target.url));
  const extras = urls.split(/\s+/u).map(value => value.trim()).filter(Boolean);
  const valid = extras.every(value => !!bytedanceTarget(value)) && (extras.length > 0 || allOfficial);
  const signature = JSON.stringify([resume.id, candidateIds, includeCurrentJob, urls]);
  useEffect(() => { setApproved(false); setConnection(undefined); setError(''); }, [signature]);
  async function prepare() {
    setError(''); setRunning(true);
    try {
      const { revision } = await api<{ revision: number }>('/api/state');
      const result = await api<{ run: RealApplicationRun; code: string; codeExpiresAt: string }>('/api/real-applications', { method: 'POST', body: JSON.stringify({ resumeId: resume.id, expectedRevision: revision, candidateIds: allOfficial ? candidateIds : [], includeCurrentJob: allOfficial && includeCurrentJob, targetUrls: extras }) });
      setConnection(result); window.dispatchEvent(new Event('zhihang-real-applications'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '网申准备失败。'); } finally { setRunning(false); }
  }
  return <section className="real-application-panel">
    <h3><ShieldCheck size={19} /> 字节跳动 · 官网网申</h3>
    <p>共用简历 V{resume.version}，在你已登录的浏览器中填写。实验渠道：补全官网资料并逐岗核对后，由扩展确认提交。</p>
    <label>字节校招官网链接（每行一个）<textarea aria-label="字节校招官网链接" value={urls} onChange={e => setUrls(e.target.value)} rows={2} placeholder="https://jobs.bytedance.com/campus/position/职位ID/detail" disabled={running} /></label>
    {allOfficial ? <p>已选的 {targets.length} 个字节官网岗位将一并加入。</p> : targets.length > 0 ? <p>所选清单含其他来源，请在上方粘贴对应的字节官网链接。不会自动替换或猜测投递岗位。</p> : null}
    {extras.length > 0 && !valid && <p role="alert">请使用字节校招的岗位详情或简历填写链接。</p>}
    <label className="real-consent"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} disabled={running} />授权扩展读取这版简历的 PDF 与必要基本资料，仅用于本次列出的字节岗位。</label>
    <button className="button secondary" onClick={() => void prepare()} disabled={busy || blocked || running || !valid || !approved || !resume.approved || !!resume.stale}><ShieldCheck size={17} />{running ? '准备中…' : '生成本次网申授权码'}</button>
    {error && <p role="alert">{error}</p>}
    {connection && <div className="real-authorization">
      <strong>{resumeLabel(resume)} · V{resume.version}</strong>
      <ul>{connection.run.targets.map(target => <li key={target.id}><a href={target.applyUrl} target="_blank" rel="noreferrer">{target.title} <ExternalLink size={14} /></a></li>)}</ul>
      <div><code>{connection.code}</code> <button className="button ghost" onClick={() => void navigator.clipboard.writeText(connection.code).catch(() => setError('复制失败，请手动选择授权码复制。'))}><Copy size={16} />复制授权码</button></div>
      <p>5 分钟内有效、仅用一次。在上方官网填写页点击扩展，输入此码。查看记录或撤销授权请到「投递记录」。</p>
    </div>}
  </section>;
}

export function RealApplicationRecords({ busy = false }: { busy?: boolean }) {
  const [runs, setRuns] = useState<RealApplicationRun[]>([]); const [error, setError] = useState(''); const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  async function load() { try { const data = await api<{ runs: RealApplicationRun[] }>('/api/real-applications'); setRuns(data.runs); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败。'); } }
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener('zhihang-real-applications', refresh); return () => window.removeEventListener('zhihang-real-applications', refresh); }, []);
  async function mutate(id: string, remove: boolean) {
    setRunning(true);
    try { await api(`/api/real-applications/${encodeURIComponent(id)}${remove ? '' : '/revoke'}`, { method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ expectedRevision: runs.find(run => run.id === id)?.revision }) }); setDeleting(null); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败。'); } finally { setRunning(false); }
  }
  return <section className="real-application-records card">
    <div className="real-record-heading"><h3><ShieldCheck size={20} /> 官网网申</h3><button className="button ghost" onClick={() => void load()} disabled={running}><RefreshCw size={16} />刷新记录</button></div>
    {!runs.length && <p>审核简历后，在「选择投递岗位」中准备字节官网网申。</p>}
    {error && <p role="alert">{error}</p>}
    {runs.map(run => <article key={run.id} className="real-run">
      <strong>{run.resume.label} · V{run.resume.version}</strong>
      <p>{run.revokedAt ? '授权已撤销' : Date.parse(run.expiresAt) <= Date.now() ? '授权已到期' : `授权有效至 ${new Date(run.expiresAt).toLocaleTimeString()}`}</p>
      <ul>{run.targets.map(target => <li key={target.id}>
        <a href={target.applyUrl} target="_blank" rel="noreferrer">{target.company} · {target.title} <ExternalLink size={13} /></a>
        <span>{REAL_STATUS[target.status]}</span>{target.message && <p>{target.message}</p>}{target.evidence && <p>页面证据：{target.evidence}</p>}
      </li>)}</ul>
      {!run.revokedAt && Date.parse(run.expiresAt) > Date.now() ? <button className="button ghost" onClick={() => void mutate(run.id, false)} disabled={busy || running}><Unplug size={16} />撤销授权</button> : <button className="button ghost" onClick={() => setDeleting(run.id)} disabled={busy || running}><Trash2 size={16} />删除本地记录</button>}
      {deleting === run.id && <div role="dialog" aria-label="删除真实网申记录"><p>删除本地记录不会撤回官网申请，也会移除这些记录的重复投递提醒。若结果待核验，请先在官网确认。确认删除此批记录？</p><button className="button secondary" onClick={() => setDeleting(null)} disabled={running}>保留</button><button className="button danger" onClick={() => void mutate(run.id, true)} disabled={busy || running}>确认删除记录</button></div>}
    </article>)}
  </section>;
}
