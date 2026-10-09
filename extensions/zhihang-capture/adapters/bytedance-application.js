(() => {
  'use strict';
  const origin = 'https://jobs.bytedance.com';
  const knownLabels = ['姓名', '中文姓名', '真实姓名', '名字', '姓氏', '英文姓名', '手机号', '手机号码', '联系电话', '联系方式', '邮箱', '电子邮箱', '邮箱地址', '学校', '学校名称', '毕业院校', '学历', '最高学历', '学位', '专业', '专业名称', '毕业时间', '毕业年月', '毕业年份', '入学时间', '开始时间', '结束时间', '所在城市', '当前所在城市', '现居城市', '到岗时间', '实习时间', '每周实习天数', '实习时长', '教育经历', '教育背景', '工作经历', '实习经历', '项目经历', '语言能力', '语言', '熟练程度', '性别', '国籍', '出生日期', '附件简历', '简历附件', '上传简历', '简历', '作品集', '招聘渠道', '是否接受调剂', '自我评价', '个人简介', '基本信息', '个人信息', '意向信息', '补充信息', '就读时间', '起止时间', '院系', '院系名称', '成绩排名', '学制', '研究方向', '证明材料', '附件', '意向城市', '是否有实习经历', '是否有工作经历'];
  const knownButtons = ['上传简历', '上传附件', '上传', '更换', '添加', '新增', '保存', '下一步', '上一步', '提交', '确认提交', '提交申请', '确认投递', '投递', '预览', '取消', '删除', '完成', '保存并投递简历', '保存并投递', '提交简历', '投递简历', '提交并投递', '提交简历并投递', '立即投递', '确认申请', '确认提交简历', '保存简历并投递'];
  const knownOptions = new Set(['博士', '硕士', '本科', '大专', '专科', '高中', '其他', '是', '否', '男', '女', '保密', '全日制', '非全日制', '应届', '在读', '已毕业', '英语', '中文', '日语', '流利', '熟练', '一般', '初级', '中级', '高级']);
  const compact = value => String(value || '').replace(/[\s*：:]/gu, '').replace(/[(（]必填[)）]/gu, '');
  const canonical = value => knownLabels.find(label => compact(value) === compact(label)) || null;
  const visible = element => !!element && !element.closest('[hidden],[aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const route = () => {
    if (location.origin !== origin) return { kind: 'unsupported', positionId: '' };
    const match = location.pathname.match(/^\/campus\/(resume|position)\/(\d{10,22})\/(apply|detail)\/?$/u);
    if (match && (match[1] === 'resume' && match[3] === 'apply' || match[1] === 'position' && match[3] === 'detail')) return { kind: match[3], positionId: match[2] };
    return { kind: location.pathname === '/campus/login' ? 'login' : 'unsupported', positionId: '' };
  };
  function labelOf(element) {
    const candidates = [];
    if (element.labels) candidates.push(...Array.from(element.labels, label => label.textContent));
    candidates.push(element.getAttribute('aria-label'), element.getAttribute('placeholder'));
    const labelIds = (element.getAttribute('aria-labelledby') || '').split(/\s/u).filter(Boolean).slice(0, 4);
    for (const id of labelIds) candidates.push(document.getElementById(id)?.textContent);
    // Form libraries place label and input beside each other. Only direct field
    // label elements are inspected; never read wrapper/body text or input values.
    const direct = candidates.map(canonical).find(Boolean);
    if (direct) return direct;
    const atsxItem = element.closest('.atsx-form-item');
    if (atsxItem) candidates.push(...Array.from(atsxItem.querySelectorAll(':scope > .atsx-form-item-label,:scope > .atsx-col > .atsx-form-item-label'), label => label.textContent));
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 10 && ancestor !== document.body; depth++, ancestor = ancestor.parentElement) {
      const labels = Array.from(ancestor.querySelectorAll(':scope > label,:scope > [class*="form-label"],:scope > [class*="field-label"],:scope > [class*="FormLabel"],:scope > [class*="FieldLabel"]'));
      if (labels.length === 1 && canonical(labels[0].textContent)) return canonical(labels[0].textContent);
      // Observed in the user's 0.2.1 diagnostic: CSS-module form fields use
      // sibling label/control branches, 7-9 ancestors above their input. Never
      // select a wrapper that has both roles or borrow a neighbouring field.
      const moduleLabels = Array.from(ancestor.children).filter(child => {
        const roles = structure(child).roles;
        return roles.includes('component:label') && !roles.includes('component:control');
      });
      if (moduleLabels.length === 1) {
        const value = moduleLabels[0].textContent;
        if (canonical(value)) return canonical(value);
        const tokens = staticTokens(moduleLabels[0]);
        const longest = tokens.filter(token => !tokens.some(other => other !== token && other.includes(token)));
        if (longest.length === 1) return longest[0];
      }
      if (ancestor.tagName === 'FORM') break;
    }
    return candidates.map(canonical).find(Boolean) || null;
  }
  const structuralClasses = ['atsx-form', 'atsx-form-item', 'atsx-form-item-label', 'atsx-form-item-required', 'atsx-form-item-control', 'atsx-form-item-control-wrapper', 'atsx-form-item-children', 'atsx-input', 'atsx-input-affix-wrapper', 'atsx-select', 'atsx-select-search', 'atsx-select-selection', 'atsx-select-search__field', 'atsx-phone', 'atsx-phone-input', 'atsx-phone-select', 'atsx-checkbox', 'atsx-checkbox-wrapper', 'atsx-upload', 'atsx-upload-select', 'atsx-row', 'atsx-col', 'atsx-btn'];
  function structure(element) {
    const classes = typeof element.className === 'string' ? element.className.split(/\s/u) : [];
    const roles = structuralClasses.filter(name => classes.includes(name));
    for (const name of ['form', 'field', 'label', 'control', 'upload', 'input', 'select', 'resume', 'section']) if (classes.some(value => new RegExp(`(?:^|[-_])${name}(?:[A-Z_-]|$)`, 'u').test(value))) roles.push(`component:${name}`);
    return { tag: element.tagName.toLowerCase(), roles: [...new Set(roles)] };
  }
  function staticTokens(element) {
    const tokens = new Set();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node, visited = 0;
    while ((node = walker.nextNode()) && visited++ < 400) {
      const parent = node.parentElement;
      if (!parent || parent.closest('input,textarea,select,option,script,style,[contenteditable="true"],.atsx-select-selection-selected-value,.atsx-select-search__field__mirror')) continue;
      const text = String(node.textContent || '').trim();
      if (text.length > 100) continue;
      for (const label of knownLabels) if (text.includes(label)) tokens.add(label);
    }
    return [...tokens].sort((a, b) => b.length - a.length).slice(0, 20);
  }
  function nearbyStructure(element) {
    const parents = [];
    let ancestor = element.parentElement;
    for (let depth = 1; ancestor && depth <= 10 && ancestor !== document.body; depth++, ancestor = ancestor.parentElement) {
      const controlCount = ancestor.querySelectorAll('input,textarea,select,[role="combobox"]').length;
      parents.push({ depth, ...structure(ancestor), controlCount: Math.min(controlCount, 100), tokens: staticTokens(ancestor), children: Array.from(ancestor.children).slice(0, 8).map(child => ({ ...structure(child), tokens: staticTokens(child) })) });
      if (ancestor.tagName === 'FORM' || controlCount > 8) break;
    }
    return { self: structure(element), parents };
  }
  function compactContext(element) {
    let ancestor = element.parentElement;
    const controlRoles = new Set(structure(element).roles);
    for (let depth = 1; ancestor && depth <= 10 && ancestor !== document.body; depth++, ancestor = ancestor.parentElement) {
      for (const role of structure(ancestor).roles) if (/select|phone|upload/u.test(role)) controlRoles.add(role);
      const branches = Array.from(ancestor.children).filter(child => structure(child).roles.includes('component:label') && !structure(child).roles.includes('component:control') || child.matches('label,.atsx-form-item-label'));
      if (branches.length === 1 && staticTokens(branches[0]).length) return { labelDepth: depth, groupControls: ancestor.querySelectorAll('input,textarea,select,[role="combobox"]').length, labelTokens: staticTokens(branches[0]), controlRoles: [...controlRoles] };
      if (ancestor.tagName === 'FORM' || ancestor.querySelectorAll('input,textarea,select,[role="combobox"]').length > 8) break;
    }
    return { labelDepth: null, labelTokens: [], controlRoles: [...controlRoles] };
  }
  function controls() {
    return Array.from(document.querySelectorAll('input,textarea,select,[role="combobox"]')).filter(element => {
      const type = (element.getAttribute('type') || '').toLowerCase();
      return !['hidden', 'password'].includes(type) && (visible(element) || type === 'file' && visible(element.parentElement));
    }).slice(0, 160);
  }
  function inspect() {
    const current = route();
    const result = { adapterVersion: 3, site: 'bytedance_campus', routeKind: current.kind, positionId: current.positionId, fields: [], buttons: [], counts: { controls: 0, unknownLabels: 0, fileInputs: 0, frames: 0 }, automaticSubmitEnabled: false };
    if (current.kind !== 'apply') return { ...result, reason: current.kind === 'login' ? '请在官网自行完成登录，再回到申请表重新点击扩展。' : '请先打开已登录的字节校园岗位申请表，再点击扩展。' };
    const elements = controls();
    result.counts.controls = elements.length;
    result.counts.frames = document.querySelectorAll('iframe').length;
    for (const element of elements) {
      const label = labelOf(element);
      const type = element.tagName.toLowerCase() === 'input' ? element.type : element.getAttribute('role') || element.tagName.toLowerCase();
      if (!label) result.counts.unknownLabels++;
      if (type === 'file') result.counts.fileInputs++;
      const descriptor = { label: label || '(未识别静态标签)', type, required: element.required === true || element.getAttribute('aria-required') === 'true' || Boolean(element.closest('.atsx-form-item')?.querySelector('.atsx-form-item-required')), disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true', context: compactContext(element) };
      if (type === 'file') descriptor.accept = String(element.getAttribute('accept') || '').split(',').map(value => value.trim().toLowerCase()).filter(value => /^(?:\.(?:pdf|docx?|jpg|jpeg|png)|application\/(?:pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)|image\/(?:jpeg|png))$/u.test(value)).slice(0, 8);
      if (element.tagName === 'SELECT') descriptor.options = Array.from(element.options).map(option => option.textContent?.trim()).filter(value => knownOptions.has(value)).slice(0, 24);
      result.fields.push(descriptor);
    }
    result.buttons = [...new Set(Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(visible).map(element => knownButtons.find(label => compact(element.textContent) === compact(label))).filter(Boolean))].slice(0, 30);
    result.submitCandidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).map(element => ({ label: knownButtons.find(label => compact(element.textContent) === compact(label)), disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true' })).filter(item => item.label && /投递|提交/u.test(item.label)).slice(0, 8);
    result.automaticSubmitEnabled = result.submitCandidates.filter(item => item.label === '提交简历' && !item.disabled).length === 1;
    return result;
  }
  const fieldLabels = {
    name: ['姓名', '中文姓名', '真实姓名'], email: ['邮箱', '电子邮箱', '邮箱地址'], phone: ['手机号', '手机号码', '联系电话'],
    school: ['学校', '学校名称', '毕业院校'], education: ['学历', '最高学历'], major: ['专业', '专业名称'],
    graduation: ['毕业时间', '毕业年月'], city: ['意向城市'], availability: [],
  };
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
  const checkTarget = expected => {
    const current = route();
    if (!Number.isFinite(expected?.deadline) || Date.now() >= expected.deadline) throw new Error('本次授权或最终核对已过期，未继续填写或提交。请回到职航重新核对。');
    if (!expected || current.kind !== 'apply' || current.positionId !== expected.positionId || location.href !== expected.url) throw new Error('申请页身份已变化。请回到已授权岗位，重新点击扩展；本次不继续填写。');
  };
  async function formFingerprint() {
    return digest(JSON.stringify(inspect()));
  }
  function matchingControls(key) {
    return controls().filter(element => fieldLabels[key]?.includes(labelOf(element)) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.readOnly
      && (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' && ['text', 'email', 'tel'].includes(element.type) && !compactContext(element).controlRoles.some(role => /select/u.test(role))));
  }
  function eligibleFileInputs() {
    return controls().filter(element => element.tagName === 'INPUT' && element.type === 'file' && !element.disabled && !element.multiple
      && ['附件简历', '简历附件', '上传简历', '简历'].includes(labelOf(element))
      && (element.accept || '').split(',').some(value => ['.pdf', 'application/pdf'].includes(value.trim().toLowerCase())));
  }
  function hasExistingValue(element) {
    return element.tagName === 'SELECT' ? Boolean(element.value && element.selectedOptions[0]?.textContent?.trim() && !/^(请选择|选择|Select)/iu.test(element.selectedOptions[0].textContent.trim())) : Boolean(element.value.trim());
  }
  async function plan(expected, fields) {
    checkTarget(expected);
    const rows = [];
    for (const key of Object.keys(fieldLabels)) {
      const value = fields?.[key];
      if (typeof value !== 'string' || !value.trim() || value.length > 500) { rows.push({ field: key, state: 'no_approved_value' }); continue; }
      const found = matchingControls(key);
      if (found.length !== 1) { rows.push({ field: key, state: found.length > 1 ? 'ambiguous' : 'not_found' }); continue; }
      const element = found[0];
      const occupied = hasExistingValue(element);
      if (occupied) { rows.push({ field: key, state: 'preserve_existing' }); continue; }
      if (element.tagName === 'SELECT' && Array.from(element.options).filter(option => option.textContent?.trim() === value.trim()).length !== 1) { rows.push({ field: key, state: 'option_not_found' }); continue; }
      rows.push({ field: key, state: 'can_fill' });
    }
    const files = eligibleFileInputs();
    return { fields: rows, pdf: files.length === 1 ? files[0].files.length ? 'preserve_existing' : 'can_upload' : files.length > 1 ? 'ambiguous' : 'not_found', fingerprint: await formFingerprint() };
  }
  async function fill(expected, fields, fingerprint) {
    checkTarget(expected);
    if (await formFingerprint() !== fingerprint) throw new Error('申请表结构已变化，请重新检查后再填写。');
    const currentPlan = await plan(expected, fields);
    const filled = [], skipped = [];
    for (const row of currentPlan.fields) {
      if (row.state !== 'can_fill') { skipped.push(row); continue; }
      checkTarget(expected);
      const found = matchingControls(row.field);
      if (found.length !== 1 || !found[0].isConnected) throw new Error('填写期间表单结构已变化，请在官网核对已填字段后重新检查。');
      const element = found[0], value = fields[row.field].trim();
      // Earlier input events can synchronously populate a later field. Preserve
      // those website/user values too, not just values present in the first plan.
      if (hasExistingValue(element)) { skipped.push({ field: row.field, state: 'preserve_existing' }); continue; }
      if (element.tagName === 'SELECT') {
        const options = Array.from(element.options).filter(option => option.textContent?.trim() === value);
        if (options.length !== 1) throw new Error('官网选项已变化，已停止填写，请人工核对。');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, options[0].value);
      } else {
        const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      checkTarget(expected);
      filled.push(row.field);
    }
    // React may reconcile after the native setter and event dispatch. Only
    // report a field as filled after the short render cycle retains its value.
    await new Promise(resolve => setTimeout(resolve, 180));
    checkTarget(expected);
    const verified = [], unverified = [];
    for (const key of filled) {
      const found = matchingControls(key), value = fields[key].trim();
      const actual = found.length === 1 ? found[0].tagName === 'SELECT' ? found[0].selectedOptions[0]?.textContent?.trim() : found[0].value : undefined;
      (actual === value ? verified : unverified).push(key);
    }
    return { filled: verified, unverified, skipped, automaticSubmitEnabled: false };
  }
  async function upload(expected, payload, fingerprint) {
    checkTarget(expected);
    if (await formFingerprint() !== fingerprint) throw new Error('申请表结构已变化，未上传。请重新检查。');
    const inputs = eligibleFileInputs();
    if (inputs.length !== 1 || inputs[0].files.length) throw new Error('没有唯一的空白简历 PDF 上传控件，或该控件已选文件。请在官网核对。');
    if (!payload || typeof payload.base64 !== 'string' || payload.base64.length > 14 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(payload.sha256)) throw new Error('审核 PDF 数据无效，未上传。');
    const bytes = Uint8Array.from(atob(payload.base64), character => character.charCodeAt(0));
    const actualHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (actualHash !== payload.sha256 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('PDF 与授权版本不一致，未上传。');
    checkTarget(expected);
    const currentInputs = eligibleFileInputs();
    if (!inputs[0].isConnected || currentInputs.length !== 1 || currentInputs[0] !== inputs[0] || inputs[0].files.length) throw new Error('上传期间控件或已选附件发生变化，未覆盖现有附件。');
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'zhihang-approved-resume.pdf', { type: 'application/pdf' }));
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    checkTarget(expected);
    return { fileSelected: true, uploadVerified: false, message: '已将批准 PDF 交给官网上传控件。请在官网核对上传完成与解析结果。' };
  }
  function submitButton() {
    // This exact label was observed in the user's logged-in 0.2.2 diagnostic.
    // Other tempting labels are diagnostic data only, never click fallbacks.
    const found = Array.from(document.querySelectorAll('button,[role="button"]')).filter(element => visible(element) && compact(element.textContent) === '提交简历');
    if (found.length !== 1 || found[0].disabled || found[0].getAttribute('aria-disabled') === 'true') throw new Error('未找到唯一可用的“提交简历”按钮，请在官网处理必填项、校验或页面变化后重新检查。');
    return found[0];
  }
  let sealedReview = null;
  function customReviewControls(nativeControls) {
    const found = new Set(Array.from(document.querySelectorAll('[role="combobox"],[role="checkbox"],[role="switch"],[role="radio"]')).filter(visible));
    for (const element of nativeControls) {
      let parent = element.parentElement;
      // Only bind actual select components surrounding a field, never the
      // enclosing form, section or body. All ancestors before the field label
      // are needed because ATS select-search wrappers omit the chosen label.
      for (let depth = 0; parent && depth < 12 && parent !== document.body && parent.tagName !== 'FORM'; depth++, parent = parent.parentElement) {
        if (visible(parent) && (parent.matches('.atsx-select') || structure(parent).roles.includes('component:select'))) found.add(parent);
        const labels = Array.from(parent.children).filter(child => structure(child).roles.includes('component:label') && !structure(child).roles.includes('component:control') || child.matches('label,.atsx-form-item-label'));
        if (labels.some(label => staticTokens(label).length)) break;
      }
    }
    if (found.size > 120) throw new Error('官网自定义控件数量超出可核验范围，未提交。请人工核对。');
    return [...found];
  }
  function customState(element) {
    const attributes = Object.fromEntries(['role', 'aria-checked', 'aria-selected', 'aria-valuetext', 'aria-valuenow', 'aria-activedescendant', 'aria-disabled'].map(name => [name, element.getAttribute(name)]));
    const text = (element.innerText || '').trim();
    const selected = Array.from(element.querySelectorAll('[aria-selected="true"],.atsx-select-selection-selected-value')).filter(visible).map(item => ({ text: (item.innerText || '').trim(), selected: item.getAttribute('aria-selected') }));
    const state = { attributes, text, selected };
    if (JSON.stringify(state).length > 4000) throw new Error('官网自定义控件范围不明确，未提交。请人工核对。');
    return state;
  }
  function reviewState() {
    const detected = controls();
    const native = detected.filter(element => element.type !== 'file' && (labelOf(element) || element.closest('form') || ['checkbox', 'radio'].includes(element.type)));
    // An ATS search input can sit deeper than its recognizable label; its
    // nearest explicit select still needs sealing even when native mapping is
    // intentionally unavailable and the user completed that field manually.
    const custom = customReviewControls(detected);
    const fields = native.map(element => ({ label: labelOf(element), type: element.type || element.tagName, value: ['checkbox', 'radio'].includes(element.type) ? undefined : element.value, checked: ['checkbox', 'radio'].includes(element.type) ? element.checked : undefined }));
    return { elements: [...native, ...custom], serialized: JSON.stringify({ structure: inspect(), fields, custom: custom.map(customState) }) };
  }
  function unchangedReview(seal) {
    const now = reviewState(), files = eligibleFileInputs();
    return now.serialized === seal.state.serialized && now.elements.length === seal.state.elements.length && now.elements.every((element, index) => element === seal.state.elements[index])
      && files.length === 1 && files[0] === seal.fileInput && files[0].files.length === (seal.file ? 1 : 0) && (files[0].files[0] || null) === seal.file && submitButton() === seal.button;
  }
  async function submitPreflight(expected, resumeHash) {
    checkTarget(expected); submitButton();
    if (!/^[a-f0-9]{64}$/u.test(resumeHash || '')) throw new Error('缺少批准 PDF 版本校验信息。');
    const files = eligibleFileInputs();
    if (files.length !== 1) throw new Error('无法核验唯一的简历附件区域，请在官网核对后重新读取。');
    const selected = files[0].files;
    const selectedFile = selected[0] || null;
    let fileCheck = 'requires_user_confirmation';
    if (selected.length) {
      if (selected.length !== 1 || selected[0].size > 8 * 1024 * 1024) throw new Error('当前附件不是唯一、大小合规的批准 PDF，禁止提交。');
      const bytes = await selected[0].arrayBuffer();
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== resumeHash) throw new Error('官网当前选中的文件不是本次批准的 PDF，请核对附件，禁止提交。');
      fileCheck = 'matches_approved_pdf';
    }
    checkTarget(expected);
    const currentFiles = eligibleFileInputs();
    if (currentFiles.length !== 1 || currentFiles[0] !== files[0] || currentFiles[0].files.length !== (selectedFile ? 1 : 0) || (currentFiles[0].files[0] || null) !== selectedFile) throw new Error('附件在校验期间变化，未提交。请重新核对。');
    // Seal raw values in this content-script closure only. Nothing sensitive
    // is returned; the UI gets a digest. Recheck after every async boundary and
    // synchronously before the eventual click so late input cannot slip through.
    const seal = { state: reviewState(), button: submitButton(), fileInput: files[0], file: selectedFile, fingerprint: '' };
    seal.fingerprint = await digest(JSON.stringify({ serialized: seal.state.serialized, fileCheck, resumeHash }));
    checkTarget(expected);
    if (!unchangedReview(seal)) throw new Error('表单或附件在校验期间变化，未提交。请重新核对。');
    sealedReview = seal;
    return { fileCheck, fingerprint: seal.fingerprint, buttonLabel: '提交简历' };
  }
  const successPhrases = new Set(['投递成功', '申请成功', '已成功投递', '已投递', '申请已提交']);
  function successNodes(button) {
    return [...document.querySelectorAll('[role="alert"],[role="status"],.atsx-message-notice-content,.atsx-notification-notice-message,.atsx-result-title'), button].filter(element => element?.isConnected && visible(element) && successPhrases.has(element.textContent?.trim()));
  }
  async function submit(expected, resumeHash, fingerprint) {
    const preflight = await submitPreflight(expected, resumeHash);
    if (preflight.fingerprint !== fingerprint) throw new Error('官网表单在最终核对后发生变化，未点击提交。请在官网核验本次记录。');
    const seal = sealedReview, button = submitButton();
    const existing = new Map(successNodes(button).map(element => [element, element.textContent.trim()]));
    checkTarget(expected);
    if (!seal || seal.fingerprint !== fingerprint || !unchangedReview(seal)) throw new Error('最终点击前官网资料已变化，未提交。请在官网核验本次记录。');
    sealedReview = null;
    button.click();
    // The click may be accepted before navigation unloads this document. Never
    // replay it. A fresh exact success phrase in a dedicated status region is
    // evidence; a redirect, validation error or generic body text is not.
    for (let attempt = 0; attempt < 24; attempt++) {
      if (location.href !== expected.url || route().positionId !== expected.positionId) return { outcome: 'unknown', message: '提交后页面发生跳转，请在官网核验结果，勿重复提交。' };
      const evidenceNode = successNodes(button).find(element => existing.get(element) !== element.textContent.trim());
      if (evidenceNode) return { outcome: 'submitted', evidence: evidenceNode.textContent.trim(), pageUrl: location.href, message: '当前官网岗位页面显示明确的投递成功提示。' };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { outcome: 'unknown', message: '已点击一次“提交简历”，尚未读到可核验的成功提示。请在官网检查校验信息与投递记录，勿重复提交。' };
  }
  globalThis.__zhihangByteDanceApplication = { version: 4, inspect, plan, fill, upload, submitPreflight, submit };
  return inspect();
})();
