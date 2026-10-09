(async () => {
  const url = location.href;
  const c = globalThis.__zhihangCapture;
  const platform = c.platformOf(url);
  if (!platform) return { url, jobs: [], reason: '当前岗位采集仅支持 BOSS直聘。请打开 BOSS 岗位页面，或手动粘贴对应的岗位 JD。' };
  let result = c.adapters[platform]();
  if (result.stabilityCheck) {
    // A SPA can switch jobs without navigating the tab. Verify a second bounded
    // job-only snapshot before returning, without observers or background reads.
    await new Promise(resolve => setTimeout(resolve, 120));
    const fresh = c.adapters[platform]();
    if (JSON.stringify(result.jobs) !== JSON.stringify(fresh.jobs) || result.reason !== fresh.reason) {
      return { url, platform, jobs: [], inlineDiagnostics: result.inlineDiagnostics ? { ...result.inlineDiagnostics, reason: 'changed_during_capture' } : undefined, reason: '采集期间左右分栏的岗位内容发生切换，已放弃此次结果。请等待详情稳定后重新点击扩展。' };
    }
    result = fresh;
  }
  if (location.href !== url) return { url, jobs: [], reason: '读取期间页面发生跳转，已放弃此次结果，请重新点击扩展。' };
  const capturedAt = new Date().toISOString();
  return { url, platform, capturedAt, jobs: result.jobs.map(job => {
    if (!job.fields.logoUrl) delete job.fields.logoUrl;
    return { ...job, platform, capturedAt };
  }), ...(result.inlineDiagnostics ? { inlineDiagnostics: result.inlineDiagnostics } : {}), reason: result.reason, adapterStatus: 'experimental' };
})();
