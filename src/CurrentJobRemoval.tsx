import { useState } from 'react';
import type { Action, Job, WorkspaceState } from '../shared/types';
import InlineRemovalConfirm from './InlineRemovalConfirm';

export default function CurrentJobRemoval({ job, busy, dirty, act }: {
  job: Job; busy: boolean; dirty: boolean; act: (action: Action, message?: string) => Promise<WorkspaceState | null>;
}) {
  const [confirm, setConfirm] = useState(false);
  return <section className="current-job-controls" aria-label="当前岗位操作">
    <div className="current-job-control-heading"><p><span>当前岗位</span><strong>{job.company || '未填写公司'} · {job.title || '未填写岗位'}</strong></p><button type="button" className="button quiet danger-text" disabled={busy || dirty} onClick={() => setConfirm(true)}>移除当前岗位</button></div>
    {confirm && <InlineRemovalConfirm title="移除当前岗位？" confirmLabel="确认移除岗位" busy={busy} disabled={dirty} onCancel={() => setConfirm(false)} onConfirm={() => void act({ type: 'clear_job' }, '当前岗位已从工作区移除。来源岗位清单和历史简历保留。')}><p>从当前工作区移除“{job.company} · {job.title}”及其匹配分析，结束当前面试对话。</p><p>来源岗位清单、喜欢状态与历史简历继续保留；正在查看的简历版本也不会被删除。</p></InlineRemovalConfirm>}
  </section>;
}
