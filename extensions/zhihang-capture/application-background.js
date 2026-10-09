const APPLY_ORIGIN = 'https://jobs.bytedance.com';
const BASE = 'http://127.0.0.1:4317/extension/apply/v1';
const ENDPOINTS = new Set(['/claim', '/run', '/resume.pdf', '/checkpoint']);
// The user's logged-in 0.2.1 diagnostic confirmed label/control branches for
// name, email, phone and resume attachment. This enables bounded filling only;
// it does not claim end-to-end website acceptance or a verified submission.
// Never take this capability from webpage text or message-provided instructions.
const LIVE_FORM_VERIFIED = true;
let actionBusy = false;

function isApplicationUrl(value) {
  try {
    const url = new URL(value);
    const own = new URL(chrome.runtime.getURL('application.html'));
    return url.protocol === own.protocol && url.hostname === own.hostname && url.pathname === '/application.html';
  } catch { return false; }
}

export function isByteDancePage(value) {
  try { const url = new URL(value); return url.origin === APPLY_ORIGIN && !url.username && !url.password && url.pathname.startsWith('/campus/'); } catch { return false; }
}

let sequence = 0;
export async function openApplication(tab) {
  const current = ++sequence;
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  let snapshot = { tabId: tab.id, url: tab.url, createdAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest().version, diagnostic: null, reason: '' };
  try {
    if (!Number.isInteger(tab.id) || !isByteDancePage(tab.url)) throw new Error('请在字节校园申请表点击扩展。');
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', files: ['adapters/bytedance-application.js'] });
    const result = results.find(item => item.frameId === 0);
    if (!result?.documentId || !result.result) throw new Error('未取得申请表文档，请重新点击扩展。');
    const checked = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [result.documentId] }, func: () => location.href });
    if (checked[0]?.result !== tab.url || (await chrome.tabs.get(tab.id)).url !== tab.url) throw new Error('页面在读取期间发生变化，请回到申请表重新点击扩展。');
    snapshot = { ...snapshot, documentId: result.documentId, diagnostic: result.result };
  } catch (error) { snapshot.reason = error instanceof Error ? error.message : '读取失败，请重新点击扩展。'; }
  if (current !== sequence) return;
  await chrome.storage.session.set({ applicationSnapshot: snapshot });
  const url = chrome.runtime.getURL('application.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['TAB'] }).catch(() => []);
  const view = existing.find(item => item.frameId === 0 && item.tabId >= 0 && isApplicationUrl(item.documentUrl));
  if (view) {
    try { await chrome.tabs.update(view.tabId, { url: `${url}?snapshot=${Date.now()}`, active: true }); return; } catch { /* closed preview */ }
  }
  await chrome.tabs.create({ url, active: true });
}

