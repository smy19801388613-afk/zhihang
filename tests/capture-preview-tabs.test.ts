import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { captureBackgroundVmSource } from './helpers/capture-background-vm.ts';

const script = captureBackgroundVmSource();
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const sourceUrl = (id: number) => `https://www.zhipin.com/job_detail/synthetic${id}.html`;
function harness() {
  const stored: Record<string, any> = {};
  const tabs = new Map<number, any>([[1, { id: 1, url: sourceUrl(1), windowId: 1 }], [2, { id: 2, url: sourceUrl(2), windowId: 1 }]]);
  const created: any[] = []; const updated: any[] = []; const focused: number[] = [];
  let nextId = 100; let closeDuringUpdate = false;
  let firstDelay: Promise<void> | undefined;
  const area = { setAccessLevel: async () => {}, get: async () => structuredClone(stored), set: async (value: any) => Object.assign(stored, structuredClone(value)) };
  const chrome = {
    storage: { local: area, session: area },
    action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getManifest: () => ({version: '0.1.2'}), getURL: (path: string) => `${origin}/${path}`, onMessage: { addListener: () => {} },
      getContexts: async (filter: any) => [...tabs.values()].map(tab => ({ contextId: `context-${tab.id}`, tabId: tab.id, windowId: tab.windowId, frameId: 0, documentUrl: tab.url })).filter(view => !filter.contextIds || filter.contextIds.includes(view.contextId)),
    },
    windows: { update: async (windowId: number) => { focused.push(windowId); } },
    tabs: {
      get: async (id: number) => { const tab = tabs.get(id); if (!tab) throw new Error('Tab closed'); return { ...tab }; },
      query: async () => [...tabs.values()].filter(tab => tab.url.startsWith(`${origin}/preview.html`)).map(tab => ({ ...tab })),
      update: async (id: number, values: any) => {
        if (closeDuringUpdate) { closeDuringUpdate = false; tabs.delete(id); throw new Error('Tab closed while updating'); }
        const tab = tabs.get(id); if (!tab) throw new Error('Tab closed'); Object.assign(tab, values); updated.push({ id, ...values }); return { ...tab };
      },
      create: async (values: any) => { const tab = { id: nextId++, windowId: 2, ...values }; tabs.set(tab.id, tab); created.push({ ...tab }); return { ...tab }; },
    },
    scripting: { executeScript: async (request: any) => {
      const id = request.target.tabId;
      if (request.files) {
        if (id === 1 && firstDelay) await firstDelay;
        return [{ frameId: 0, documentId: `document-${id}`, result: { url: sourceUrl(id), jobs: [{ platform: 'boss', sourceUrl: sourceUrl(id), fields: { title: `岗位${id}` } }] } }];
      }
      return [{ result: sourceUrl(id) }];
    } },
  };
  const context = createContext({ chrome, crypto: webcrypto, URL, AbortSignal, fetch: () => { throw new Error('No network should run during capture'); } });
  runInContext(script, context);
  return { stored, tabs, created, updated, focused,
    capture: (id = 1) => runInContext(`capture({id:${id},url:${JSON.stringify(sourceUrl(id))}})`, context) as Promise<void>,
    closeNextUpdate: () => { closeDuringUpdate = true; }, delayFirst: (promise: Promise<void>) => { firstDelay = promise; },
  };
}

test('toolbar capture reuses and focuses a single preview with a new isolated snapshot', async () => {
  const h = harness(); await h.capture();
  assert.equal(h.created.length, 1); const previewId = h.created[0].id;
  const first = new URL(h.created[0].url).searchParams.get('snapshot')!;
  assert.equal(h.stored.snapshots[first].extensionVersion, '0.1.2');
  h.stored.drafts = { [first]: [{ value: { title: 'old edited title' } }] };
  await h.capture(2);
  assert.equal(h.created.length, 1); assert.equal(h.updated.length, 1);
  assert.equal(h.updated[0].id, previewId); assert.equal(h.updated[0].active, true);
  assert.deepEqual(h.focused, [2]);
  const second = new URL(h.updated[0].url).searchParams.get('snapshot')!;
  assert.notEqual(second, first); assert.equal(h.stored.snapshots[second].jobs[0].fields.title, '岗位2');
  assert.equal(h.stored.snapshots[second].extensionVersion, '0.1.2');
  assert.equal(h.stored.drafts[second], undefined); assert.equal(h.stored.drafts[first][0].value.title, 'old edited title');
});

test('existing options preview is reused when no remembered tab id is present', async () => {
  const h = harness(); h.tabs.set(77, { id: 77, url: `${origin}/preview.html`, windowId: 3 });
  await h.capture(); assert.equal(h.created.length, 0); assert.equal(h.updated[0].id, 77); assert.deepEqual(h.focused, [3]);
});

test('closed or navigated preview never causes an unrelated tab to be overwritten', async () => {
  for (const url of [null, 'https://example.com/', 'chrome-extension://otherextension/preview.html', `${origin}/preview.html-extra`]) {
    const h = harness(); h.stored.previewTabId = 77;
    if (url) h.tabs.set(77, { id: 77, url, windowId: 3 });
    await h.capture(); assert.equal(h.created.length, 1); assert.equal(h.updated.length, 0);
    if (url) assert.equal(h.tabs.get(77).url, url);
  }
});

test('closing the preview between lookup and update creates exactly one replacement', async () => {
  const h = harness(); await h.capture(); h.closeNextUpdate(); await h.capture(2);
  assert.equal(h.created.length, 2); assert.equal(h.tabs.has(h.created[0].id), false);
  assert.equal(h.stored.previewTabId, h.created[1].id);
});

test('rapid toolbar clicks show only the newest capture when older extraction finishes late', async () => {
  const h = harness(); let release!: () => void;
  h.delayFirst(new Promise<void>(done => { release = done; }));
  const old = h.capture(1); await h.capture(2); release(); await old;
  assert.equal(h.created.length, 1); assert.equal(h.updated.length, 0);
  const latest = new URL(h.created[0].url).searchParams.get('snapshot')!;
  assert.equal(h.stored.snapshots[latest].jobs[0].fields.title, '岗位2');
  assert.equal(h.stored.snapshots[latest].extensionVersion, '0.1.2');
});
