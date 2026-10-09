(() => {
  const c = globalThis.__zhihangCapture;
  const unrelated = '.job-card-wrapper,.job-card-box,.job-card-wrap,.job-card,.job-list-box,.recommend-job,.recommend-list,.job-recommend,.boss-info,.recruiter-info,.chat-container,.chat-panel';
  const companyLink = element => {
    try {
      const url = new URL(element.getAttribute('href'), location.href);
      return c.platformOf(url.href) === 'boss' && /^\/gongsi\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname);
    } catch { return false; }
  };
  const metadata = '.company-industry,.industry-name,.company-tag-list,.tag-list,.salary,.icon-industry,.icon-scale,.icon-stage';
  const nonName = /公司基本信息|查看|全部职位|在招职位|公司介绍|公司主页|进入公司|关注公司|了解更多|融资|^[A-F]轮(?:及以上|以上)?$|^天使轮$|^已上市$|^未上市$|^\d+[\d\s-]*人(?:以上|以下)?$/;
  const nameText = node => {
    if (!c.visible(node) || node.closest(`${unrelated},${metadata},.job-sec-text,.job-description`) || c.first(node, [metadata])) return '';
    let value = c.text(node, 201).trim();
    if (value.includes('\n')) {
      if (c.first(node, ['div,p,li,ul,ol,dl,table,br']) || value.split('\n').some(line => nonName.test(line))) return '';
      value = value.replace(/\n/g, '');
    }
    return value && value.length <= 200 && !nonName.test(value) ? value : '';
  };
  const companyName = root => {
    // Logo links are often first and have no text. Read every candidate rather than
    // stopping at the first visible anchor, and never use the surrounding card text.
    const names = new Set();
    const selector = '.company-name,.company-text,.company-title,a[href*="/gongsi/"]';
    for (const node of [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]) {
      if (!c.visible(node) || node.closest(unrelated)) continue;
      // A semantic name label remains a name when the site handles its link
      // with JavaScript. We only read text here and never follow that link.
      if (node.matches('a') && !node.matches('.company-name,.company-text,.company-title') && !companyLink(node)) continue;
      const value = nameText(node);
      if (!value) continue;
      names.add(value);
    }
    return names;
  };
  const logoRowNames = root => {
    const names = new Set();
    // BOSS also renders non-link/plain-text company headers. Require a visible
    // logo and an isolated name row inside the employer card, never a JD/title.
    for (const img of Array.from(root.querySelectorAll('img')).filter(c.visible)) {
      // Company marks are larger than metadata bullets. Small industry/stage
      // icons provide no evidence that their adjacent text names the employer.
      const box = img.getBoundingClientRect();
      if (box.width < 32 || box.height < 32 || img.closest(`${unrelated},${metadata}`)) continue;
      let row = img.parentElement;
      for (let depth = 0; row && root.contains(row) && depth < 4; depth++, row = row.parentElement) {
        if (row.closest(`${unrelated},${metadata}`) || c.first(row, [metadata, 'button,input,textarea,.job-sec-text,.job-description'])) break;
        // Read leaf name containers separately from the image wrapper. This
        // handles a div-based header without joining unrelated block fields.
        const parts = c.text(row, 401).split('\n').map(value => value.trim()).filter(Boolean);
        if (parts.some(value => nonName.test(value))) break;
        let value = nameText(row);
        if (!value && parts.length === 1 && parts[0].length <= 200) value = parts[0];
        if (value) { names.add(value); break; }
        if (row === root) break;
      }
    }
    return names;
  };
  const findCompanyHeadings = root => {
    const headings = [];
    // Heading text itself is stable even when its element is an unclassed div.
    // Only exact, visible label text is considered; no page/body text is stored.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.textContent.trim() !== '公司基本信息') continue;
      const heading = textNode.parentElement;
      if (c.visible(heading) && !heading.closest(`${unrelated},.job-sec-text,.job-description,script,style`)) headings.push(heading);
    }
    return headings;
  };
  const companyRegion = root => {
    const candidates = Array.from(root.querySelectorAll('.sider-company,.sider-company-info,.job-company-info,.company-basic-info,.job-banner .company-info,.job-box > .company-info,.job-sider .company-info')).filter(node => c.visible(node) && !node.closest(`${unrelated},.job-sec-text,.job-description`)).map(node => ({ node, strategy: 'selector' }));
    // Some detail layouts rename the sidebar classes. A visible company-card
    // heading can identify its local container without searching other jobs or JD.
    const headings = findCompanyHeadings(root);
    for (const heading of headings) {
      let node = heading.parentElement;
      for (let depth = 0; node && node !== root && depth < 3; depth++, node = node.parentElement) {
        if (node.querySelector('.job-primary,.job-banner,.job-sec-text,.job-description') || node.matches(unrelated)) break;
        if (companyName(node).size || logoRowNames(node).size) { candidates.push({ node, strategy: 'heading' }); break; }
        if (c.first(node, ['img'])) { candidates.push({ node, strategy: 'heading' }); break; }
      }
    }
    const choices = candidates.map(candidate => {
      const explicit = companyName(candidate.node);
      const names = explicit.size ? explicit : logoRowNames(candidate.node);
      return { ...candidate, names, strategy: !explicit.size && names.size ? 'logo_row' : candidate.strategy };
    });
    const choice = choices.find(candidate => candidate.names.size === 1) || choices[0];
    const node = choice?.node;
    const diagnosticClasses = new Set(['sider-company', 'sider-company-info', 'job-company-info', 'company-basic-info', 'company-info', 'job-sider']);
    const count = value => Math.min(200, value);
    const diagnostics = {
      reason: !node ? 'missing_company_region' : choice.names.size > 1 ? 'ambiguous_company_name' : choice.names.size === 1 ? 'company_found' : 'missing_company_name',
      strategy: choice?.strategy || 'none',
      regionTag: node && ['DIV', 'SECTION', 'ASIDE', 'ARTICLE', 'LI', 'P', 'A'].includes(node.tagName) ? node.tagName : '',
      regionClasses: node ? Array.from(node.classList).filter(value => diagnosticClasses.has(value)) : [],
      counts: { regions: count(candidates.length), headings: count(headings.length), nameNodes: count(node?.querySelectorAll('.company-name,.company-text,.company-title').length || 0), companyLinks: count(node ? Array.from(node.querySelectorAll('a')).filter(companyLink).length : 0), visibleLogos: count(node ? Array.from(node.querySelectorAll('img')).filter(c.visible).length : 0), names: count(choice?.names.size || 0) },
    };
    return { node, name: choice?.names.size === 1 ? Array.from(choice.names)[0] : '', diagnostics };
  };
  const companyFields = root => {
    const industryNode = c.first(root, ['.company-industry', '.industry-name', 'a[ka*="industry"]', '.icon-industry']);
    const industryText = industryNode?.matches('.icon-industry') ? c.text(industryNode.parentElement, 201) : c.text(industryNode, 201);
    // A shared parent can include financing or headcount. Leave ambiguous text
    // empty instead of persisting the whole card as an industry.
    const industry = industryText.length <= 200 && !/\n|融资|\d+[\d\s-]*人/.test(industryText) ? industryText : '';
    return {
      industry,
      logoUrl: c.image(root, ['.company-logo img', '.logo img', 'a[href*="/gongsi/"] img', 'img.company-logo']),
    };
  };
  const fields = root => {
    const requirements = c.requirements(root, ['.job-primary .info-primary > p', '.job-info p', '.job-tags span', '.tag-list li', '.job-info-item', '.job-limit']);
    return {
      company: c.read(root, ['.company-info .company-name', '.company-name a', '.company-name', '.company-info a[ka*="company"]', '.sider-company .company-info > a'], 200),
      title: c.read(root, ['.job-primary .name h1', '.job-info .job-name', '.job-name', '.name h1'], 200),
      city: c.read(root, ['.job-area', '.job-primary .text-city', '.job-info .job-area-wrapper', '.info-primary .text-city'], 100),
      salary: c.read(root, ['.salary', '.job-salary'], 200), ...requirements,
      jd: '', jdComplete: false,
      industry: c.read(root, ['.company-tag-list li:first-child', '.company-info .company-industry', '.company-industry'], 200),
      logoUrl: c.image(root, ['.company-logo img', '.company-info .logo img', '.sider-company .logo img']),
    };
  };
  const cardSelector = '.job-card-wrapper,.job-card-box,.job-card-wrap,.job-list-box .job-card,.job-list-container .job-card';
  const descriptionSelector = '.job-sec-text,.job-description,.job-detail-section .job-detail';
  const normalizeLabel = value => value.normalize('NFKC').replace(/\s+/g, '').trim();
  const cardSelected = node => node.matches('.active,.selected,.is-active,.job-card-active,[aria-selected="true"],[data-selected="true"]')
    || Boolean(c.first(node, ['.job-card-box.active,.job-card-wrapper.active,.job-card-wrap.active', 'a.job-card-left[aria-current="true"]', 'a.job-card-left[aria-selected="true"]']));
  const getCards = () => Array.from(document.querySelectorAll(cardSelector)).filter(node => c.visible(node)
    && !node.parentElement?.closest(cardSelector)
    && !node.closest('.recommend-job,.recommend-list,.job-recommend,.boss-info,.recruiter-info,.chat-container,.chat-panel'))
    // Inspect selection markers only before the limit; job field text is read
    // for at most twenty cards, with the currently selected card first.
    .slice(0, 200).sort((a, b) => Number(cardSelected(b)) - Number(cardSelected(a))).slice(0, 20);
  const cardRecord = node => {
    const anchor = c.first(node, ['a.job-card-left[href*="/job_detail/"]', 'a.job-name[href*="/job_detail/"]', 'a[href*="/job_detail/"]']);
    const sourceUrl = c.jobUrl(anchor?.href, 'boss');
    if (!sourceUrl) return null;
    const value = fields(node);
    if (!value.title) value.title = c.read(node, ['.job-title', '.job-name-box'], 200);
    if (!value.title) return null;
    value.jd = c.read(node, ['.job-description', '.job-desc', '.job-summary'], 16000);
    const selected = cardSelected(node);
    return { node, selected, id: new URL(sourceUrl).pathname.match(/\/job_detail\/([^/]+)\.html$/)[1], job: { sourceUrl, pageKind: 'list', fields: value } };
  };
  const readDescription = (root, node) => {
    const description = c.text(node, 16001, unrelated);
    const clipped = node && node.scrollHeight > node.clientHeight + 8 && /hidden|clip/.test(getComputedStyle(node).overflowY);
    return { jd: description.slice(0, 16000), jdComplete: Boolean(description && description.length <= 16000 && !clipped
      && !c.first(node || root, ['.show-more', '.more-btn', '.expand-btn'])) };
  };
  const inlineIdentity = (panel, header, description) => {
    const ids = new Set(); let invalid = false;
    const addUrl = raw => {
      if (!raw) return;
      const url = c.jobUrl(raw, 'boss');
      if (!url) { invalid = true; return; }
      ids.add(new URL(url).pathname.match(/\/job_detail\/([^/]+)\.html$/)[1]);
    };
    // Only explicit job identities are evidence. A query-string jobId, card
    // position, salary or matching title cannot identify the right-hand JD.
    const nodes = new Set([panel, header]);
    for (const item of header.querySelectorAll('[data-job-id],[data-jobid],[data-encrypt-job-id],[data-encrypt-jobid],[data-job-url],[data-job-detail-url]')) {
      if (c.visible(item) && !item.closest(`${unrelated},${descriptionSelector}`)) nodes.add(item);
    }
    let node = description;
    while (node && panel.contains(node)) { nodes.add(node); if (node === panel) break; node = node.parentElement; }
    for (const item of nodes) {
      for (const attribute of ['data-job-id', 'data-jobid', 'data-encrypt-job-id', 'data-encrypt-jobid']) {
        const raw = item.getAttribute(attribute)?.trim(); if (!raw) continue;
        if (/^[A-Za-z0-9_-]{6,150}$/.test(raw)) ids.add(raw); else invalid = true;
      }
      for (const attribute of ['data-job-url', 'data-job-detail-url']) addUrl(item.getAttribute(attribute));
    }
    for (const anchor of header.querySelectorAll('a[href*="/job_detail/"]')) {
      if (c.visible(anchor) && !anchor.closest(`${unrelated},${descriptionSelector}`)) addUrl(anchor.getAttribute('href'));
    }
    return { ids, invalid };
  };
  const inlineDetail = records => {
    const panels = Array.from(document.querySelectorAll('.job-detail-container,.job-detail-box,.job-detail-wrap,.job-detail-panel,.job-search-detail'))
      .filter(node => c.visible(node) && !node.closest(unrelated)
        && !Array.from(node.querySelectorAll(cardSelector)).some(card => !card.closest('.recommend-job,.recommend-list,.job-recommend'))).slice(0, 40);
    if (!panels.length) return null;
    const selected = records.filter(record => record.selected);
    const diagnostics = { reason: 'missing_header', counts: { cards: records.length, selectedCards: selected.length, panels: panels.length, identifiedPanels: 0, descriptionPanels: 0 } };
    const candidates = []; const failures = [];
    for (const panel of panels) {
      const description = Array.from(panel.querySelectorAll(descriptionSelector)).find(node => c.visible(node) && !node.closest(unrelated));
      if (description) diagnostics.counts.descriptionPanels++;
      let header = c.first(panel, ['.job-detail-header', '.job-header', '.job-primary', '.job-banner', '.job-detail-info']);
      if (!header) {
        const title = Array.from(panel.querySelectorAll('.job-name,.job-title,h1')).find(node => c.visible(node) && !node.closest(`${unrelated},${descriptionSelector}`));
        if (title) header = title.parentElement;
      }
      if (!header || header.closest(`${unrelated},${descriptionSelector}`)) continue;
      diagnostics.reason = 'missing_identity';
      const identity = inlineIdentity(panel, header, description);
      if (identity.invalid || identity.ids.size !== 1) { failures.push(identity.ids.size > 1 ? 'conflict' : 'missing_identity'); continue; }
      diagnostics.counts.identifiedPanels++;
      const id = [...identity.ids][0];
      const matching = records.filter(record => record.id === id);
      if (matching.length !== 1 || selected.length > 1 || selected.length === 1 && selected[0].id !== id) { failures.push('conflict'); continue; }
      const record = matching[0];
      const detail = fields(header);
      if (!detail.title) detail.title = c.read(header, ['.job-title', 'h1', 'h2'], 200);
      const detailRequirements = c.requirements(header, ['.job-tags span', '.job-labels span', '.job-info span', '.job-limit span', '.job-info p']);
      if (!detail.education) detail.education = detailRequirements.education;
      if (!detail.experience) detail.experience = detailRequirements.experience;
      if (!detail.title || normalizeLabel(detail.title) !== normalizeLabel(record.job.fields.title)) { failures.push('conflict'); continue; }
      const cityA = normalizeLabel(detail.city); const cityB = normalizeLabel(record.job.fields.city);
      if (cityA && cityB && !cityA.startsWith(cityB) && !cityB.startsWith(cityA)) { failures.push('conflict'); continue; }
      if (c.first(panel, ['[aria-busy="true"]', '.loading', '.is-loading', '.loading-container']) || panel.getAttribute('aria-busy') === 'true') { failures.push('loading'); continue; }
      const company = companyRegion(panel);
      if (company.name && record.job.fields.company && normalizeLabel(company.name) !== normalizeLabel(record.job.fields.company)) { failures.push('conflict'); continue; }
      const merged = { ...record.job.fields };
      for (const key of ['title', 'city', 'salary', 'education', 'experience']) if (detail[key]) merged[key] = detail[key];
      if (!merged.company && company.name) merged.company = company.name;
      // The left card's employer is used only after a unique job ID match.
      // Private recruiter blocks and recommendations do not participate.
      const body = readDescription(panel, description);
      if (body.jd) Object.assign(merged, body);
      candidates.push({ record, job: { sourceUrl: record.job.sourceUrl, pageKind: body.jd ? 'detail' : 'list', fields: merged } });
    }
    const unique = new Map();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.record.id);
      if (previous && JSON.stringify(previous.job.fields) !== JSON.stringify(candidate.job.fields)) return { diagnostics: { ...diagnostics, reason: 'identity_conflict' }, reason: '右侧存在内容不一致的岗位详情区域，已保留列表摘要。请等待切换完成，或打开单个岗位详情后重新采集。' };
      unique.set(candidate.record.id, candidate);
    }
    if (unique.size === 1 && !failures.includes('conflict')) {
      const candidate = [...unique.values()][0];
      return { candidate, diagnostics: { ...diagnostics, reason: candidate.job.fields.jdComplete ? 'matched' : 'missing_detail' }, reason: candidate.job.fields.jdComplete ? '' : '已核对当前选中岗位；右侧完整 JD 尚未展示，保留“详情待补充”。请展开完整描述或打开单岗位详情后重新采集。' };
    }
    return { diagnostics: { ...diagnostics, reason: failures.includes('conflict') || unique.size > 1 ? 'identity_conflict' : failures.includes('loading') ? 'loading' : diagnostics.reason }, reason: failures.includes('conflict') || unique.size > 1
      ? '左侧选中岗位与右侧详情的岗位标识或标题不一致，已保留列表摘要。请等待切换完成后重新点击扩展。'
      : failures.includes('loading') ? '右侧详情仍在加载，已保留列表摘要。请加载完成后重新点击扩展。'
        : '已识别左右分栏，但右侧没有可核对的岗位标识或详情链接；已保留列表摘要，未混入右侧 JD。请打开该岗位的单独详情页后再次采集。' };
  };
  c.adapters.boss = () => {
    const detailUrl = c.jobUrl(location.href, 'boss');
    if (detailUrl) {
      const root = c.first(document, ['.job-detail-box', '.job-box', '#main .job-banner'])?.closest('#main') || c.first(document, ['.job-detail-container']);
      if (!root) return { jobs: [], reason: '没有找到 BOSS 岗位详情区域。页面可能未加载、需要登录，或结构已变化。' };
      const primary = c.first(root, ['.job-primary', '.job-banner', '.job-detail-container > .job-info']);
      const company = companyRegion(root);
      // Never fill a missing detail header from recommended jobs elsewhere in #main.
      if (!primary) return { jobs: [], reason: '岗位详情头部尚未加载，已避免读取推荐岗位。请稍候重新点击扩展。' };
      const result = fields(primary);
      const employer = company.node ? companyFields(company.node) : null;
      result.company = company.name;
      result.industry = employer?.industry || '';
      result.logoUrl = employer?.logoUrl || '';
      const jdNode = c.first(root, ['.job-sec-text', '.job-detail-section .job-detail', '.job-description']);
      const description = c.text(jdNode, 16001, unrelated);
      result.jd = description.slice(0, 16000);
      const truncated = jdNode && (jdNode.scrollHeight > jdNode.clientHeight + 8 && /hidden|clip/.test(getComputedStyle(jdNode).overflowY));
      result.jdComplete = Boolean(result.jd && description.length <= 16000 && !truncated && !c.first(jdNode || root, ['.show-more', '.more-btn', '.expand-btn']));
      const titleAnchor = c.first(primary, ['a[href*="/job_detail/"]']);
      if (titleAnchor && c.jobUrl(titleAnchor.href, 'boss') !== detailUrl) return { jobs: [], reason: '页面中的岗位链接与地址栏不一致，请等待页面切换完成后重新点击扩展。' };
      return { jobs: result.title ? [{ sourceUrl: detailUrl, pageKind: 'detail', fields: result, companyDiagnostics: company.diagnostics }] : [], reason: result.title ? '' : '岗位标题尚未加载，请稍候再试或手动粘贴。' };
    }
    const records = getCards().map(cardRecord).filter(Boolean);
    const inline = inlineDetail(records);
    const ordered = inline?.candidate ? [inline.candidate.job, ...records.filter(record => record !== inline.candidate.record).map(record => record.job)] : records.map(record => record.job);
    const seen = new Set();
    const jobs = ordered.filter(job => { const key = `${job.sourceUrl}|${normalizeLabel(job.fields.city)}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 20);
    return { jobs, stabilityCheck: Boolean(inline), inlineDiagnostics: inline?.diagnostics || { reason: 'missing_panel', counts: { cards: records.length, selectedCards: records.filter(record => record.selected).length, panels: 0, identifiedPanels: 0, descriptionPanels: 0 } }, reason: inline?.reason || (jobs.length ? '' : '没有找到当前已展示的 BOSS 岗位卡片。请自行登录、完成验证码并打开岗位结果页或详情页；也可手动粘贴 JD。') };
  };
})();
