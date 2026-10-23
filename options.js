'use strict';

const CONFIG_KEY = 'dfAiConfig';
const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
};

const form = document.getElementById('settingsForm');
const keyInput = document.getElementById('aiApiKey');
const keyState = document.getElementById('keyState');
const clearKey = document.getElementById('clearApiKey');
const searchKeyInput = document.getElementById('searchApiKey');
const searchKeyState = document.getElementById('searchKeyState');
const clearSearchKey = document.getElementById('clearSearchApiKey');
const saveStatus = document.getElementById('saveStatus');
let currentConfig = {};

function setStatus(message, kind = '') {
  saveStatus.textContent = message;
  saveStatus.dataset.kind = kind;
}

function setValues(config) {
  document.getElementById('aiProvider').value = DEFAULT_MODELS[config.aiProvider] ? config.aiProvider : 'gemini';
  document.getElementById('aiModel').value = config.aiModel || '';
  document.getElementById('aiBaseUrl').value = config.aiBaseUrl || '';
  document.getElementById('searxngUrl').value = config.searxngUrl || '';
  document.getElementById('crawl4aiUrl').value = config.crawl4aiUrl || '';
  document.getElementById('crawl4aiToken').value = config.crawl4aiToken || '';
  keyInput.value = '';
  keyInput.placeholder = config.aiApiKey ? 'Đã lưu — để trống để giữ nguyên' : 'Nhập API key';
  keyState.textContent = config.aiApiKey ? 'API key đã được lưu (không hiển thị).' : 'Chưa có API key.';
  searchKeyInput.value = '';
  searchKeyInput.placeholder = config.searchApiKey ? 'Đã lưu — để trống để giữ nguyên' : 'SearXNG không cần API key';
  searchKeyState.textContent = config.searchApiKey ? 'Search API key đã được lưu (không hiển thị).' : 'Chưa có Search API key.';
}

function normalizeServiceUrl(value, label, required = false) {
  const input = value.trim();
  if (!input && !required) return '';
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label}: địa chỉ URL không hợp lệ.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label}: chỉ chấp nhận HTTP/HTTPS, không đặt thông tin đăng nhập trong URL.`);
  }
  return url.toString().replace(/\/+$/, '');
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    currentConfig = stored[CONFIG_KEY] || {};
    setValues(currentConfig);
  } catch (error) {
    setStatus(`Không đọc được cấu hình: ${error.message}`, 'error');
    form.querySelector('button[type="submit"]').disabled = true;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('Đang lưu…');
  try {
    const provider = document.getElementById('aiProvider').value;
    const key = keyInput.value.trim();
    const searchKey = searchKeyInput.value.trim();
    const keepCurrentKey = provider === currentConfig.aiProvider;
    const nextApiKey = clearKey.checked ? '' : (key || (keepCurrentKey ? currentConfig.apiKey || currentConfig.aiApiKey : '') || '');
    const nextSearchApiKey = clearSearchKey.checked ? '' : (searchKey || currentConfig.searchApiKey || '');
    const nextConfig = {
      ...currentConfig,
      aiProvider: provider,
      apiKey: nextApiKey,
      aiApiKey: nextApiKey,
      searchApiKey: nextSearchApiKey,
      aiModel: document.getElementById('aiModel').value.trim() || DEFAULT_MODELS[provider],
      aiBaseUrl: normalizeServiceUrl(document.getElementById('aiBaseUrl').value, 'API base URL'),
      searxngUrl: normalizeServiceUrl(document.getElementById('searxngUrl').value, 'SearXNG URL', true),
      crawl4aiUrl: normalizeServiceUrl(document.getElementById('crawl4aiUrl').value, 'Crawl4AI URL'),
      crawl4aiToken: document.getElementById('crawl4aiToken').value.trim(),
    };
    await chrome.storage.local.set({ [CONFIG_KEY]: nextConfig });
    currentConfig = nextConfig;
    clearKey.checked = false;
    clearSearchKey.checked = false;
    setValues(currentConfig);
    setStatus('Đã lưu cấu hình trên thiết bị này.', 'success');
  } catch (error) {
    setStatus(`Không lưu được cấu hình: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
});

clearKey.addEventListener('change', () => {
  keyInput.disabled = clearKey.checked;
});
clearSearchKey.addEventListener('change', () => {
  searchKeyInput.disabled = clearSearchKey.checked;
});

loadConfig();
