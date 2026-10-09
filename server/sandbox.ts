/** The sandbox is a synthetic destination: it never contacts a recruitment platform. */
export function sandboxPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>星帆科技 · 模拟网申</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #172a2a; background: #f4f6f2; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .banner { position: sticky; top: 0; z-index: 2; padding: 12px 24px; text-align: center; background: #fff2cf; color: #725316; font-size: 13px; font-weight: 600; }
    header { max-width: 1160px; margin: auto; padding: 30px 32px; display: flex; justify-content: space-between; align-items: center; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 21px; font-weight: 700; }
    .mark { background: #173e39; color: white; padding: 8px 13px; border-radius: 12px; }
    .subtle { color: #73817b; font-size: 13px; font-weight: 400; }
    main { max-width: 1160px; margin: 0 auto; padding: 12px 32px 70px; }
    .eyebrow { color: #377468; font-size: 12px; letter-spacing: 2px; }
    h1 { font-size: 32px; margin: 12px 0; letter-spacing: -1px; }
    .intro { color: #6c7973; font-size: 14px; margin: 0 0 30px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; align-items: start; }
    .panel { background: white; border: 1px solid #e3e8df; border-radius: 20px; padding: 30px; }
    fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    .section-title { font-size: 17px; font-weight: 700; margin-bottom: 22px; display: flex; gap: 10px; align-items: center; }
    .section-title span { display: inline-grid; place-items: center; width: 25px; height: 25px; border-radius: 50%; background: #e9f0e9; color: #477063; font-size: 12px; }
    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .field { display: flex; flex-direction: column; gap: 8px; }
    .wide { grid-column: 1 / -1; }
    label { font-size: 13px; color: #485952; }
    input, select, textarea { width: 100%; border: 1px solid #d9e1d8; border-radius: 9px; padding: 12px; color: #23372f; background: #fdfefb; font: inherit; font-size: 14px; }
    input:focus, select:focus, textarea:focus { outline: 2px solid #b9d2bd; border-color: #668f72; }
    textarea { min-height: 140px; resize: vertical; line-height: 1.7; }
    input[type=file] { padding: 18px 12px; border-style: dashed; background: #f7faf5; }
    input[type=checkbox] { width: 17px; height: 17px; flex-shrink: 0; accent-color: #245448; }
    .divider { border-top: 1px solid #edf0e8; margin: 28px 0; }
    .consent { display: flex; align-items: flex-start; gap: 9px; margin: 22px 0; line-height: 1.65; }
    button { border: 0; border-radius: 10px; padding: 15px 24px; background: #194a3f; color: white; cursor: pointer; font: inherit; font-size: 14px; width: 100%; }
    button:disabled { opacity: .5; cursor: wait; }
    aside h2 { font-size: 17px; margin-top: 0; }
    aside p { font-size: 13px; color: #6d7c72; line-height: 1.9; overflow-wrap: anywhere; }
    .pill { display: inline-block; border-radius: 20px; padding: 6px 10px; background: #eef3e8; color: #567046; font-size: 11px; }
    .steps { padding: 0; list-style: none; font-size: 13px; color: #5d7165; line-height: 2.6; }
    .steps li::before { content: "✓"; margin-right: 10px; color: #5a8464; }
    #status { margin: 0 0 16px; color: #627365; font-size: 13px; }
    #submissionError { color: #a53632; font-size: 13px; white-space: pre-wrap; line-height: 1.6; }
    #success { background: #eaf3e8; border: 1px solid #c4dbbd; padding: 24px; border-radius: 14px; margin-bottom: 24px; }
    #success h2 { margin: 0 0 12px; color: #31583e; }
    #success p { font-size: 14px; line-height: 1.8; }
    #receipt { font-family: Consolas, monospace; overflow-wrap: anywhere; }
    [hidden] { display: none !important; }
    @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } aside { order: -1; } header, main { padding-left: 18px; padding-right: 18px; } .panel { padding: 22px; } .fields { grid-template-columns: 1fr; } h1 { font-size: 27px; } }
  </style>
</head>
<body>
  <div class="banner">模拟网申 · 不向真实企业投递 · 此页面仅用于职航流程验证</div>
  <header><div class="brand"><span class="mark">✦</span>星帆科技 <span class="subtle">虚构示例</span></div><span class="subtle">校园招聘 / 申请中心</span></header>
  <main>
    <div class="eyebrow">YOUR NEXT CHAPTER</div>
    <h1>让下一段旅程，从这里开始。</h1>
    <p class="intro">核对申请资料，完成一次可追溯的模拟投递。</p>
    <section id="success" hidden><h2>模拟申请已收到</h2><p>测试回执：<strong id="receipt" data-testid="receipt"></strong></p><p>该回执只证明本测试站收到了模拟申请，不代表任何真实企业接收了简历。</p></section>
    <div class="layout">
      <form id="applicationForm" class="panel">
        <p id="status" role="status">正在验证模拟申请…</p>
        <p id="submissionError" role="alert"></p>
        <fieldset id="formFields" disabled>
          <div class="section-title"><span>01</span>基本信息</div>
          <div class="fields">
            <div class="field"><label for="fullName">姓名 *</label><input id="fullName" name="name" required maxlength="80" autocomplete="off" /></div>
            <div class="field"><label for="email">邮箱 *</label><input id="email" name="email" type="email" required maxlength="160" autocomplete="off" /></div>
            <div class="field"><label for="phone">联系电话 *</label><input id="phone" name="phone" type="tel" required maxlength="40" autocomplete="off" /></div>
            <div class="field"><label for="city">意向城市 *</label><input id="city" name="city" required maxlength="100" autocomplete="off" /></div>
            <div class="field"><label for="school">就读学校 *</label><input id="school" name="school" required maxlength="160" autocomplete="off" /></div>
            <div class="field"><label for="education">最高学历 *</label><select id="education" name="education" required><option value="">请选择学历</option><option>本科</option><option>硕士</option><option>博士</option><option>专科</option><option>其他</option></select></div>
            <div class="field"><label for="graduation">毕业时间 *</label><input id="graduation" name="graduation" required maxlength="80" placeholder="例如：2027 年 6 月" autocomplete="off" /></div>
            <div class="field"><label for="availability">最早到岗时间 *</label><input id="availability" name="availability" required maxlength="120" autocomplete="off" /></div>
          </div>
          <div class="divider"></div>
          <div class="section-title"><span>02</span>经历与附件</div>
          <div class="fields">
            <div class="field wide"><label for="experience">与岗位相关的个人经历 *</label><textarea id="experience" name="experience" required maxlength="18000"></textarea></div>
            <div class="field wide"><label for="resume">简历附件 · PDF *</label><input id="resume" name="resume" type="file" accept="application/pdf,.pdf" required /></div>
          </div>
          <label class="consent" for="consent"><input id="consent" type="checkbox" required /><span>我已核对以上资料，并知悉本次操作只向职航自建测试站提交模拟申请。</span></label>
          <button id="submitApplication" type="submit">提交模拟申请</button>
        </fieldset>
      </form>
      <aside class="panel">
        <span class="pill">测试环境</span>
        <h2 style="margin-top: 20px">本次申请</h2>
        <p>目标公司标签<br /><strong id="company">待验证</strong></p>
        <p>目标岗位标签<br /><strong id="jobTitle">待验证</strong></p>
        <div class="divider"></div>
        <ul class="steps"><li>核验申请资料</li><li>填写并回读字段</li><li>等待用户明确确认</li><li>提交并取得测试回执</li></ul>
        <p>公司与岗位标签用于还原你的求职场景。星帆科技为虚构示例，本站不连接外部招聘平台。</p>
      </aside>
    </div>
  </main>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const applicationId = params.get('applicationId') || '';
      const token = params.get('token') || '';
      const form = document.getElementById('applicationForm');
      const fieldset = document.getElementById('formFields');
      const error = document.getElementById('submissionError');
      const status = document.getElementById('status');
      const button = document.getElementById('submitApplication');
      let ready = false;
      async function initialize() {
        if (!applicationId || !token) throw new Error('请从职航的申请记录进入此测试页面。');
        const response = await fetch('/api/sandbox/context?' + new URLSearchParams({ applicationId, token }), { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '模拟申请已失效，请返回职航重新准备。');
        document.getElementById('company').textContent = data.company;
        document.getElementById('jobTitle').textContent = data.jobTitle;
        fieldset.disabled = false;
        ready = true;
        status.textContent = '模拟申请已验证，等待填写资料。';
        document.body.dataset.ready = 'true';
      }
      initialize().catch(e => { error.textContent = e.message; status.textContent = '无法打开申请'; });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!ready || button.disabled || !form.reportValidity()) return;
        error.textContent = '';
        button.disabled = true;
        status.textContent = '正在提交模拟申请，请勿重复操作…';
        const fields = {};
        for (const key of ['name', 'email', 'phone', 'school', 'education', 'graduation', 'city', 'availability', 'experience']) {
          fields[key] = form.elements.namedItem(key).value;
        }
        const resume = document.getElementById('resume').files[0];
        try {
          if (!resume || resume.size > 3 * 1024 * 1024) throw new Error('请上传不超过 3 MB 的 PDF 简历。');
          const bytes = new Uint8Array(await resume.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 16384) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
          }
          const resumeData = btoa(binary);
          const response = await fetch('/api/sandbox/submit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applicationId, token, fields, resumeName: resume.name, resumeData, consent: document.getElementById('consent').checked })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || '模拟提交失败，请返回职航核对。');
          if (typeof data.receipt !== 'string' || !data.receipt) throw new Error('未取得有效回执，请返回职航核验结果。');
          document.getElementById('receipt').textContent = data.receipt;
          document.getElementById('success').hidden = false;
          fieldset.disabled = true;
          status.textContent = '模拟投递成功，回执已生成。';
          history.replaceState(null, '', '/sandbox');
          window.scrollTo({ top: 0, behavior: 'instant' });
        } catch (e) {
          error.textContent = e.message || '连接异常，请返回职航核验提交结果。';
          status.textContent = '提交结果需要核验';
          // A network failure may have happened after acceptance. Do not retry automatically.
          button.textContent = '请返回职航核验结果';
        }
      });
    })();
  </script>
</body>
</html>`;
}
