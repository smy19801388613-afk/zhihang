(() => {
  const excluded = 'script,style,noscript,input,textarea,select,button,[contenteditable],.chat-container,.chat-panel,.boss-info,.recruiter-info,.geek-info,.resume-item,[class*="chat-message"]';
  const visible = element => {
    if (!element || !element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    // display:contents has no box itself, while its company-name children can be visible.
    if (element.getClientRects().length > 0) return true;
    if (style.display !== 'contents') return false;
    if (Array.from(element.children).some(visible)) return true;
    return Array.from(element.childNodes).some(node => {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return false;
      const range = document.createRange(); range.selectNodeContents(node);
      return Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
    });
  };
  // Reads only the adapter's specific job region; form values and unrelated nodes are excluded.
  const text = (element, max = 1000, extraExcluded = '') => {
    if (!visible(element)) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode(node) {
      const parent = node.parentElement;
      return parent && !parent.closest(extraExcluded ? `${excluded},${extraExcluded}` : excluded) && visible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }});
    const parts = []; let node; let size = 0;
    while ((node = walker.nextNode()) && size < max + 1) {
      const value = node.textContent.trim();
      if (value) { parts.push(value); size += value.length + 1; }
    }
    return parts.join('\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
  };
  const first = (root, selectors) => {
    for (const selector of selectors) for (const item of root.querySelectorAll(selector)) if (visible(item)) return item;
    return null;
  };
  const read = (root, selectors, max = 1000) => text(first(root, selectors), max);
  const platformOf = value => {
    try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      if (url.hostname === 'www.zhipin.com' || url.hostname === 'zhipin.com') return 'boss';
    } catch {} return null;
  };
  const jobUrl = (value, platform) => {
    try { const url = new URL(value, location.href); if (platformOf(url.href) !== platform) return '';
      const valid = platform === 'boss' && /^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname);
      if (!valid) return ''; url.search = ''; url.hash = ''; return url.href;
    } catch { return ''; }
  };
  const image = (root, selectors) => {
    const element = first(root, selectors); if (!element) return '';
    try { const url = new URL(element.currentSrc || element.getAttribute('src') || '', location.href);
      const domains = platformOf(location.href) === 'boss' ? ['zhipin.com', 'bosszhipin.com'] : [];
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.href.length <= 2000 && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : '';
    } catch { return ''; }
  };
  const requirements = (root, selectors) => {
    const values = selectors.flatMap(selector => Array.from(root.querySelectorAll(selector))).filter(visible).flatMap(item => text(item, 1000).split(/\n|[|｜]/)).map(value => value.trim()).filter(Boolean);
    return { education: (values.find(value => /学历不限|初中|高中|中专|中技|大专|本科|硕士|博士/.test(value)) || '').slice(0, 200), experience: (values.find(value => /经验不限|无需经验|不限经验|应届|在校|\d+\s*[-—~至]?\s*\d*\s*年/.test(value)) || '').slice(0, 200) };
  };
  globalThis.__zhihangCapture = { visible, text, first, read, platformOf, jobUrl, image, requirements, adapters: {} };
})();
