/**
 * ui.js - Dùng chung cho popup.html (sáng) và popup.dark.html (tối)
 *  1) window.dfToast(message, type, ms): thông báo nổi. type = 'success' | 'error' | 'info'
 *  2) Tìm kiếm AI: gửi SEARCH_MULTI_SOURCE_CODE tới service worker và dựng thẻ kết quả
 *  3) Nút #btnTheme: lưu chủ đề vào storage (dfTheme), đặt popup mặc định cho lần mở sau
 *     (chrome.action.setPopup) rồi chuyển ngay sang trang còn lại.
 * Nạp file này TRƯỚC popup.js.
 */
(() => {
  'use strict';

  const PAGES = { light: 'popup.html', dark: 'popup.dark.html' };
  const current = document.body.dataset.theme === 'dark' ? 'dark' : 'light';
  const other = current === 'dark' ? 'light' : 'dark';

  /* ---------- Toast ---------- */
  const ICONS = { // Chỉ là hằng số tĩnh; nội dung thông báo luôn đi qua textContent
    success: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    error: '<path d="M12 6v8M12 18h.01"/>',
    info: '<path d="M12 11v6M12 7h.01"/>',
  };
  let box = null;

  window.dfToast = (message, type = 'success', ms = 2200) => {
    if (!box) {
      box = document.createElement('div');
      box.className = 'df-toast-box';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const toast = document.createElement('div');
    toast.className = `df-toast df-toast--${type}`;
    toast.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[type] || ICONS.info}</svg>`;
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(text);
    box.append(toast);
    while (box.children.length > 3) box.firstChild.remove(); // Tối đa 3 thông báo cùng lúc

    setTimeout(() => {
      toast.classList.add('is-out');
      setTimeout(() => toast.remove(), 220);
    }, ms);
  };

  /* ---------- Tìm code / mã build bằng AI ---------- */
  const aiSearch = document.getElementById('aiSearch');
  const aiOpen = document.getElementById('btnAiSearch');
  const aiClose = document.getElementById('aiSearchClose');
  const aiSettings = document.getElementById('aiSearchSettings');
  const aiSettingsPanel = document.getElementById('aiSettingsPanel');
  const aiSettingsForm = document.getElementById('aiSettingsForm');
  const aiSettingsApiKey = document.getElementById('aiSettingsApiKey');
  const aiSettingsSearchKey = document.getElementById('aiSettingsSearchKey');
  const aiConfigStatus = document.getElementById('aiConfigStatus');
  const aiForm = document.getElementById('aiSearchForm');
  const aiQuery = document.getElementById('aiSearchQuery');
  const aiSubmit = document.getElementById('aiSearchSubmit');
  const aiStatus = document.getElementById('aiSearchStatus');
  const aiLoading = document.getElementById('aiSearchLoading');
  const aiResults = document.getElementById('aiSearchResults');
  let aiConfig = {};
  let aiConfigError = null;
  let aiLastFocus = null;

  function setAiStatus(message, kind = 'info') {
    aiStatus.textContent = message;
    aiStatus.dataset.kind = kind;
  }

  function updateAiConfigStatus() {
    const hasAiKey = !!(aiConfig.aiApiKey || aiConfig.apiKey);
    const hasSearchEndpoint = !!aiConfig.searxngUrl;
    const active = hasAiKey && hasSearchEndpoint;
    aiConfigStatus.textContent = active
      ? `Đang hoạt động · ${String(aiConfig.aiProvider || 'gemini').toUpperCase()}`
      : 'Chưa cấu hình · cần AI key và địa chỉ SearXNG';
    aiConfigStatus.dataset.kind = active ? 'success' : 'error';
    aiSettingsApiKey.placeholder = hasAiKey ? 'Đã lưu · nhập mới để thay thế' : 'Nhập AI API Key';
    aiSettingsSearchKey.placeholder = aiConfig.searchApiKey
      ? 'Đã lưu · nhập mới để thay thế (Tavily)'
      : 'Tùy chọn; SearXNG không cần key';
  }

  function openAiSearch() {
    aiLastFocus = document.activeElement;
    aiSearch.hidden = false;
    aiQuery.focus();
  }

  function closeAiSearch() {
    aiSearch.hidden = true;
    aiLastFocus?.focus();
  }

  function addAiNote(message, kind = 'note') {
    const note = document.createElement('p');
    note.className = `ai-search-note ai-search-note--${kind}`;
    note.textContent = message;
    aiResults.append(note);
  }

  function safeSourceLink(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function renderAiCode(item) {
    const type = item.type === 'build' ? 'build' : 'giftcode';
    const card = document.createElement('article');
    card.className = 'ai-search-card';
    card.dataset.type = type;

    const main = document.createElement('div');
    main.className = 'ai-search-card-main';

    const typeLabel = document.createElement('p');
    typeLabel.className = 'ai-search-card-type';
    typeLabel.textContent = type === 'build' ? 'Mã build' : 'Giftcode';

    const code = document.createElement('p');
    code.className = 'ai-search-card-code';
    code.textContent = item.code;

    main.append(typeLabel, code);
    if (item.label) {
      const label = document.createElement('p');
      label.className = 'ai-search-card-label';
      label.textContent = item.label;
      main.append(label);
    }

    const meta = document.createElement('div');
    meta.className = 'ai-search-card-meta';
    const details = [item.status, item.expires && `Hạn: ${item.expires}`, item.site || item.source].filter(Boolean);
    for (const detail of details) {
      const text = document.createElement('span');
      text.textContent = detail;
      meta.append(text);
    }
    const href = safeSourceLink(item.url);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Nguồn';
      meta.append(link);
    }
    main.append(meta);

    const copy = document.createElement('button');
    copy.className = 'ai-search-copy';
    copy.type = 'button';
    copy.textContent = 'Sao chép';
    copy.setAttribute('aria-label', `Sao chép ${type === 'build' ? 'mã build' : 'giftcode'} ${item.code}`);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.code);
        window.dfToast?.('Đã sao chép', 'success', 1600);
      } catch (err) {
        window.dfToast?.(`Không sao chép được: ${err.message}`, 'error', 2600);
      }
    });

    card.append(main, copy);
    return card;
  }

  function configuredAiOrigins() {
    if (!aiConfig.searxngUrl || !(aiConfig.aiApiKey || aiConfig.apiKey)) return [];
    const provider = ['openai', 'deepseek'].includes(aiConfig.aiProvider) ? aiConfig.aiProvider : 'gemini';
    const defaultBaseUrls = {
      openai: 'https://api.openai.com/v1',
      deepseek: 'https://api.deepseek.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
    };
    const aiBaseUrl = aiConfig.aiBaseUrl || defaultBaseUrls[provider];
    const values = [aiConfig.searxngUrl, aiConfig.crawl4aiUrl, aiBaseUrl].filter(Boolean);
    return [...new Set(values.map((value) => {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Địa chỉ dịch vụ tìm kiếm phải dùng HTTP hoặc HTTPS.');
      }
      return `${url.origin}/*`;
    }))];
  }

  function requestOriginPermissions(origins) {
    if (origins.length === 0) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      chrome.permissions.request({ origins }, (granted) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(granted);
      });
    });
  }

  async function searchAi(query) {
    aiSubmit.disabled = true;
    aiQuery.disabled = true;
    aiLoading.hidden = false;
    aiResults.replaceChildren();
    setAiStatus('Đang tìm bài viết mới trên Reddit, Steam Community và YouTube...');

    let permissionIssue = '';
    try {
      if (aiConfigError) throw new Error(`Không đọc được cấu hình tìm kiếm: ${aiConfigError.message}`);
      const origins = configuredAiOrigins();
      try {
        const granted = await requestOriginPermissions(origins);
        if (!granted) permissionIssue = 'Chưa được cấp quyền truy cập các dịch vụ tìm kiếm đã cấu hình.';
      } catch (err) {
        permissionIssue = `Không xin được quyền truy cập dịch vụ tìm kiếm: ${err.message}`;
      }

      const result = await chrome.runtime.sendMessage({ type: 'SEARCH_MULTI_SOURCE_CODE', query });
      if (!result) throw new Error('Không nhận được phản hồi từ service worker.');

      const codes = Array.isArray(result.codes) ? result.codes : [];
      if (result.origin === 'fallback' || !result.ok) {
        const needsApiKey = result.error?.includes('Thiếu API key AI');
        const noValidCodes = result.error?.includes('Không trích xuất được code hợp lệ nào');
        const note = codes.length
          ? noValidCodes
            ? 'AI không tìm thấy code mới hợp lệ. Các mã dưới đây chỉ là gợi ý đã lưu sẵn.'
            : 'Chưa tìm thấy kết quả AI phù hợp. Đây là một vài mã gợi ý đã lưu sẵn.'
          : 'Chưa tìm thấy kết quả phù hợp. Thử một từ khóa khác nhé.';
        addAiNote(permissionIssue ? `${note} ${permissionIssue}` : note);
        if (result.error) addAiNote(`Thông tin tìm kiếm: ${result.error}`, needsApiKey ? 'error' : 'info');
        if (needsApiKey) {
          setAiStatus('Cần cấu hình API key. Nhấn “Cấu hình” để tiếp tục.', 'error');
        } else {
          setAiStatus(codes.length ? 'Đang hiển thị dữ liệu gợi ý.' : 'Tìm kiếm chưa có kết quả.', 'info');
        }
      } else {
        setAiStatus(`Tìm thấy ${codes.length} kết quả.`, 'success');
      }

      if (codes.length > 0) {
        const visibleCodes = codes.slice(0, 24);
        if (visibleCodes.length < codes.length) {
          addAiNote(`Đang hiển thị ${visibleCodes.length} trong ${codes.length} gợi ý.`);
        }
        aiResults.append(...visibleCodes.map(renderAiCode));
      }
    } catch (err) {
      setAiStatus(`Không thể hoàn tất tìm kiếm: ${err.message}`, 'error');
      addAiNote('Hãy kiểm tra cấu hình dịch vụ AI và thử lại.', 'error');
    } finally {
      aiLoading.hidden = true;
      aiSubmit.disabled = false;
      aiQuery.disabled = false;
    }
  }

  aiOpen.addEventListener('click', openAiSearch);
  aiClose.addEventListener('click', closeAiSearch);
  aiSearch.addEventListener('click', (event) => {
    if (event.target === aiSearch) closeAiSearch();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !aiSearch.hidden) closeAiSearch();
  });
  aiForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (aiQuery.value.trim()) searchAi(aiQuery.value.trim());
  });
  aiSettings.addEventListener('click', () => {
    aiSettingsPanel.hidden = !aiSettingsPanel.hidden;
    if (!aiSettingsPanel.hidden) {
      updateAiConfigStatus();
      aiSettingsApiKey.focus();
    }
  });
  document.getElementById('aiAdvancedSettings').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage().catch((err) => {
      setAiStatus(`Không mở được trang cấu hình nâng cao: ${err.message}`, 'error');
    });
  });
  document.getElementById('aiSettingsClearAiKey').addEventListener('change', (event) => {
    aiSettingsApiKey.disabled = event.target.checked;
  });
  document.getElementById('aiSettingsClearSearchKey').addEventListener('change', (event) => {
    aiSettingsSearchKey.disabled = event.target.checked;
  });
  aiSettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = document.getElementById('aiSettingsSave');
    const clearAiKey = document.getElementById('aiSettingsClearAiKey').checked;
    const clearSearchKey = document.getElementById('aiSettingsClearSearchKey').checked;
    save.disabled = true;
    try {
      const nextConfig = {
        ...aiConfig,
        apiKey: clearAiKey ? '' : (aiSettingsApiKey.value.trim() || aiConfig.apiKey || aiConfig.aiApiKey || ''),
        aiApiKey: clearAiKey ? '' : (aiSettingsApiKey.value.trim() || aiConfig.apiKey || aiConfig.aiApiKey || ''),
        searchApiKey: clearSearchKey ? '' : (aiSettingsSearchKey.value.trim() || aiConfig.searchApiKey || ''),
      };
      await chrome.storage.local.set({ dfAiConfig: nextConfig });
      aiConfig = nextConfig;
      aiSettingsApiKey.value = '';
      aiSettingsSearchKey.value = '';
      document.getElementById('aiSettingsClearAiKey').checked = false;
      document.getElementById('aiSettingsClearSearchKey').checked = false;
      aiSettingsApiKey.disabled = false;
      aiSettingsSearchKey.disabled = false;
      updateAiConfigStatus();
      setAiStatus('Đã lưu khóa API trên thiết bị này.', 'success');
    } catch (err) {
      setAiStatus(`Không lưu được khóa API: ${err.message}`, 'error');
    } finally {
      save.disabled = false;
    }
  });

  aiSubmit.disabled = true;
  chrome.storage.local.get('dfAiConfig').then(({ dfAiConfig: config }) => {
    aiConfig = config || {};
    updateAiConfigStatus();
  }).catch((err) => {
    aiConfigError = err;
    aiConfigStatus.textContent = `Không đọc được cấu hình: ${err.message}`;
    aiConfigStatus.dataset.kind = 'error';
  }).finally(() => {
    aiSubmit.disabled = false;
  });

  /* ---------- Chuyển Sáng / Tối ---------- */
  async function switchTo(theme) {
    await chrome.storage.local.set({ dfTheme: theme });
    try { await chrome.action.setPopup({ popup: PAGES[theme] }); } catch { /* bỏ qua */ }
    location.replace(PAGES[theme]);
  }

  document.getElementById('btnTheme')?.addEventListener('click', () => switchTo(other));

  // Phòng hờ: nếu đang mở nhầm trang so với chủ đề đã lưu thì chuyển sang đúng trang
  chrome.storage.local.get('dfTheme').then(({ dfTheme }) => {
    if ((dfTheme === 'light' || dfTheme === 'dark') && dfTheme !== current) location.replace(PAGES[dfTheme]);
  });
})();
