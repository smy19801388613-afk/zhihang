const $ = id => document.getElementById(id);
const version = chrome.runtime.getManifest().version;
$('version').textContent = `扩展版本 ${version}`;
const { applicationSnapshot: snapshot } = await chrome.storage.session.get('applicationSnapshot');
const diagnostic = snapshot?.diagnostic;
$('page-state').textContent = snapshot?.reason || diagnostic?.reason || (diagnostic?.routeKind === 'apply' ? `已读取字节校园申请表，岗位 ID ${diagnostic.positionId}。已识别 ${diagnostic.fields.length} 个控件。` : '请先在字节校园申请表点击工具栏扩展。');
if (snapshot?.extensionVersion !== version) $('message').textContent = '这是旧版本读取的快照，请回到官网重新点击扩展。';
$('diagnostic').disabled = !diagnostic;
$('diagnostic').addEventListener('click', async () => {
  const text = JSON.stringify({ extensionVersion: version, snapshotVersion: snapshot.extensionVersion, capturedAt: snapshot.createdAt, ...diagnostic }, null, 2);
  try { await navigator.clipboard.writeText(text); $('message').textContent = '诊断已复制。不包含表单输入值。'; }
  catch { $('diagnostic-output').hidden = false; $('diagnostic-output').value = text; $('diagnostic-output').select(); $('message').textContent = '请复制下方只读诊断。'; }
});
$('source').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'application:focus-source' });
  if (!result?.ok) $('message').textContent = result?.error || '无法打开原页面。';
});

