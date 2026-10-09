import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import type { CaptureBatch, CaptureJob } from '../shared/browser-capture.ts';
import type { Action } from '../shared/types.ts';
import { mergeCaptureCandidates, normalizeCaptureUrl } from '../server/browser-capture.ts';
import { captureBatchSchema, actionSchema } from '../server/validation.ts';
import { Store } from '../server/store.ts';
import { Workflow, exampleProfile } from '../server/workflow.ts';
import { createModelEngine } from '../server/model.ts';

const jd = '岗位职责：协助整理用户反馈，使用 Excel 整理资料，参与校园活动运营。任职要求：本科在校生，有课程项目经验优先。';
function capture(overrides: Partial<CaptureJob> = {}): CaptureJob {
  return { platform: 'boss', sourceUrl: 'https://www.zhipin.com/job_detail/testJob001.html?lid=tracking', capturedAt: '2026-01-01T08:00:00Z', pageKind: 'detail', fields: { company: '合成测试公司', title: '产品运营实习生', city: '上海', salary: '150-200元/天', education: '本科', experience: '经验不限', jd, jdComplete: true }, ...overrides };
}
const batch = (...jobs: CaptureJob[]): CaptureBatch => ({ protocolVersion: 1, requestId: randomUUID(), jobs });
function setup(path = ':memory:', engine = createModelEngine({})) {
  const store = new Store(path);
  const workflow = new Workflow(store, engine, { fill: async () => ({ evidence: 'test' }), submit: async () => ({ receipt: 'test', evidence: 'test' }) });
  const act = (action: Action) => workflow.act({ ...action, expectedRevision: store.read().revision });
  return { store, workflow, act };
}
test('capture URL normalization retains historical platform URLs and rejects foreign sources and other classified pages', () => {
  assert.deepEqual(normalizeCaptureUrl('boss', capture().sourceUrl), { url: 'https://www.zhipin.com/job_detail/testJob001.html', sourceJobId: 'testJob001' });
  assert.equal(normalizeCaptureUrl('58', 'https://sh.58.com/tech/12345678901234x.shtml?from=list').sourceJobId, '12345678901234');
  assert.equal(normalizeCaptureUrl('58', 'https://bj.58.com/zpshangwumaoyi/12345678901234x.shtml').sourceJobId, '12345678901234');
  for (const url of ['https://www.zhipin.com.evil.test/job_detail/testJob001.html', 'http://www.zhipin.com/job_detail/testJob001.html', 'https://evil@www.zhipin.com/job_detail/testJob001.html', 'https://www.zhipin.com/web/geek/job', 'https://www.zhipin.com/job_detail/testJob001.html/extra']) assert.throws(() => normalizeCaptureUrl('boss', url));
  for (const url of ['https://sh.58.com/zufang/12345678901234x.shtml', 'https://evil.58.com.evil.test/tech/12345678901234x.shtml', 'https://sh.58.com/job.shtml', 'https://58.com/tech/12345678901234x.shtml']) assert.throws(() => normalizeCaptureUrl('58', url));
});
test('capture schema rejects unexpected fields, invalid bounds and insufficient full descriptions', () => {
  assert.ok(captureBatchSchema.safeParse(batch(capture())).success);
  const partial = capture({ pageKind: 'list', fields: { ...capture().fields, jd: '', jdComplete: false } });
  assert.ok(captureBatchSchema.safeParse(batch(partial)).success);
  assert.equal(captureBatchSchema.safeParse(batch(capture({ fields: { ...capture().fields, jd: '短', jdComplete: true } }))).success, false);
  assert.equal(captureBatchSchema.safeParse(batch(capture({ fields: { ...capture().fields, jd: '字'.repeat(16001) } }))).success, false);
  assert.equal(captureBatchSchema.safeParse({ ...batch(capture()), privateProfile: 'ignored?' }).success, false);
  assert.equal(captureBatchSchema.safeParse(batch(...Array.from({length:21}, () => capture()))).success, false);
  assert.equal(captureBatchSchema.safeParse(batch()).success, false);
  assert.equal(captureBatchSchema.safeParse(batch(capture({ capturedAt: '2999-01-01T00:00:00Z' }))).success, false);
  for (const logoUrl of ['https://localhost/track.png', 'https://127.0.0.1/track.png', 'https://office.local/track.png', 'https://img.bosszhipin.com.evil.test/logo.png', 'https://evil.test/logo.png']) assert.equal(captureBatchSchema.safeParse(batch(capture({ fields: {...capture().fields, logoUrl} }))).success, false);
  assert.equal(captureBatchSchema.safeParse(batch(capture({ fields: {...capture().fields, logoUrl: 'https://img.bosszhipin.com/logo.png'} }))).success, true);
  assert.equal(actionSchema.safeParse({ type: 'save_browser_capture', captureId: 'capture-x', edits: { sourceUrl: 'https://evil.test' }, expectedRevision: 0 }).success, false);
});
test('new 58 imports and mixed batches are rejected without writes, including old request replays', async () => {
  const s = setup();
  try {
    const legacy = capture({ platform: '58', sourceUrl: 'https://sh.58.com/tech/12345678901234x.shtml' });
    for (const jobs of [[legacy], [capture(), legacy]]) {
      const request = batch(...jobs);
      assert.equal(captureBatchSchema.safeParse(request).success, false);
      const before = s.store.read();
      await assert.rejects(s.workflow.importBrowserCaptures(request), /仅支持 BOSS直聘/);
      assert.deepEqual(s.store.read(), before);
    }
    // A previously accepted request ID cannot bypass the new import gate.
    const request = batch(legacy), state = s.store.read();
    state.browserCaptureRequests = [{ requestId: request.requestId, payloadHash: 'legacy', completedAt: legacy.capturedAt, result: { requestId: request.requestId, imported: 1, updated: 0, duplicates: 0, errors: [] } }];
    s.store.save(state, state.revision);
    const before = s.store.read();
    await assert.rejects(s.workflow.importBrowserCaptures(request), /仅支持 BOSS直聘/);
    assert.deepEqual(s.store.read(), before);
  } finally { s.store.close(); }
});
test('imports use dedicated capture identity and return only a narrow result', async () => {
  const s = setup();
  try {
    const result = await s.workflow.importBrowserCaptures(batch(capture()));
    assert.deepEqual(Object.keys(result).sort(), ['duplicates', 'errors', 'imported', 'requestId', 'updated']);
    assert.equal(result.imported, 1);
    const record = Object.values(s.store.read().browserCaptures!)[0];
    const card = s.store.read().exploration!.companies[0];
    assert.equal(card.id, record.id); assert.equal(card.sourceKind, 'browser_capture'); assert.equal(card.hiringStatus, 'unverified'); assert.equal(card.salary, '150-200元/天');
    assert.equal(record.rawHistory[0].sourceUrl, capture().sourceUrl); assert.equal(record.rawHistory[0].fields.jd, jd);
    assert.notEqual(record.receivedAt, record.firstCapturedAt);
  } finally { s.store.close(); }
});
test('request retries are idempotent and a reused request id with different data is rejected', async () => {
  const s = setup();
  try {
    const request = batch(capture());
    const first = await s.workflow.importBrowserCaptures(request); const revision = s.store.read().revision;
    assert.deepEqual(await s.workflow.importBrowserCaptures(request), first); assert.equal(s.store.read().revision, revision);
    await assert.rejects(s.workflow.importBrowserCaptures({ ...request, jobs: [capture({ fields: { ...capture().fields, salary: 'different' } })] }), /不同内容/);
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture()))).duplicates, 1);
  } finally { s.store.close(); }
});
test('platform ID dedup ignores tracking but keeps different cities and distinct same-name posts', async () => {
  const s = setup();
  try {
    await s.workflow.importBrowserCaptures(batch(capture()));
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture({ sourceUrl: 'https://www.zhipin.com/job_detail/testJob001.html?new=tracking' })))).duplicates, 1);
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture({ fields: { ...capture().fields, city: '杭州' } })))).imported, 1);
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture({ sourceUrl: 'https://www.zhipin.com/job_detail/testJob002.html' })))).imported, 1);
    assert.equal(Object.keys(s.store.read().browserCaptures!).length, 3);
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture({ fields: { ...capture().fields, city: '' } })))).imported, 1);
    assert.equal(Object.keys(s.store.read().browserCaptures!).length, 4);
  } finally { s.store.close(); }
});
test('empty city is supplemented by later detail without splitting an otherwise unique post', async () => {
  const s = setup();
  try {
    await s.workflow.importBrowserCaptures(batch(capture({ fields: { ...capture().fields, city: '' } })));
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture()))).updated, 1);
    assert.equal(Object.keys(s.store.read().browserCaptures!).length, 1);
    assert.equal(Object.values(s.store.read().browserCaptures!)[0].fields.city, '上海');
  } finally { s.store.close(); }
});
test('list summaries remain incomplete, can be completed, and are never allowed to downgrade full JD', async () => {
  const s = setup();
  try {
    await s.workflow.importBrowserCaptures(batch(capture({ pageKind: 'list', fields: { ...capture().fields, jd: '页面展示的一段岗位摘要，不是完整 JD', jdComplete: false } })));
    const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.act({ type: 'swipe_company', companyId: id, decision: 'like' });
    await assert.rejects(s.act({ type: 'activate_company', companyId: id }), /详情待补充/);
    assert.equal((await s.workflow.importBrowserCaptures(batch(capture()))).updated, 1);
    await s.workflow.importBrowserCaptures(batch(capture({ pageKind: 'list', fields: { ...capture().fields, jd: 'later summary', jdComplete: false } })));
    const saved = s.store.read().browserCaptures![id];
    assert.equal(saved.fields.jd, jd); assert.equal(saved.fields.jdComplete, true); assert.equal(saved.decision, 'like'); assert.equal(saved.selected, true);
  } finally { s.store.close(); }
});
test('preview and app edits stay protected, preserve original source and do not infer JD completeness', async () => {
  const s = setup();
  try {
    const raw = capture({ pageKind: 'list', fields: { ...capture().fields, jd: '页面已展示的简短摘要内容', jdComplete: false }, edits: { company: '用户修正公司名' } });
    await s.workflow.importBrowserCaptures(batch(raw)); const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.act({ type: 'save_browser_capture', captureId: id, edits: { salary: '薪资由用户核对', jd: '用户修正摘要，仍然不是完整岗位说明。' } });
    await s.workflow.importBrowserCaptures(batch(capture({ edits: { company: '后来冲突的修改', salary: '冲突薪资' } })));
    const saved = s.store.read().browserCaptures![id];
    assert.equal(saved.fields.company, '用户修正公司名'); assert.equal(saved.fields.salary, '薪资由用户核对'); assert.equal(saved.fields.jd, '用户修正摘要，仍然不是完整岗位说明。'); assert.equal(saved.fields.jdComplete, false);
    assert.equal(saved.rawHistory[0].fields.company, '合成测试公司'); assert.equal(saved.sourceUrl, 'https://www.zhipin.com/job_detail/testJob001.html');
    await s.act({ type: 'save_browser_capture', captureId: id, edits: { jd, jdComplete: true } });
    assert.equal(s.store.read().browserCaptures![id].fields.jdComplete, true);
  } finally { s.store.close(); }
});
test('bounded raw history keeps the first raw description and latest observations', async () => {
  const s = setup();
  try {
    await s.workflow.importBrowserCaptures(batch(capture()));
    for (let day = 2; day < 10; day++) await s.workflow.importBrowserCaptures(batch(capture({ capturedAt: `2026-01-0${day}T08:00:00Z`, fields: { ...capture().fields, jd: `${jd} 新日期${day}` } })));
    const saved = Object.values(s.store.read().browserCaptures!)[0];
    assert.equal(saved.rawHistory.length, 5); assert.equal(saved.rawHistory[0].fields.jd, jd); assert.equal(saved.rawHistory.at(-1)!.capturedAt, '2026-01-09T08:00:00Z');
  } finally { s.store.close(); }
});
test('later list observations never relabel the retained full JD as freshly captured, while user edits are explicit', async () => {
  const s = setup();
  try {
    await s.workflow.importBrowserCaptures(batch(capture({ pageKind: 'list', fields: {...capture().fields, jd: '列表摘要已展示内容', jdComplete: false} })));
    const fullDate = '2026-01-02T08:00:00Z';
    await s.workflow.importBrowserCaptures(batch(capture({ capturedAt: fullDate })));
    const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.workflow.importBrowserCaptures(batch(capture({ capturedAt: '2026-01-03T08:00:00Z', pageKind: 'list', fields: {...capture().fields, jd: '新的列表摘要内容', jdComplete: false} })));
    let state = s.store.read();
    assert.equal(state.browserCaptures![id].lastCapturedAt, '2026-01-03T08:00:00Z');
    assert.equal(state.browserCaptures![id].jdCapturedAt, fullDate);
    assert.equal(state.exploration!.companies.find(c => c.id === id)!.checkedAt, fullDate);
    assert.equal(state.exploration!.companies.find(c => c.id === id)!.jdUserEdited, false);
    state = await s.act({ type: 'save_browser_capture', captureId: id, edits: {jd: `${jd}\n用户核对后的补充。`, jdComplete: true} });
    const candidate = state.exploration!.companies.find(c => c.id === id)!;
    assert.equal(candidate.jdUserEdited, true); assert.match(candidate.sourceLabel, /用户修订/);
    assert.equal(candidate.checkedAt, state.browserCaptures![id].jdEditedAt);
    assert.equal(state.browserCaptures![id].jdCapturedAt, fullDate);
    assert.equal(state.browserCaptures![id].rawHistory[1].fields.jd, jd);
  } finally { s.store.close(); }
});
test('changing only JD completeness invalidates existing analysis and resume', async () => {
  const s = setup();
  try {
    let state = await s.act({ type: 'extract_profile', profile: exampleProfile });
    for (const fact of state.profile.facts) state = await s.act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
    await s.workflow.importBrowserCaptures(batch(capture())); const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.act({ type: 'swipe_company', companyId: id, decision: 'like' });
    state = await s.act({ type: 'activate_company', companyId: id });
    assert.ok(state.analysis); assert.equal(state.resumes[0].stale, false);
    state = await s.act({ type: 'save_browser_capture', captureId: id, edits: {jdComplete: false} });
    assert.equal(state.analysis, null); assert.equal(state.activeResumeId, null); assert.equal(state.resumes[0].stale, true);
    assert.equal(state.job.jdComplete, false);
    await assert.rejects(s.act({ type: 'analyze_job' }), /详情待补充/);
    await assert.rejects(s.act({ type: 'generate_resume' }), /详情待补充/);
  } finally { s.store.close(); }
});
test('capture selection survives direction changes, source refreshes and undo', async () => {
  const s = setup();
  try {
    await s.act({ type: 'extract_profile', profile: exampleProfile });
    await s.act({ type: 'career_chat', message: '我想探索互联网运营方向' });
    const directions = s.store.read().exploration!.directions;
    await s.act({ type: 'select_directions', directionIds: [directions[0].id] });
    await s.workflow.importBrowserCaptures(batch(capture())); const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.act({ type: 'swipe_company', companyId: id, decision: 'like' });
    await s.act({ type: 'refresh_jobs' });
    assert.equal(s.store.read().exploration!.companies.find(c => c.id === id)!.selected, true);
    if (directions[1]) await s.act({ type: 'select_directions', directionIds: [directions[1].id] });
    assert.equal(s.store.read().exploration!.companies.find(c => c.id === id)!.selected, true);
    await s.act({ type: 'swipe_company', companyId: id, decision: 'dislike' });
    await s.act({ type: 'undo_company_swipe' });
    assert.equal(s.store.read().browserCaptures![id].decision, 'like');
  } finally { s.store.close(); }
});
test('imported job joins native analysis and resume versions; existing job editor protects manual revisions', async () => {
  const s = setup();
  try {
    let state = await s.act({ type: 'extract_profile', profile: exampleProfile });
    for (const fact of state.profile.facts) state = await s.act({ type: 'update_fact', factId: fact.id, text: fact.text, confirmed: true });
    await s.workflow.importBrowserCaptures(batch(capture())); const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.act({ type: 'swipe_company', companyId: id, decision: 'like' });
    state = await s.act({ type: 'activate_company', companyId: id });
    assert.ok(state.analysis); assert.equal(state.resumes.length, 1); assert.equal(state.job.sourceKind, 'browser_capture'); assert.equal(state.resumes[0].job.candidateId, id);
    state = await s.act({ type: 'save_job', job: { ...state.job, company: '用户手动修改的公司', text: `${jd}\n用户核对补充：参与资料整理。` } });
    assert.equal(state.job.sourceKind, 'browser_capture'); assert.equal(state.job.candidateId, id); assert.equal(state.resumes[0].stale, true);
    await s.workflow.importBrowserCaptures(batch(capture()));
    assert.equal(s.store.read().browserCaptures![id].fields.company, '用户手动修改的公司'); assert.match(s.store.read().browserCaptures![id].fields.jd, /用户核对补充/);
  } finally { s.store.close(); }
});
test('concurrent imports preserve both results and never race a busy model action', async () => {
  let finish!: () => void;
  const engine = createModelEngine({});
  engine.extractProfile = async () => { await new Promise<void>(resolve => { finish = resolve; }); return { facts: [], questions: [] }; };
  const s = setup(':memory:', engine);
  try {
    const results = await Promise.all([s.workflow.importBrowserCaptures(batch(capture())), s.workflow.importBrowserCaptures(batch(capture({ sourceUrl: 'https://www.zhipin.com/job_detail/testJob002.html' })))]);
    assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 2); assert.equal(s.store.read().revision, 2);
    const pending = s.act({ type: 'extract_profile', profile: exampleProfile });
    await assert.rejects(s.workflow.importBrowserCaptures(batch(capture())), error => (error as {status:number}).status === 409);
    finish(); await pending;
    assert.equal(Object.keys(s.store.read().browserCaptures!).length, 2);
  } finally { s.store.close(); }
});
test('restart persists imported data and leaves profile, resume snapshots and application records intact', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zhihang-capture-test-'));
  let s = setup(join(folder, 'state.sqlite'));
  try {
    const state = s.store.read(); state.profile.name = '应保留的用户'; s.store.save(state, state.revision);
    const request = batch(capture());
    await s.workflow.importBrowserCaptures(request); const id = Object.keys(s.store.read().browserCaptures!)[0];
    await s.act({ type: 'swipe_company', companyId: id, decision: 'dislike' });
    s.store.close(); s = setup(join(folder, 'state.sqlite'));
    assert.equal(s.store.read().profile.name, '应保留的用户'); assert.equal(s.store.read().browserCaptures![id].decision, 'dislike'); assert.equal(s.store.read().exploration!.companies[0].sourceKind, 'browser_capture');
    assert.equal((await s.workflow.importBrowserCaptures(request)).imported, 1); assert.equal(Object.keys(s.store.read().browserCaptures!).length, 1);
  } finally {
    s.store.close(); const target = resolve(folder);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhihang-capture-test-')) throw new Error('Unexpected cleanup path');
    rmSync(target, {recursive:true});
  }
});
test('legacy 58 records survive restart, keep their source and remain editable without reimport', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zhihang-capture-test-'));
  let s = setup(join(folder, 'state.sqlite'));
  try {
    const raw = capture({ platform: '58', sourceUrl: 'https://sh.58.com/tech/12345678901234x.shtml' });
    const id = 'capture-legacy-58', state = s.store.read();
    state.profile.name = '旧档案用户';
    state.browserCaptures![id] = { id, platform: '58', sourceUrl: raw.sourceUrl, sourceJobId: '12345678901234', firstCapturedAt: raw.capturedAt, lastCapturedAt: raw.capturedAt, receivedAt: raw.capturedAt, updatedAt: raw.capturedAt, rawHistory: [raw], fields: structuredClone(raw.fields), editedFields: [], selected: true, decision: 'like' };
    mergeCaptureCandidates(state); s.store.save(state, state.revision);
    const before = s.store.read();
    s.store.close(); s = setup(join(folder, 'state.sqlite'));
    assert.deepEqual(s.store.read(), before);
    assert.match(s.store.read().exploration!.companies[0].sourceLabel || '', /58同城/);
    await s.act({ type: 'save_browser_capture', captureId: id, edits: { salary: '历史记录用户修正' } });
    await s.act({ type: 'swipe_company', companyId: id, decision: 'dislike' });
    const saved = s.store.read();
    assert.equal(saved.profile.name, '旧档案用户'); assert.equal(saved.browserCaptures![id].fields.salary, '历史记录用户修正');
    assert.equal(saved.browserCaptures![id].platform, '58'); assert.equal(saved.browserCaptures![id].decision, 'dislike');
    assert.deepEqual(saved.browserCaptures![id].rawHistory, [raw]); assert.match(saved.exploration!.companies[0].sourceLabel || '', /58同城/);
    await assert.rejects(s.workflow.importBrowserCaptures(batch(raw)), /仅支持 BOSS直聘/);
    assert.deepEqual(s.store.read(), saved);
  } finally {
    s.store.close(); const target = resolve(folder);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhihang-capture-test-')) throw new Error('Unexpected cleanup path');
    rmSync(target, {recursive:true});
  }
});