async function api(path, body = {}, authenticated = true) {
  if (!ENDPOINTS.has(path)) throw new Error('不允许访问此网申接口。');
  const { applicationAuthorization: authorization } = await chrome.storage.session.get('applicationAuthorization');
  if (authenticated && (!authorization?.token || Date.parse(authorization.expiresAt) <= Date.now())) throw new Error('请先输入职航中本次申请的短时授权码。');
  let response;
  try {
    response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${authorization.token}` } : {}) }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch { throw new Error('无法连接本机职航。请确认 http://127.0.0.1:4317 正在运行。'); }
  if (!response.ok) {
    if (response.status === 401) await chrome.storage.session.remove('applicationAuthorization');
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.error === 'string' ? data.error.slice(0, 600) : `本机职航拒绝本次请求（${response.status}）。`);
  }
  if (path !== '/resume.pdf') return response.json();
  if (!response.headers.get('content-type')?.startsWith('application/pdf')) throw new Error('服务端未返回 PDF，未上传。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 5 || bytes.length > 8 * 1024 * 1024 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('审核 PDF 格式或大小异常，未上传。');
  return bytes;
}
function validateRun(run) {
  if (!run || typeof run.id !== 'string' || !Number.isInteger(run.revision) || !run.resume || !/^[a-f0-9]{64}$/u.test(run.resume.sha256 || '') || !Array.isArray(run.targets) || run.targets.length < 1 || run.targets.length > 20 || !Number.isFinite(Date.parse(run.expiresAt)) || Date.parse(run.expiresAt) <= Date.now() || run.revokedAt) throw new Error('本次申请授权无效或已过期。');
  for (const target of run.targets) {
    if (!/^\d{10,24}$/u.test(target.id) || target.applyUrl !== `${APPLY_ORIGIN}/campus/resume/${target.id}/apply` || target.url !== `${APPLY_ORIGIN}/campus/position/${target.id}/detail`) throw new Error('授权岗位地址无效。');
  }
  if (!run.fields || ['name', 'email', 'phone', 'school', 'education', 'major', 'graduation', 'city', 'availability'].some(key => typeof run.fields[key] !== 'string' || run.fields[key].length > 500)) throw new Error('授权字段无效，请在职航核对资料。');
  return run;
}
async function currentTarget(run, requireWritable = false) {
  const { applicationSnapshot: snapshot } = await chrome.storage.session.get('applicationSnapshot');
  if (!snapshot?.documentId || snapshot.diagnostic?.routeKind !== 'apply') throw new Error('请在已登录的字节岗位申请表重新点击扩展。');
  const target = run.targets.find(item => item.id === snapshot.diagnostic.positionId);
  if (!target) throw new Error('当前岗位不在本次批准的申请清单内，不会读取或填写此岗位。');
  const tab = await chrome.tabs.get(snapshot.tabId).catch(() => null);
  if (!tab || tab.url !== snapshot.url || snapshot.url.split(/[?#]/u)[0].replace(/\/$/u, '') !== target.applyUrl) throw new Error('原申请页已跳转或关闭。请重新点击该岗位页面的扩展。');
  const check = await chrome.scripting.executeScript({ target: { tabId: snapshot.tabId, documentIds: [snapshot.documentId] }, world: 'ISOLATED', func: () => location.href });
  if (check[0]?.result !== snapshot.url) throw new Error('原申请文档已变化，请重新检查。');
  if (requireWritable && ['submitting', 'submitted', 'unknown'].includes(target.status)) throw new Error('此岗位已提交或结果待核验，不能再次填写或上传。请在官网核验。');
  return { snapshot, target, expected: { positionId: target.id, url: snapshot.url, deadline: Date.parse(run.expiresAt) } };
}
async function callAdapter(bound, method, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId: bound.snapshot.tabId, documentIds: [bound.snapshot.documentId] }, world: 'ISOLATED', func: async (operation, values) => {
    const adapter = globalThis.__zhihangByteDanceApplication;
    if (!adapter || !['plan', 'fill', 'upload', 'submitPreflight', 'submit'].includes(operation) || typeof adapter[operation] !== 'function') throw new Error('申请适配器未就绪，请重新点击扩展。');
    return adapter[operation](...values);
  }, args: [method, [bound.expected, ...args]] });
  if (!results[0]?.result) throw new Error('未取得官网操作结果，请在官网人工核对。');
  return results[0].result;
}
async function pdfPayload(run) {
  const bytes = await api('/resume.pdf');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== run.resume.sha256) throw new Error('审核 PDF 与授权版本不一致，未上传。');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return { base64: btoa(binary), sha256: hash };
}
async function checkpoint(run, bound, status, message, extra = {}) {
  return validateRun(await api('/checkpoint', { expectedRevision: run.revision, targetId: bound.target.id, status, pageUrl: bound.expected.url, message, ...extra }));
}

export function registerApplicationMessages() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isApplicationUrl(sender.url) || sender.tab?.url && !isApplicationUrl(sender.tab.url)) return false;
    if (!String(message?.type || '').startsWith('application:')) return false;
    const handle = async () => {
      await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      if (message.type === 'application:focus-source') {
        const { applicationSnapshot } = await chrome.storage.session.get('applicationSnapshot');
        if (!applicationSnapshot?.tabId) throw new Error('请先从申请表点击扩展。');
        const tab = await chrome.tabs.get(applicationSnapshot.tabId);
        if (!isByteDancePage(tab.url)) throw new Error('原标签页已离开字节官网。请回到申请表重新点击扩展。');
        await chrome.tabs.update(tab.id, { active: true });
        return {};
      }
      if (message.type === 'application:claim') {
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        if (!/^[A-F0-9]{16}$/u.test(code)) throw new Error('请输入职航中生成的 16 位一次性网申授权码。');
        const result = await api('/claim', { code }, false);
        const run = validateRun(result.run);
        if (!/^[A-Za-z0-9_-]{43}$/u.test(result.token || '')) throw new Error('服务端返回了无效的申请凭证。');
        await chrome.storage.session.set({ applicationAuthorization: { token: result.token, expiresAt: result.expiresAt, runId: run.id } });
        return { run, liveFormVerified: LIVE_FORM_VERIFIED };
      }
      if (message.type === 'application:run') {
        const { applicationAuthorization } = await chrome.storage.session.get('applicationAuthorization');
        if (!applicationAuthorization) return { run: null, liveFormVerified: LIVE_FORM_VERIFIED };
        return { run: validateRun(await api('/run')), liveFormVerified: LIVE_FORM_VERIFIED };
      }
      if (message.type === 'application:forget') {
        await chrome.storage.session.remove(['applicationAuthorization', 'applicationPlan', 'applicationSubmitReview']);
        return { run: null, liveFormVerified: LIVE_FORM_VERIFIED };
      }
      if (message.type === 'application:pdf') {
        const run = validateRun(await api('/run'));
        return { ...(await pdfPayload(run)), label: run.resume.label, version: run.resume.version };
      }
      if (message.type === 'application:inspect') {
        const run = validateRun(await api('/run')), bound = await currentTarget(run);
        const plan = await callAdapter(bound, 'plan', [run.fields]);
        await chrome.storage.session.set({ applicationPlan: { runId: run.id, resumeHash: run.resume.sha256, targetId: bound.target.id, tabId: bound.snapshot.tabId, documentId: bound.snapshot.documentId, fingerprint: plan.fingerprint } });
        return { run, plan, liveFormVerified: LIVE_FORM_VERIFIED };
      }
      if (['application:fill', 'application:upload'].includes(message.type)) {
        if (!LIVE_FORM_VERIFIED) throw new Error('真实表单结构仍待验收，当前只开放检查与批准 PDF 预览。');
        if (message.confirmed !== true) throw new Error('请先确认将这些批准资料发送给字节校园官网。');
        if (actionBusy) throw new Error('当前操作尚未结束，请稍后在官网核对结果。');
        actionBusy = true;
        try {
          const run = validateRun(await api('/run')), bound = await currentTarget(run, true);
          if (message.runId !== run.id || message.targetId !== bound.target.id || message.resumeHash !== run.resume.sha256) throw new Error('预览已过期或与当前授权不符，请重新检查。');
          const { applicationPlan: plan } = await chrome.storage.session.get('applicationPlan');
          if (!plan || plan.runId !== run.id || plan.resumeHash !== run.resume.sha256 || plan.targetId !== bound.target.id || plan.tabId !== bound.snapshot.tabId || plan.documentId !== bound.snapshot.documentId) throw new Error('请先重新检查当前表单。');
          const result = message.type === 'application:fill'
            ? await callAdapter(bound, 'fill', [run.fields, plan.fingerprint])
            : await callAdapter(bound, 'upload', [await pdfPayload(run), plan.fingerprint]);
          const next = await checkpoint(run, bound, 'needs_user', message.type === 'application:fill' ? '已按明确字段标签尝试填写，请在官网核对，尚未提交。' : '批准 PDF 已交给上传控件，上传结果仍需在官网核对，尚未提交。');
          await chrome.storage.session.remove('applicationPlan');
          return { run: next, result, liveFormVerified: LIVE_FORM_VERIFIED };
        } finally { actionBusy = false; }
      }
      if (message.type === 'application:prepare-submit') {
        const run = validateRun(await api('/run')), bound = await currentTarget(run, true);
        const preflight = await callAdapter(bound, 'submitPreflight', [run.resume.sha256]);
        const review = { id: crypto.randomUUID(), runId: run.id, resumeHash: run.resume.sha256, targetId: bound.target.id, tabId: bound.snapshot.tabId, documentId: bound.snapshot.documentId, fingerprint: preflight.fingerprint, expiresAt: Date.now() + 2 * 60_000, fileCheck: preflight.fileCheck };
        await chrome.storage.session.set({ applicationSubmitReview: review });
        return { run, review: { id: review.id, targetId: review.targetId, expiresAt: review.expiresAt, fileCheck: review.fileCheck }, liveFormVerified: LIVE_FORM_VERIFIED };
      }
      if (message.type === 'application:submit') {
        if (message.confirmed !== true || message.fieldsReviewed !== true || message.attachmentReviewed !== true || message.agreementsReviewed !== true) throw new Error('请在最终核对区确认该岗位、批准 PDF、官网必填资料及本人处理的协议。');
        if (actionBusy) throw new Error('当前官网操作尚未结束，请勿重复提交。');
        actionBusy = true;
        let submittedRun, submittedBound;
        try {
          let run = validateRun(await api('/run')); const bound = await currentTarget(run, true);
          const { applicationSubmitReview: review } = await chrome.storage.session.get('applicationSubmitReview');
          if (!review || review.id !== message.reviewId || review.expiresAt <= Date.now() || review.runId !== run.id || review.resumeHash !== run.resume.sha256 || review.targetId !== bound.target.id || review.tabId !== bound.snapshot.tabId || review.documentId !== bound.snapshot.documentId) throw new Error('最终核对已过期或页面变化，请重新检查。');
          bound.expected.deadline = Math.min(bound.expected.deadline, review.expiresAt);
          const latest = await callAdapter(bound, 'submitPreflight', [run.resume.sha256]);
          if (latest.fingerprint !== review.fingerprint || latest.fileCheck !== review.fileCheck) throw new Error('官网表单或附件状态在核对后变化，请重新核对。');
          run = await checkpoint(run, bound, 'filled', '用户已核对本岗位、批准 PDF、官网必填资料与协议，等待明确提交。');
          // Persist the non-retryable state before the website receives a click.
          run = await checkpoint(run, bound, 'submitting', '用户明确确认，准备向官网点击一次提交。', { confirmed: true });
          submittedRun = run; submittedBound = bound;
          await chrome.storage.session.remove(['applicationSubmitReview', 'applicationPlan']);
          const result = await callAdapter(bound, 'submit', [run.resume.sha256, review.fingerprint]);
          const status = result.outcome === 'submitted' && ['投递成功', '申请成功', '已成功投递', '已投递', '申请已提交'].includes(result.evidence) && result.pageUrl === bound.expected.url ? 'submitted' : 'unknown';
          const next = await checkpoint(run, bound, status, status === 'submitted' ? '官网当前岗位页面显示明确成功提示。' : '已进行一次提交尝试，结果需在官网核验，禁止自动重试。', status === 'submitted' ? { evidence: result.evidence } : {});
          return { run: next, result, liveFormVerified: LIVE_FORM_VERIFIED };
        } catch (error) {
          if (submittedRun && submittedBound) {
            try {
              const latest = validateRun(await api('/run'));
              if (latest.targets.find(target => target.id === submittedBound.target.id)?.status !== 'submitted') await checkpoint(latest, submittedBound, 'unknown', '提交阶段发生页面变化或读取异常，请在官网核验，禁止自动重试。');
            } catch { /* persisted submitting is already non-retryable */ }
            throw new Error('提交阶段结果未能核验。请在官网检查本岗位投递记录，勿再次提交；本地已保留待核验状态。');
          }
          throw error;
        } finally { actionBusy = false; }
      }
      throw new Error('不支持的网申操作。');
    };
    handle().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败。' }));
    return true;
  });
}
