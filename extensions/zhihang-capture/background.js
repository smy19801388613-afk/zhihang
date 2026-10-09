import { isByteDancePage, openApplication, registerApplicationMessages } from './application-background.js';

const BASE = 'http://127.0.0.1:4317';
const PATHS = new Set(['/extension/v1/pair', '/extension/v1/status', '/extension/v1/connection', '/extension/v1/import']);
const trustedStorage = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
let latestCapture = 0;
let previewQueue = Promise.resolve();

function isPreviewUrl(value) {
  try {
    const url = new URL(value);
    const own = new URL(chrome.runtime.getURL('preview.html'));
    return url.protocol === own.protocol && url.hostname === own.hostname && url.pathname === '/preview.html';
  } catch { return false; }
}

async function openCapturePreview(snapshotId) {
  const url = chrome.runtime.getURL(`preview.html?snapshot=${encodeURIComponent(snapshotId)}`);
  const { previewTabId } = await chrome.storage.session.get('previewTabId');
  const candidates = [];
  // tabs.query/get hide URL without broad tabs privileges, including for own
  // extension pages in some Chromium builds. getContexts lists only our views.
  // It also finds a preview opened before a worker restart or through options.
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    for (const view of existing) if (view.tabId >= 0 && view.frameId === 0 && isPreviewUrl(view.documentUrl)) candidates.push(view);
    candidates.sort((a, b) => Number(b.tabId === previewTabId) - Number(a.tabId === previewTabId));
  } catch { /* No reusable view; creating our own page is safe. */ }
  for (const view of candidates) {
    try {
      const current = await chrome.runtime.getContexts({ contextIds: [view.contextId] });
      if (!current.some(item => item.tabId === view.tabId && item.frameId === 0 && isPreviewUrl(item.documentUrl))) continue;
      const updated = await chrome.tabs.update(view.tabId, { url, active: true });
      await chrome.storage.session.set({ previewTabId: updated.id });
      if (Number.isInteger(updated.windowId)) await chrome.windows.update(updated.windowId, { focused: true }).catch(() => {});
      return;
    } catch { /* The preview can close between lookup and update; try another. */ }
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (Number.isInteger(created?.id)) await chrome.storage.session.set({ previewTabId: created.id });
}

async function request(path, method, body, authenticated = true) {
  await trustedStorage;
  if (!PATHS.has(path)) throw new Error('不允许访问此接口。');
  const { connection } = await chrome.storage.local.get('connection');
  if (authenticated && !connection?.token) throw new Error('请先与本机职航配对。');
  let response;
  try {
    response = await fetch(BASE + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${connection.token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error('无法连接本机职航。请启动职航，确认 http://127.0.0.1:4317 可打开，再重试。'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && authenticated) await chrome.storage.local.remove('connection');
    const detail = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : '';
    throw new Error(detail.slice(0, 600) || `本机服务拒绝请求（${response.status}），请检查配对状态后重试。`);
  }
  return data;
}

async function capture(tab) {
  const sequence = ++latestCapture;
  await trustedStorage;
  const id = crypto.randomUUID();
  let snapshot = { id, tabId: tab.id, url: tab.url || '', jobs: [], reason: '', createdAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest().version };
  try {
    if (!tab.id || !/^https:\/\/(?:www\.)?zhipin\.com\//.test(tab.url || '')) {
      throw new Error('当前岗位采集仅支持 BOSS直聘。请先打开 BOSS 岗位页面，再点击扩展；也可以手动粘贴 BOSS 岗位资料。');
    }
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED',
      files: ['adapters/common.js', 'adapters/boss.js', 'adapters/capture.js'],
    });
    const extraction = injected.find(item => item.frameId === 0);
    if (!extraction?.documentId || !extraction.result) throw new Error('未取得当前岗位文档，请重新点击扩展。');
    const check = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [extraction.documentId] }, func: () => location.href });
    const freshTab = await chrome.tabs.get(tab.id);
    if (freshTab.url !== tab.url || extraction.result.url !== tab.url || check[0]?.result !== tab.url) throw new Error('读取期间标签页发生跳转或来源变化，已丢弃此次结果，请在页面稳定后重试。');
    snapshot = { ...snapshot, ...extraction.result, documentId: extraction.documentId };
  } catch (error) {
    snapshot.reason = error instanceof Error ? error.message : '读取失败，请重新点击扩展或手动粘贴 JD。';
  }
  // Commit and show one snapshot at a time. Rapid clicks cannot create duplicate
  // previews, and an older slow extraction cannot replace the most recent click.
  previewQueue = previewQueue.catch(() => {}).then(async () => {
    if (sequence !== latestCapture) return;
    const { snapshots = {}, drafts = {} } = await chrome.storage.session.get(['snapshots', 'drafts']);
    // Two bounded previews fit session storage even with 20 long Chinese JDs and edited copies.
    const retained = Object.entries(snapshots).sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt)).slice(0, 1);
    const retainedDrafts = Object.fromEntries(retained.filter(([key]) => drafts[key]).map(([key]) => [key, drafts[key]]));
    await chrome.storage.session.set({ snapshots: { ...Object.fromEntries(retained), [id]: snapshot }, drafts: retainedDrafts });
    if (sequence !== latestCapture) return;
    await openCapturePreview(id);
  });
  await previewQueue;
}

registerApplicationMessages();
chrome.action.onClicked.addListener(tab => { void (isByteDancePage(tab.url) ? openApplication(tab) : capture(tab)); });

// No external messaging or web-page listeners: only this extension's preview may request these operations.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isPreviewUrl(sender.url) || sender.tab && sender.tab.url && !isPreviewUrl(sender.tab.url)) return false;
  const handle = async () => {
    if (message?.type === 'pair') {
      const result = await request('/extension/v1/pair', 'POST', { code: String(message.code || '').trim(), clientName: '职航浏览器扩展' }, false);
      await chrome.storage.local.set({ connection: { token: result.token, connectionId: result.connectionId, expiresAt: result.expiresAt } });
      return { connected: true, expiresAt: result.expiresAt };
    }
    if (message?.type === 'status') {
      await trustedStorage;
      const { connection } = await chrome.storage.local.get('connection');
      if (!connection?.token) return { connected: false };
      // Chromium omits Origin on extension GET requests. POST retains the native
      // extension Origin, allowing the server to keep strict source validation.
      return request('/extension/v1/status', 'POST', {});
    }
    if (message?.type === 'disconnect') {
      // Do not silently forget a credential before revocation has succeeded.
      await request('/extension/v1/connection', 'DELETE');
      await chrome.storage.local.remove('connection');
      return { connected: false };
    }
    if (message?.type === 'import') {
      if (!Array.isArray(message.body?.jobs) || message.body.jobs.some(job => job?.platform !== 'boss')) throw new Error('本版扩展只接受 BOSS直聘岗位，请重新采集；职航中已有的历史导入数据不受影响。');
      return request('/extension/v1/import', 'POST', message.body);
    }
    throw new Error('不支持的扩展操作。');
  };
  handle().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败。' }));
  return true;
});
