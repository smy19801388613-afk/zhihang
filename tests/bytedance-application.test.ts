import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';

const adapter = readFileSync(resolve('extensions/zhihang-capture/adapters/bytedance-application.js'), 'utf8');
const applyUrl = 'https://jobs.bytedance.com/campus/resume/7246662982998313277/apply';
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function withPage(html: string, fn: (page: Page) => Promise<void>, url = applyUrl) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${html}` }));
  await page.goto(url);
  try { await fn(page); } finally { await page.close(); }
}
test('synthetic application diagnostic contains only fixed labels and options, never input values', async () => {
  await withPage(`<form><label for="name">姓名</label><input id="name" value="PRIVATE NAME"><label>电子邮箱<input type="email" value="private@example.com" required></label><label>学历<select><option>本科</option><option>SECRET SCHOOL</option></select></label><label>附件简历<input type="file" accept=".pdf,.docx,SECRET ACCEPT"></label><input type="password" value="SECRET PASSWORD"><label>PRIVATE CUSTOM LABEL<input value="SECRET VALUE"></label><input placeholder="PRIVATE PLACEHOLDER"><button type="button">保存</button><button type="button">PRIVATE BUTTON</button></form><aside>PRIVATE CHAT</aside>`, async page => {
    const result: any = await page.evaluate(adapter);
    assert.equal(result.routeKind, 'apply'); assert.equal(result.positionId, '7246662982998313277');
    assert.equal(result.fields[0].label, '姓名'); assert.equal(result.fields[1].label, '电子邮箱');
    assert.deepEqual(result.fields[2].options, ['本科']); assert.deepEqual(result.fields[3].accept, ['.pdf', '.docx']);
    assert.deepEqual(result.buttons, ['保存']); assert.equal(result.automaticSubmitEnabled, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|private@example|value/u);
  });
});
test('diagnostic refuses login, unrelated and lookalike pages without reading form', async () => {
  for (const url of ['https://jobs.bytedance.com/campus/login', 'https://jobs.bytedance.com.evil.example/campus/resume/7246662982998313277/apply', 'https://jobs.bytedance.com/campus/position/7246662982998313277/detail']) {
    await withPage('<label>姓名<input value="PRIVATE"></label>', async page => {
      const result: any = await page.evaluate(adapter);
      assert.equal(result.fields.length, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }, url);
  }
});
test('diagnostic excludes hidden and password fields and does not trigger actions', async () => {
  await withPage('<label hidden>姓名<input></label><label>手机号码<input type="password"></label><button onclick="window.didSubmit=true">提交</button><input type="hidden" value="PRIVATE">', async page => {
    const result: any = await page.evaluate(adapter);
    assert.equal(result.fields.length, 0); assert.equal(await page.evaluate('window.didSubmit || false'), false);
  });
});
const nested = (label: string, controls: string) => `<div class="formItem__K83"><div class="formItem_label__P12">${label}</div><div class="formItem_control__N42">${'<div>'.repeat(7)}${controls}${'</div>'.repeat(7)}</div></div>`;
test('user-observed CSS module label/control topology supports contact fields and PDF, not custom selects', async () => {
  const html = `<form>${nested('姓名', '<input id="name">')}${nested('手机号码', '<div class="atsx-phone"><div class="atsx-select"><input type="search" id="country"></div><input id="phone"></div>')}${nested('邮箱', '<input id="email">')}${nested('学校名称', '<div class="school_select__P22"><input id="school"></div>')}${nested('简历附件', '<input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg">')}</form><button>保存并投递简历</button>`;
  await withPage(html, async page => {
    const diagnostic: any = await page.evaluate(adapter);
    assert.deepEqual(diagnostic.fields.map((item: any) => item.label), ['姓名', '(未识别静态标签)', '手机号码', '邮箱', '学校名称', '简历附件']);
    assert.deepEqual(diagnostic.submitCandidates, [{ label: '保存并投递简历', disabled: false }]);
    const expected = { positionId: '7246662982998313277', url: applyUrl, deadline: Date.now() + 60_000 };
    const fields = { name: '合成同学', email: 'student@example.com', phone: '13800000000', school: '合成大学' };
    const plan: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.plan(data.expected, data.fields), { expected, fields });
    assert.equal(plan.fields.find((item: any) => item.field === 'name').state, 'can_fill');
    assert.equal(plan.fields.find((item: any) => item.field === 'phone').state, 'can_fill');
    assert.equal(plan.fields.find((item: any) => item.field === 'school').state, 'not_found');
    assert.equal(plan.pdf, 'can_upload');
    const result: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.fill(data.expected, data.fields, data.fingerprint), { expected, fields, fingerprint: plan.fingerprint });
    assert.deepEqual(result.filled, ['name', 'email', 'phone']);
    assert.equal(await page.locator('#country').inputValue(), ''); assert.equal(await page.locator('#school').inputValue(), '');
    assert.equal(await page.locator('#phone').inputValue(), fields.phone);
  });
});
test('fill preserves existing values and rejects page changes before writing', async () => {
  await withPage('<label>姓名<input id="name" value="已有姓名"></label><label>邮箱<input id="email"></label>', async page => {
    await page.evaluate(adapter);
    const expected = { positionId: '7246662982998313277', url: applyUrl, deadline: Date.now() + 60_000 };
    const fields = { name: '不会覆盖', email: 'student@example.com' };
    const plan: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.plan(data.expected, data.fields), { expected, fields });
    assert.equal(plan.fields[0].state, 'preserve_existing');
    await page.evaluate(() => history.replaceState({}, '', '/campus/resume/7246662982998313278/apply'));
    await assert.rejects(() => page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.fill(data.expected, data.fields, data.fingerprint), { expected, fields, fingerprint: plan.fingerprint }), /身份已变化/u);
    assert.equal(await page.locator('#email').inputValue(), '');
  });
});
const approvedBytes = Buffer.from('%PDF-synthetic approved resume');
const approvedHash = createHash('sha256').update(approvedBytes).digest('hex');
const expected = { positionId: '7246662982998313277', url: applyUrl, deadline: Date.now() + 600_000 };
const submitForm = '<form><label>姓名<input id="name" value="合成同学"></label><label>邮箱<input id="email"></label><label>附件简历<input type="file" accept=".pdf"></label></form><label><input type="checkbox" id="agreement" checked>官网协议</label><button id="submit">提交简历</button><div role="status" id="status"></div>';
test('final submit clicks the observed unique button once and accepts only fresh dedicated exact success evidence', async () => {
  await withPage(submitForm, async page => {
    await page.evaluate(adapter);
    await page.locator('input[type="file"]').setInputFiles({ name: 'approved.pdf', mimeType: 'application/pdf', buffer: approvedBytes });
    await page.evaluate(() => { (window as any).clickCount = 0; document.getElementById('submit')!.addEventListener('click', () => { (window as any).clickCount++; document.getElementById('status')!.textContent = '投递成功'; }); });
    const check: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submitPreflight(data.expected, data.approvedHash), { expected, approvedHash });
    assert.equal(check.fileCheck, 'matches_approved_pdf');
    const result: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submit(data.expected, data.approvedHash, data.fingerprint), { expected, approvedHash, fingerprint: check.fingerprint });
    assert.equal(result.outcome, 'submitted'); assert.equal(result.evidence, '投递成功'); assert.equal(await page.evaluate('(window.clickCount)'), 1);
  });
});
test('review invalidates on field or agreement changes, and a different selected PDF blocks submission', async () => {
  for (const change of ['value', 'agreement', 'pdf']) await withPage(submitForm, async page => {
    await page.evaluate(adapter);
    await page.evaluate(() => { (window as any).clickCount = 0; document.getElementById('submit')!.addEventListener('click', () => { (window as any).clickCount++; }); });
    const check: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submitPreflight(data.expected, data.approvedHash), { expected, approvedHash });
    assert.equal(check.fileCheck, 'requires_user_confirmation');
    if (change === 'value') await page.locator('#name').fill('核对之后改动');
    if (change === 'agreement') await page.locator('#agreement').uncheck();
    if (change === 'pdf') await page.locator('input[type="file"]').setInputFiles({ name: 'wrong.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-wrong') });
    await assert.rejects(() => page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submit(data.expected, data.approvedHash, data.fingerprint), { expected, approvedHash, fingerprint: check.fingerprint }), /变化|不是本次批准/u);
    assert.equal(await page.evaluate('(window.clickCount)'), 0);
  });
});
test('a submission redirect remains unknown and never triggers a second click', async () => {
  await withPage(submitForm, async page => {
    await page.evaluate(adapter);
    await page.evaluate(() => { (window as any).clickCount = 0; document.getElementById('submit')!.addEventListener('click', () => { (window as any).clickCount++; history.replaceState({}, '', '/campus/position/application'); }); });
    const check: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submitPreflight(data.expected, data.approvedHash), { expected, approvedHash });
    const result: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submit(data.expected, data.approvedHash, data.fingerprint), { expected, approvedHash, fingerprint: check.fingerprint });
    assert.equal(result.outcome, 'unknown'); assert.equal(await page.evaluate('(window.clickCount)'), 1);
  });
});
test('fill preserves values synchronously populated by a previous input event and detects asynchronous rollback', async () => {
  await withPage('<form><label>姓名<input id="name"></label><label>邮箱<input id="email"></label></form>', async page => {
    await page.evaluate(adapter);
    await page.evaluate(() => document.getElementById('name')!.addEventListener('input', () => { (document.getElementById('email') as HTMLInputElement).value = 'from-site@example.com'; setTimeout(() => { (document.getElementById('name') as HTMLInputElement).value = ''; }, 10); }));
    const fields = { name: '合成同学', email: 'approved@example.com' };
    const plan: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.plan(data.expected, data.fields), { expected, fields });
    const result: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.fill(data.expected, data.fields, data.fingerprint), { expected, fields, fingerprint: plan.fingerprint });
    assert.deepEqual(result.filled, []); assert.deepEqual(result.unverified, ['name']);
    assert.equal(await page.locator('#email').inputValue(), 'from-site@example.com');
    assert.doesNotMatch(JSON.stringify(result), /example.com|合成同学/);
  });
});
test('preflight refuses file replacement, value changes and expiry during asynchronous hashing', async () => {
  for (const change of ['file', 'value', 'expiry']) await withPage(submitForm, async page => {
    await page.evaluate(adapter);
    if (change === 'file') await page.locator('input[type="file"]').setInputFiles({ name: 'approved.pdf', mimeType: 'application/pdf', buffer: approvedBytes });
    const result: any = await page.evaluate(async data => {
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
      let changed = false;
      crypto.subtle.digest = async (...args) => {
        if (!changed) {
          changed = true;
          if (data.change === 'file') { const transfer = new DataTransfer(); transfer.items.add(new File(['%PDF-different'], 'different.pdf', { type: 'application/pdf' })); (document.querySelector('input[type="file"]') as HTMLInputElement).files = transfer.files; }
          if (data.change === 'value') (document.getElementById('name') as HTMLInputElement).value = '校验中改动';
          if (data.change === 'expiry') Date.now = () => data.expected.deadline + 1;
        }
        return nativeDigest(...args);
      };
      try { await (globalThis as any).__zhihangByteDanceApplication.submitPreflight(data.expected, data.approvedHash); return { accepted: true }; }
      catch (error) { return { accepted: false, message: (error as Error).message }; }
    }, { change, expected, approvedHash });
    assert.equal(result.accepted, false); assert.match(result.message, /变化|过期/u);
  });
});
test('upload preserves a file selected while the approved PDF hash is being computed', async () => {
  await withPage(submitForm, async page => {
    await page.evaluate(adapter);
    const plan: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.plan(data.expected, {}), { expected });
    const result: any = await page.evaluate(async data => {
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle); let calls = 0;
      crypto.subtle.digest = async (...args) => {
        if (++calls === 2) { const transfer = new DataTransfer(); transfer.items.add(new File(['%PDF-user-selected'], 'user.pdf', { type: 'application/pdf' })); (document.querySelector('input[type="file"]') as HTMLInputElement).files = transfer.files; }
        return nativeDigest(...args);
      };
      try { await (globalThis as any).__zhihangByteDanceApplication.upload(data.expected, data.payload, data.fingerprint); return { accepted: true }; }
      catch (error) { return { accepted: false, message: (error as Error).message }; }
    }, { expected, fingerprint: plan.fingerprint, payload: { base64: approvedBytes.toString('base64'), sha256: approvedHash } });
    assert.equal(result.accepted, false); assert.match(result.message, /变化/u);
    assert.equal(await page.locator('input[type="file"]').evaluate(element => (element as HTMLInputElement).files![0].name), 'user.pdf');
  });
});
test('final review binds custom combobox text, ARIA checkbox and ATS selection outside its search input', async () => {
  const cases = [
    { html: '<div role="combobox" aria-label="学历"><span id="choice">本科</span></div>', change: 'text' },
    { html: '<div role="checkbox" aria-checked="true" id="choice">本人同意</div>', change: 'checkbox' },
    { html: '<div role="switch" aria-checked="true" id="choice">确认资料</div>', change: 'checkbox' },
    { html: nested('学历', '<div class="atsx-select"><div class="atsx-select-selection-selected-value" id="choice">本科</div><div class="atsx-select-search"><input type="search"></div></div>'), change: 'text' },
  ];
  for (const fixture of cases) await withPage(submitForm + fixture.html, async page => {
    await page.evaluate(adapter);
    await page.evaluate(() => { (window as any).clickCount = 0; document.getElementById('submit')!.addEventListener('click', () => { (window as any).clickCount++; document.getElementById('status')!.textContent = '投递成功'; }); });
    const before: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submitPreflight(data.expected, data.approvedHash), { expected, approvedHash });
    await page.evaluate(change => { const node = document.getElementById('choice')!; if (change === 'text') node.textContent = '硕士'; else node.setAttribute('aria-checked', 'false'); }, fixture.change);
    const after: any = await page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submitPreflight(data.expected, data.approvedHash), { expected, approvedHash });
    assert.notEqual(after.fingerprint, before.fingerprint);
    await assert.rejects(() => page.evaluate(async data => (globalThis as any).__zhihangByteDanceApplication.submit(data.expected, data.approvedHash, data.fingerprint), { expected, approvedHash, fingerprint: before.fingerprint }), /变化/u);
    assert.equal(await page.evaluate('(window.clickCount)'), 0);
    assert.doesNotMatch(JSON.stringify(before), /本科|硕士|本人同意|确认资料/);
  });
});
