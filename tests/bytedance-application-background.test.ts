import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const script = readFileSync(resolve('extensions/zhihang-capture/application-background.js'), 'utf8').replace(/^export /gmu, '');
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const positionId = '7246662982998313277';
const applyUrl = `https://jobs.bytedance.com/campus/resume/${positionId}/apply`;
const bytes = Buffer.from('%PDF-synthetic-test-only');
const runFixture = () => ({ id: 'synthetic-run', revision: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(), resume: { id: 'r1', version: 2, label: '合成简历', sha256: createHash('sha256').update(bytes).digest('hex') }, fields: { name: '合成', email: 'student@example.com', phone: '13800000000', school: '', education: '', major: '', graduation: '', city: '', availability: '' }, targets: [{ id: positionId, url: `https://jobs.bytedance.com/campus/position/${positionId}/detail`, applyUrl, company: '字节跳动', title: '合成岗位', status: 'pending' }] });
function harness() {
  let listener: any, currentUrl = applyUrl, fetchedRun: any = runFixture(), badPdf = false, failingCheckpoint = '', submitResult: any = { outcome: 'unknown' };
  const calls: any[] = [], injections: any[] = [];
  const stored: any = { applicationSnapshot: { tabId: 7, documentId: 'doc1', url: applyUrl, diagnostic: { routeKind: 'apply', positionId } } };
  const storage = { setAccessLevel: async () => {}, get: async () => structuredClone(stored), set: async (value: any) => Object.assign(stored, structuredClone(value)), remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; } };
  const context = createContext({ URL, AbortSignal, crypto: webcrypto, TextEncoder, Uint8Array, btoa, fetch: async (url: string, options: any) => {
    calls.push({ path: new URL(url).pathname, options });
    if (url.endsWith('/claim')) return Response.json({ token: 'a'.repeat(43), expiresAt: fetchedRun.expiresAt, run: fetchedRun });
    if (url.endsWith('/resume.pdf')) return new Response(badPdf ? Buffer.from('%PDF-wrong') : bytes, { headers: { 'Content-Type': 'application/pdf' } });
    if (url.endsWith('/checkpoint')) { const data = JSON.parse(options.body); if (data.status === failingCheckpoint) return Response.json({ error: '合成保存失败' }, { status: 500 }); fetchedRun = { ...fetchedRun, revision: fetchedRun.revision + 1 }; fetchedRun.targets[0].status = data.status; }
    return Response.json(fetchedRun);
  }, chrome: { storage: { session: storage, local: { get: () => { throw new Error('Import credentials must never be read'); } } }, runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: (file: string) => `${origin}/${file}`, onMessage: { addListener: (fn: any) => { listener = fn; } } }, tabs: { get: async () => ({ id: 7, url: currentUrl }), update: async () => ({}) }, scripting: { executeScript: async (input: any) => {
    injections.push(input);
    if (!input.args) return [{ result: currentUrl }];
    if (input.args[0] === 'submitPreflight') return [{ result: { fingerprint: 'synthetic-review', fileCheck: 'requires_user_confirmation', buttonLabel: '提交简历' } }];
    if (input.args[0] === 'submit') { if (fetchedRun.targets[0].status !== 'submitting') throw new Error('Clicked before checkpoint'); return [{ result: submitResult }]; }
    return [{ result: input.args[0] === 'plan' ? { fields: [{ field: 'name', state: 'can_fill' }], pdf: 'can_upload', fingerprint: 'synthetic-form' } : input.args[0] === 'fill' ? { filled: ['name'], skipped: [] } : { fileSelected: true, uploadVerified: false } }];
  } } } });
  runInContext(`${script}\nregisterApplicationMessages();`, context);
  const send = (type: string, data = {}, sender = { id: 'abcdefghijklmnopabcdefghijklmnop', url: `${origin}/application.html`, tab: { url: `${origin}/application.html` } }): Promise<any> => new Promise(resolve => {
    const accepted = listener({ type: `application:${type}`, ...data }, sender, resolve);
    if (!accepted) resolve({ rejected: true });
  });
  return { send, calls, stored, injections, run: () => fetchedRun, navigate: (value: string) => { currentUrl = value; }, corruptPdf: () => { badPdf = true; }, changeStatus: (status: string) => { fetchedRun.targets[0].status = status; }, failCheckpoint: (value: string) => { failingCheckpoint = value; }, result: (value: any) => { submitResult = value; } };
}
test('application APIs use one-run credential, fixed POST paths and trusted extension-only messages', async () => {
  const h = harness();
  assert.equal((await h.send('claim', { code: 'ABCDEF1234567890' }, { id: 'abcdefghijklmnopabcdefghijklmnop', url: `${origin}/preview.html`, tab: { url: `${origin}/preview.html` } })).rejected, true);
  assert.equal((await h.send('claim', { code: 'ABCDEF1234567890' })).ok, true);
  assert.equal(h.stored.applicationAuthorization.token, 'a'.repeat(43));
  assert.equal((await h.send('run')).ok, true);
  assert.ok(h.calls.every(call => call.options.method === 'POST' && call.path.startsWith('/extension/apply/v1/')));
  assert.equal(h.calls[1].options.headers.Authorization, `Bearer ${'a'.repeat(43)}`);
  assert.equal((await h.send('submit', { confirmed: true })).ok, false);
  assert.equal(h.calls.some(call => call.path.endsWith('/checkpoint')), false);
});
test('approved PDF hash is checked and credentials stay out of returned data', async () => {
  const h = harness(); await h.send('claim', { code: 'ABCDEF1234567890' });
  const result = await h.send('pdf'); assert.equal(result.ok, true); assert.equal(Buffer.from(result.data.base64, 'base64').toString(), bytes.toString());
  assert.doesNotMatch(JSON.stringify(result.data), new RegExp('a'.repeat(43)));
  h.corruptPdf(); const bad = await h.send('pdf'); assert.equal(bad.ok, false); assert.match(bad.error, /不一致/u);
});
test('fill requires current run, target, PDF, document, preview and explicit data transmission confirmation', async () => {
  const h = harness(); await h.send('claim', { code: 'ABCDEF1234567890' }); await h.send('inspect');
  const confirmation = { confirmed: true, runId: h.run().id, targetId: positionId, resumeHash: h.run().resume.sha256 };
  assert.equal((await h.send('fill', { ...confirmation, confirmed: false })).ok, false);
  assert.equal((await h.send('fill', { ...confirmation, targetId: '7246662982998313278' })).ok, false);
  assert.equal(h.injections.filter(item => item.args?.[0] === 'fill').length, 0);
  const result = await h.send('fill', confirmation); assert.equal(result.ok, true);
  assert.equal(h.run().targets[0].status, 'needs_user');
  assert.equal(h.injections.find(item => item.args?.[0] === 'fill').target.documentIds[0], 'doc1');
  assert.equal(h.calls.find(call => call.path.endsWith('/checkpoint')).options.body.includes('submitted'), false);
});
test('navigation and uncertain submission states prevent further website writes', async () => {
  const h = harness(); await h.send('claim', { code: 'ABCDEF1234567890' }); await h.send('inspect');
  const confirmation = { confirmed: true, runId: h.run().id, targetId: positionId, resumeHash: h.run().resume.sha256 };
  h.navigate('https://jobs.bytedance.com/campus/resume/7246662982998313278/apply');
  assert.equal((await h.send('upload', confirmation)).ok, false);
  h.navigate(applyUrl); h.changeStatus('unknown');
  assert.equal((await h.send('fill', confirmation)).ok, false);
  assert.equal(h.injections.some(item => ['fill', 'upload'].includes(item.args?.[0])), false);
});
test('explicit final confirmation persists filled and submitting before one click, then records exact evidence', async () => {
  const h = harness(); await h.send('claim', { code: 'ABCDEF1234567890' });
  const prepared = await h.send('prepare-submit');
  h.result({ outcome: 'submitted', evidence: '投递成功', pageUrl: applyUrl });
  const result = await h.send('submit', { reviewId: prepared.data.review.id, confirmed: true, fieldsReviewed: true, attachmentReviewed: true, agreementsReviewed: true });
  assert.equal(result.ok, true); assert.equal(h.run().targets[0].status, 'submitted');
  assert.deepEqual(h.calls.filter(call => call.path.endsWith('/checkpoint')).map(call => JSON.parse(call.options.body).status), ['filled', 'submitting', 'submitted']);
  assert.equal(h.injections.filter(item => item.args?.[0] === 'submit').length, 1);
  assert.equal((await h.send('prepare-submit')).ok, false);
});
test('failed pre-click checkpoint sends no click; unknown result is saved and cannot be retried', async () => {
  for (const scenario of ['save_failure', 'unknown']) {
    const h = harness(); await h.send('claim', { code: 'ABCDEF1234567890' }); const prepared = await h.send('prepare-submit');
    if (scenario === 'save_failure') h.failCheckpoint('submitting');
    const result = await h.send('submit', { reviewId: prepared.data.review.id, confirmed: true, fieldsReviewed: true, attachmentReviewed: true, agreementsReviewed: true });
    assert.equal(h.injections.filter(item => item.args?.[0] === 'submit').length, scenario === 'save_failure' ? 0 : 1);
    if (scenario === 'save_failure') assert.equal(result.ok, false);
    else { assert.equal(h.run().targets[0].status, 'unknown'); assert.equal((await h.send('prepare-submit')).ok, false); }
  }
});
