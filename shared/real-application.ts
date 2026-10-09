export type RealTargetStatus = 'pending' | 'needs_user' | 'filled' | 'submitting' | 'submitted' | 'unknown' | 'failed';
export interface RealTarget {
  id: string; company: string; title: string; url: string; applyUrl: string;
  status: RealTargetStatus; message?: string; evidence?: string; pageUrl?: string;
}
export interface RealApplicationRun {
  id: string; revision: number; createdAt: string; expiresAt: string; revokedAt?: string;
  resume: { id: string; version: number; label: string; sha256: string };
  targets: RealTarget[];
}
export interface AuthorizedApplicationRun extends RealApplicationRun {
  fields: { name: string; email: string; phone: string; school: string; education: string; major: string; graduation: string; city: string; availability: string };
}
export const REAL_STATUS: Record<RealTargetStatus, string> = {
  pending: '待填写', needs_user: '需要你处理', filled: '已填写，待核对', submitting: '正在提交', submitted: '页面显示投递成功', unknown: '结果待核验', failed: '未完成',
};
export function bytedanceTarget(value: string): Pick<RealTarget, 'id' | 'url' | 'applyUrl'> | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://jobs.bytedance.com' || url.username || url.password) return;
    const match = url.pathname.match(/^\/campus\/(?:position\/(\d{10,24})\/detail|resume\/(\d{10,24})\/apply)\/?$/u);
    if (!match) return;
    const id = match[1] || match[2];
    return { id, url: `https://jobs.bytedance.com/campus/position/${id}/detail`, applyUrl: `https://jobs.bytedance.com/campus/resume/${id}/apply` };
  } catch { return; }
}
