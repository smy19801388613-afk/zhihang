const $ = id => document.getElementById(id);
const snapshotId = new URL(location.href).searchParams.get('snapshot');
let entries = [];
let connected = false;
let busy = false;
let requestId = null;
let lastPayload = '';
const extensionVersion = chrome.runtime.getManifest().version;
let diagnosticReport = null;
const editable = [['company', '公司', 200], ['title', '岗位名称', 200], ['city', '城市', 100], ['salary', '薪资原文（保留币种/单位）', 200], ['education', '学历要求', 200], ['experience', '经验要求', 200], ['industry', '行业（有页面依据才填写）', 200], ['jd', '岗位描述 / JD', 16000]];
const node = (tag, content, className) => { const element = document.createElement(tag); if (content !== undefined) element.textContent = content; if (className) element.className = className; return element; };
function message(value, error = false) { $('message').textContent = value; $('message').className = error ? 'error' : ''; }
function safeVersion(value) { return typeof value === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value) ? value : null; }
function captureDiagnosticReport(snapshot) {
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.slice(0, 20) : [];
  const reasonValues = ['missing_company_region', 'missing_company_name', 'ambiguous_company_name', 'company_found'];
  const strategyValues = ['selector', 'heading', 'logo_row', 'none'];
  const tagValues = ['DIV', 'SECTION', 'ASIDE', 'ARTICLE', 'LI', 'P', 'A', ''];
  const classValues = ['sider-company', 'sider-company-info', 'job-company-info', 'company-basic-info', 'company-info', 'job-sider'];
  const countKeys = ['regions', 'headings', 'nameNodes', 'companyLinks', 'visibleLogos', 'names'];
  const diagnosticJobs = jobs.map((job, index) => {
    const raw = job.companyDiagnostics;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // Reconstruct every property. Never serialize adapter/page objects directly.
    const companyDiagnostics = {};
    if (reasonValues.includes(raw.reason)) companyDiagnostics.reason = raw.reason;
    if (strategyValues.includes(raw.strategy)) companyDiagnostics.strategy = raw.strategy;
    if (tagValues.includes(raw.regionTag)) companyDiagnostics.regionTag = raw.regionTag;
    if (Array.isArray(raw.regionClasses)) companyDiagnostics.regionClasses = [...new Set(raw.regionClasses.filter(value => classValues.includes(value)))].slice(0, classValues.length);
    if (raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)) {
      companyDiagnostics.counts = {};
      for (const key of countKeys) if (Number.isInteger(raw.counts[key]) && raw.counts[key] >= 0 && raw.counts[key] <= 200) companyDiagnostics.counts[key] = raw.counts[key];
    }
    if (!Object.keys(companyDiagnostics).length) return null;
    return { index: index + 1, platform: job.platform === 'boss' ? 'boss' : 'unknown', pageKind: ['detail', 'list', 'manual'].includes(job.pageKind) ? job.pageKind : 'unknown', companyDiagnostics };
  }).filter(Boolean);
  let inlineDiagnostics;
  const inline = snapshot.inlineDiagnostics;
  const inlineReasons = ['matched', 'missing_panel', 'missing_header', 'missing_identity', 'identity_conflict', 'loading', 'missing_detail', 'changed_during_capture'];
  const inlineCounts = ['cards', 'selectedCards', 'panels', 'identifiedPanels', 'descriptionPanels'];
  if (inline && typeof inline === 'object' && !Array.isArray(inline) && inlineReasons.includes(inline.reason)) {
    inlineDiagnostics = { reason: inline.reason, counts: {} };
    if (inline.counts && typeof inline.counts === 'object' && !Array.isArray(inline.counts)) {
      for (const key of inlineCounts) if (Number.isInteger(inline.counts[key]) && inline.counts[key] >= 0 && inline.counts[key] <= 200) inlineDiagnostics.counts[key] = inline.counts[key];
    }
  }
  if (!diagnosticJobs.length && !inlineDiagnostics) return null;
  return {
    reportVersion: 1, extensionVersion: safeVersion(extensionVersion), snapshotVersion: safeVersion(snapshot.extensionVersion),
    jobsCount: jobs.length, emptyCompanyCount: jobs.filter(job => typeof job.fields?.company !== 'string' || !job.fields.company.trim()).length,
    jobs: diagnosticJobs, ...(inlineDiagnostics ? { inlineDiagnostics } : {}),
  };
}
async function send(type, values = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...values });
  if (!reply?.ok) throw new Error(reply?.error || '扩展连接中断，请重新打开扩展。');
  return reply.data;
}
function controls() {
  const selected = entries.filter(entry => entry.selected).length;
  $('count').textContent = entries.length ? `${entries.length} 条` : '';
  $('selection').textContent = `已选择 ${selected} 条 · 最多 20 条`;
  $('import').disabled = busy || !connected || selected === 0;
  $('import').textContent = busy ? '正在导入…' : '确认导入职航';
  $('pair-form').hidden = connected;
  $('disconnect').hidden = !connected;
}
async function persist() {
  if (!snapshotId) return;
  const { drafts = {} } = await chrome.storage.session.get('drafts');
  await chrome.storage.session.set({ drafts: { ...drafts, [snapshotId]: entries } });
}
function changed(entry, field, value) {
  entry.value[field] = value;
  if (value === entry.original.fields[field]) delete entry.edits[field]; else entry.edits[field] = value;
  void persist();
}
function render() {
  $('jobs').replaceChildren();
  entries.forEach((entry, index) => {
    const card = node('article', undefined, 'job');
    const head = node('div', undefined, 'job-head');
    const title = node('label', undefined, 'job-title');
    const selected = document.createElement('input'); selected.type = 'checkbox'; selected.checked = entry.selected;
    selected.setAttribute('aria-label', `选择岗位 ${index + 1}`);
    selected.addEventListener('change', () => { entry.selected = selected.checked; controls(); void persist(); });
    title.append(selected, node('span', entry.value.title || `待补充岗位 ${index + 1}`));
    const badge = node('span', entry.value.jdComplete ? '详情已读取 · 请核对' : '详情待补充', `badge${entry.value.jdComplete ? '' : ' incomplete'}`);
    head.append(title, badge); card.append(head);
    const fields = node('div', undefined, 'fields');
    if (entry.original.pageKind === 'manual') {
      const platformLabel = node('label', '来源平台'); const select = document.createElement('select');
      for (const [value, text] of [['boss', 'BOSS直聘']]) { const option = node('option', text); option.value = value; select.append(option); }
      select.value = entry.original.platform; select.addEventListener('change', () => { entry.original.platform = select.value; void persist(); }); platformLabel.append(select); fields.append(platformLabel);
      const urlLabel = node('label', '原始岗位详情链接', 'wide'); const input = document.createElement('input'); input.type = 'url'; input.maxLength = 2000; input.value = entry.original.sourceUrl; input.placeholder = 'https://www.zhipin.com/job_detail/…';
      input.addEventListener('input', () => { entry.original.sourceUrl = input.value.trim(); void persist(); }); urlLabel.append(input); fields.append(urlLabel);
    }
    editable.forEach(([field, label, max]) => {
      const wrapper = node('label', label, field === 'jd' ? 'wide' : '');
      const input = document.createElement(field === 'jd' ? 'textarea' : 'input'); input.maxLength = max; input.value = entry.value[field] || ''; input.dataset.field = field;
      input.addEventListener('input', () => { changed(entry, field, input.value); card.classList.toggle('edited', Object.keys(entry.edits).length > 0); if (field === 'title') title.lastChild.textContent = input.value || `待补充岗位 ${index + 1}`; });
      wrapper.append(input); fields.append(wrapper);
    });
    card.append(fields);
    const completeLabel = node('label', undefined, 'complete'); const complete = document.createElement('input'); complete.type = 'checkbox'; complete.checked = entry.value.jdComplete;
    complete.addEventListener('change', () => { changed(entry, 'jdComplete', complete.checked); badge.textContent = complete.checked ? '完整 JD · 请核对' : '详情待补充'; badge.className = `badge${complete.checked ? '' : ' incomplete'}`; });
    completeLabel.append(complete, node('span', '我已核对这是完整 JD（列表摘要请勿勾选）')); card.append(completeLabel);
    card.append(node('p', '修改的字段会作为人工修正保留。已在职航手动修订的字段会保留；需要再次更改请在职航“浏览器导入记录”中修改。缺失信息可留空。', 'help'));
    const source = node('div', `BOSS直聘 · ${entry.original.pageKind === 'manual' ? '手动粘贴' : entry.original.pageKind === 'list' ? '结果列表' : '岗位详情'} · ${new Date(entry.original.capturedAt).toLocaleString('zh-CN')} `, 'source');
    try { const url = new URL(entry.original.sourceUrl); if (url.protocol === 'https:') { const link = node('a', '打开原始岗位 ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer noopener'; source.append(link); } } catch {}
    card.append(source); $('jobs').append(card);
  });
  controls();
}
async function status() {
  try { const result = await send('status'); connected = result.connected === true; $('connection-state').textContent = connected ? `已连接 · 凭证有效至 ${new Date(result.expiresAt).toLocaleString('zh-CN')}` : '尚未配对。请在职航的“浏览器扩展”入口生成一次性配对码。'; }
  catch (error) { connected = false; $('connection-state').textContent = error.message; }
  controls();
}
$('pair-form').addEventListener('submit', async event => { event.preventDefault(); try { await send('pair', { code: $('pair-code').value }); $('pair-code').value = ''; message('已与本机职航配对，可以导入所选岗位。'); await status(); } catch (error) { message(error.message, true); } });
$('disconnect').addEventListener('click', async () => { try { await send('disconnect'); message('连接已撤销。再次导入需要重新配对。'); await status(); } catch (error) { message(`未能撤销连接：${error.message} 也可在职航的扩展连接页撤销。`, true); } });
$('select-all').addEventListener('click', () => { entries.forEach(entry => { entry.selected = true; }); render(); void persist(); });
$('select-none').addEventListener('click', () => { entries.forEach(entry => { entry.selected = false; }); render(); void persist(); });
$('copy-diagnostics').addEventListener('click', async () => {
  if (!diagnosticReport) return;
  const text = JSON.stringify(diagnosticReport, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('diagnostic-fallback').hidden = true;
    $('diagnostic-status').textContent = '采集诊断已复制，你可以自行粘贴给协助排查的人。';
  } catch {
    $('diagnostic-text').value = text;
    $('diagnostic-fallback').hidden = false;
    $('diagnostic-status').textContent = '浏览器未允许自动复制。请手动选择并复制下方诊断。';
    $('diagnostic-text').focus(); $('diagnostic-text').select();
  }
});
$('manual').addEventListener('click', () => {
  if (entries.length >= 20) { message('本次最多预览 20 条。请先导入，或重新打开扩展创建新的预览。', true); return; }
  const fields = { company: '', title: '', city: '', salary: '', education: '', experience: '', industry: '', jd: '', jdComplete: false };
  entries.push({ original: { platform: 'boss', sourceUrl: '', capturedAt: new Date().toISOString(), pageKind: 'manual', fields }, value: { ...fields }, edits: {}, selected: true }); render(); void persist(); $('jobs').lastChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('import').addEventListener('click', async () => {
  const selected = entries.filter(entry => entry.selected);
  // Diagnostic metadata stays in the preview and never enters the import API.
  const jobs = selected.map(entry => ({ platform: entry.original.platform, sourceUrl: entry.original.sourceUrl, capturedAt: entry.original.capturedAt, pageKind: entry.original.pageKind, fields: entry.original.fields, ...(Object.keys(entry.edits).length ? { edits: entry.edits } : {}) }));
  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i];
    if (!entry.value.title.trim() || !entry.value.company.trim()) { message(`第 ${i + 1} 个已选岗位缺少公司或岗位名称，请补充后导入。`, true); return; }
    if (entry.value.jdComplete && !entry.value.jd.trim()) { message(`第 ${i + 1} 个已选岗位没有 JD，不能标记为完整详情。`, true); return; }
    try { const url = new URL(entry.original.sourceUrl); if (entry.original.platform !== 'boss' || url.protocol !== 'https:' || url.username || url.password || url.port || !['zhipin.com', 'www.zhipin.com'].includes(url.hostname) || !/^\/job_detail\/[a-zA-Z0-9_-]+\.html$/u.test(url.pathname)) throw new Error(); } catch { message(`第 ${i + 1} 个已选岗位需要有效的 BOSS直聘 HTTPS 原始详情链接。`, true); return; }
  }
  const payload = JSON.stringify(jobs);
  if (payload !== lastPayload || !requestId) { requestId = crypto.randomUUID(); lastPayload = payload; }
  busy = true; controls();
  try {
    const result = await send('import', { body: { protocolVersion: 1, requestId, jobs } });
    const errors = Array.isArray(result.errors) ? result.errors : [];
    message(`导入完成：新增 ${result.imported || 0} 条，补全/更新 ${result.updated || 0} 条，重复 ${result.duplicates || 0} 条。${errors.length ? '\n' + errors.map(error => `第 ${error.index + 1} 条：${error.message}`).join('\n') : '\n已进入职航岗位池，可继续滑卡与准备简历。'}`, errors.length > 0);
    selected.forEach((entry, index) => { if (!errors.some(error => error.index === index)) entry.selected = false; });
    await persist(); render();
  } catch (error) { message(error.message, true); }
  finally { busy = false; controls(); }
});
async function initialize() {
  $('extension-version').textContent = `v${extensionVersion}`;
  if (snapshotId) {
    const { snapshots = {}, drafts = {} } = await chrome.storage.session.get(['snapshots', 'drafts']);
    const snapshot = snapshots[snapshotId];
    if (snapshot) {
      const previous = drafts[snapshotId] || snapshot.jobs.map(job => ({ original: job, value: { ...job.fields }, edits: {}, selected: true }));
      entries = previous.filter(entry => entry.original.platform === 'boss');
      if (entries.length !== previous.length) $('capture-info').append(node('p', '已跳过本版不再支持来源的旧预览；职航中已有的历史导入记录不受影响。', 'help'));
      $('capture-info').append(node('p', `此次预览是 ${new Date(snapshot.createdAt).toLocaleString('zh-CN')} 的独立快照。原标签页之后跳转或关闭不会更新这些内容；新页面需重新点击扩展。`, 'help'));
      const snapshotVersion = safeVersion(snapshot.extensionVersion);
      $('capture-info').append(node('p', `采集快照版本：${snapshotVersion || '未知（旧快照）'}`, 'help'));
      if (snapshotVersion !== extensionVersion) $('capture-info').append(node('p', '这是旧版本采集快照。请返回原岗位页面，重新点击工具栏中的职航扩展，以应用最新识别规则。更新扩展不会自动修复旧预览。', 'snapshot-version-warning'));
      diagnosticReport = captureDiagnosticReport(snapshot);
      $('capture-diagnostics').hidden = !diagnosticReport;
      if (snapshot.reason) message(snapshot.reason, true);
    } else message('此次预览已过期或浏览器已重启。请在岗位页重新点击扩展，也可手动粘贴 JD。', true);
  } else message('请切换到 BOSS直聘岗位页面，再点击工具栏中的职航扩展；也可在这里手动粘贴 BOSS 岗位 JD。');
  render(); await status();
}
void initialize();