let run = null, plan = null, submitReview = null, liveFormVerified = false, busy = false;
const labels = { name: '姓名', email: '邮箱', phone: '电话', school: '学校', education: '学历', major: '专业', graduation: '毕业时间', city: '意向城市', availability: '到岗安排（官网人工核对）' };
const stateNames = { can_fill: '可填写空白字段', no_approved_value: '批准资料中未提供，请人工补充', ambiguous: '存在多个候选控件，请人工填写', not_found: '未识别到对应控件，请人工填写', preserve_existing: '已有内容，保留官网现值', option_not_found: '没有精确匹配的选项，请人工选择' };
const statusNames = { pending: '待填写', needs_user: '需要人工核对', filled: '已填写，待核对', submitting: '正在提交', submitted: '页面显示投递成功', unknown: '结果待核验，请勿重复提交', failed: '未完成' };
const send = async (type, data = {}) => {
  const response = await chrome.runtime.sendMessage({ type: `application:${type}`, ...data });
  if (!response?.ok) throw new Error(response?.error || '扩展操作未完成。');
  return response.data;
};
function buttons() {
  const consent = $('transfer-consent').checked;
  $('fill').disabled = busy || !consent || !liveFormVerified || !plan?.fields.some(item => item.state === 'can_fill');
  $('upload').disabled = busy || !consent || !liveFormVerified || plan?.pdf !== 'can_upload';
  for (const id of ['claim', 'pdf', 'inspect', 'forget']) $(id).disabled = busy;
  $('prepare-submit').disabled = busy || !run;
  $('submit').disabled = busy || !submitReview || !$('review-fields').checked || !$('review-attachment').checked || !$('review-agreements').checked;
}
function renderRun(result) {
  run = result.run; liveFormVerified = result.liveFormVerified === true;
  $('approved-run').hidden = !run;
  $('submission-panel').hidden = !run;
  $('authorization-state').textContent = run ? `仅授权本次 ${run.targets.length} 个字节岗位。到期时间：${new Date(run.expiresAt).toLocaleString()}。` : '尚未连接本次申请。';
  if (!run) { plan = null; submitReview = null; $('plan-panel').hidden = true; $('submit-review').hidden = true; return; }
  $('resume-label').textContent = `${run.resume.label} · 版本 ${run.resume.version}`;
  const target = run.targets.find(item => item.id === diagnostic?.positionId);
  $('target-label').textContent = target ? `当前岗位：${target.title}（${target.id}）· ${statusNames[target.status] || target.status}` : '当前页面不在本次批准的岗位清单中。请打开批准的申请表再点击扩展。';
  $('approved-fields').replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const title = document.createElement('dt'), value = document.createElement('dd');
    title.textContent = label; value.textContent = run.fields[key] || '未提供';
    $('approved-fields').append(title, value);
  }
  $('run-targets').replaceChildren();
  for (const item of run.targets) {
    const li = document.createElement('li'), link = document.createElement('a'); link.href = item.applyUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `${item.title}（${item.id}）`;
    li.append(link, document.createTextNode(` · ${statusNames[item.status] || item.status}`)); $('run-targets').append(li);
  }
  buttons();
}
function renderPlan(result) {
  renderRun(result); plan = result.plan;
  $('plan-panel').hidden = false; $('transfer-consent').checked = false;
  $('plan-note').textContent = liveFormVerified ? '请对照批准资料，核对下方计划后执行。每一步均不会点击提交。' : '真实表单结构仍待验收，当前只开放计划检查和批准 PDF 预览；不会填写或上传。';
  $('plan-fields').replaceChildren();
  for (const row of plan.fields) { const item = document.createElement('li'); item.textContent = `${labels[row.field] || row.field}：${stateNames[row.state] || row.state}`; $('plan-fields').append(item); }
  $('pdf-state').textContent = `PDF：${({ can_upload: '识别到唯一空白 PDF 控件，可上传批准版本', preserve_existing: '上传控件已选文件，保留现有文件', ambiguous: '有多个上传控件，请在官网人工选择', not_found: '未识别到唯一的简历 PDF 控件，请在官网人工上传' })[plan.pdf] || plan.pdf}`;
  buttons();
}
async function perform(action) {
  if (busy) return; busy = true; buttons(); $('message').textContent = '';
  try { await action(); } catch (error) { $('message').textContent = error instanceof Error ? error.message : '操作失败，请在官网核对。'; }
  finally { busy = false; buttons(); }
}
$('claim-form').addEventListener('submit', event => {
  event.preventDefault(); void perform(async () => { renderRun(await send('claim', { code: $('claim-code').value })); $('claim-code').value = ''; $('message').textContent = '本次申请已连接。请核对批准资料和 PDF。'; });
});
$('inspect').addEventListener('click', () => void perform(async () => { renderPlan(await send('inspect')); }));
$('forget').addEventListener('click', () => void perform(async () => { renderRun(await send('forget')); $('message').textContent = '此浏览器中的临时授权已清除。若需立即撤销服务端授权，请在职航操作。'; }));
$('pdf').addEventListener('click', () => void perform(async () => {
  const pdf = await send('pdf');
  const bytes = Uint8Array.from(atob(pdf.base64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `打开已批准 PDF · 版本 ${pdf.version}`;
  $('message').replaceChildren(link); setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}));
$('transfer-consent').addEventListener('change', buttons);
for (const operation of ['fill', 'upload']) $(operation).addEventListener('click', () => void perform(async () => {
  const result = await send(operation, { confirmed: $('transfer-consent').checked, runId: run?.id, targetId: diagnostic?.positionId, resumeHash: run?.resume.sha256 });
  renderRun(result); plan = null; $('plan-panel').hidden = true;
  $('message').textContent = operation === 'fill' ? `已确认填写后仍保留 ${result.result.filled.length} 项，${result.result.unverified?.length || 0} 项未通过回读核验，其余保留或待手动处理。请返回官网核对，再重新检查。尚未提交。` : result.result.message;
}));
$('prepare-submit').addEventListener('click', () => void perform(async () => {
  const result = await send('prepare-submit'); renderRun(result); submitReview = result.review;
  const target = run.targets.find(item => item.id === submitReview.targetId);
  $('submit-target').textContent = `真实申请目标：${target.title}（${target.id}）`;
  $('submit-resume').textContent = `批准简历：${run.resume.label} · 版本 ${run.resume.version}`;
  $('submit-file-check').textContent = submitReview.fileCheck === 'matches_approved_pdf' ? '官网当前选中文件的 SHA-256 与本次批准 PDF 一致；仍需你核对上传完成。' : '官网上传控件已清空或使用已保存附件，无法直接核验附件哈希。请你在官网打开附件，确认与本次批准 PDF 一致后再勾选。';
  for (const id of ['review-fields', 'review-attachment', 'review-agreements']) $(id).checked = false;
  $('submit-review').hidden = false;
}));
for (const id of ['review-fields', 'review-attachment', 'review-agreements']) $(id).addEventListener('change', buttons);
$('submit').addEventListener('click', () => void perform(async () => {
  const reviewId = submitReview?.id;
  const data = { reviewId, confirmed: true, fieldsReviewed: $('review-fields').checked, attachmentReviewed: $('review-attachment').checked, agreementsReviewed: $('review-agreements').checked };
  submitReview = null; $('submit-review').hidden = true;
  try {
    const result = await send('submit', data); renderRun(result);
    $('message').textContent = result.result.outcome === 'submitted' ? '官网当前岗位页面显示明确成功提示，已记录。请保留官网投递记录。' : result.result.message;
  } catch (error) {
    try { renderRun(await send('run')); } catch { /* original error is more useful */ }
    throw error;
  }
}));
void perform(async () => { renderRun(await send('run')); });
