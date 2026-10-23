/**
 * popup.js - Logic của giao diện popup
 *
 * Vai trò:
 *  - Đọc danh sách code + delay người dùng nhập.
 *  - Gửi lệnh BẮT ĐẦU / DỪNG sang content script (chạy trong trang web).
 *  - Hiển thị trạng thái. Vì popup sẽ bị đóng khi bạn bấm ra ngoài, trạng thái
 *    được content script lưu vào chrome.storage.local, popup chỉ việc đọc và vẽ lại.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  codes: $('codes'),
  count: $('codeCount'),
  pct: $('pct'),
  delay: $('delay'),
  start: $('btnStart'),
  stop: $('btnStop'),
  panel: $('panel'),
  status: $('status'),
  bar: $('bar'),
  cntSuccess: $('cntSuccess'),
  cntFail: $('cntFail'),
  cntUnknown: $('cntUnknown'),
  log: $('log'),
};

// Nhãn hiển thị cho từng kết quả
const RESULT_LABEL = {
  success: 'Thành công',
  fail: 'Thất bại',
  unknown: 'Đã gửi, chưa rõ kết quả',
};

// Khu vực "Cập nhật code mới"
const upd = {
  check: $('btnCheck'),
  addNew: $('btnAddNew'),
  meta: $('updMeta'),
  auto: $('autoCheck'),
  interval: $('autoInterval'),
};

let activeTabId = null;
let newCodes = [];     // Danh sách code mới do background.js tìm được (đọc từ storage)
let isRunning = false; // Đang nhập code hay không (để khoá nút "Thêm code mới")

// Mỗi tab có một khoá trạng thái riêng để các tab không đè lên nhau
const stateKey = (tabId) => `dfState_${tabId}`;

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Tách textarea thành danh sách code: bỏ dòng trống, lấy từ đầu tiên của dòng, bỏ trùng */
function parseCodes(text) {
  const list = text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  return [...new Set(list)];
}

/** Đọc delay (giây), giới hạn trong khoảng 1 - 60 giây */
function readDelaySec() {
  const value = parseFloat(el.delay.value);
  if (Number.isNaN(value)) return 2.5;
  return Math.min(60, Math.max(1, value));
}

/** Kiểm tra content script đã có mặt trong tab chưa */
async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return !!res?.ok;
  } catch {
    return false;
  }
}

/** Nếu content script chưa được nạp thì nạp thủ công (cần quyền activeTab + scripting) */
async function ensureContentScript(tabId) {
  if (await ping(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/* ------------------------------------------------------------------ */
/* Hiển thị                                                            */
/* ------------------------------------------------------------------ */

function setStatus(message, level) {
  el.status.textContent = message;
  el.panel.dataset.level = level;
}

/** Vẽ lại toàn bộ khu vực trạng thái theo state do content script lưu */
function render(state) {
  const running = !!state?.running;
  isRunning = running;
  updateNewUI();
  renderVault(); // Nút "Nạp vào ô nhập" bị khoá khi đang chạy

  // Khoá/mở các ô nhập và nút theo trạng thái chạy
  el.start.disabled = running;
  el.stop.disabled = !running;
  el.codes.disabled = running;
  el.delay.disabled = running;

  if (!state) {
    setStatus('Sẵn sàng. Dán danh sách code rồi nhấn "START".', 'idle');
    el.bar.style.width = '0%';
    el.pct.textContent = '0%';
    el.cntSuccess.textContent = el.cntFail.textContent = el.cntUnknown.textContent = '0';
    el.log.replaceChildren();
    return;
  }

  setStatus(state.message, running ? 'running' : state.level || 'idle');

  // Thanh tiến trình
  const done = state.results.length;
  const percent = state.total ? Math.round((done / state.total) * 100) : 0;
  el.bar.style.width = `${percent}%`;
  el.pct.textContent = `${percent}%`;

  // Đếm theo từng loại kết quả
  const count = (status) => state.results.filter((r) => r.status === status).length;
  el.cntSuccess.textContent = count('success');
  el.cntFail.textContent = count('fail');
  el.cntUnknown.textContent = count('unknown');

  // Nhật ký từng code (dùng textContent để an toàn với dữ liệu người dùng)
  const items = state.results.map((r, i) => {
    const li = document.createElement('li');
    li.title = r.note || '';

    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = `${i + 1}. ${r.code}`;

    const result = document.createElement('span');
    result.className = r.status;
    result.title = RESULT_LABEL[r.status] || r.status;
    result.textContent = RESULT_LABEL[r.status] || r.status;

    li.append(code, result);
    return li;
  });
  el.log.replaceChildren(...items);
  el.log.scrollTop = el.log.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Sự kiện nút bấm                                                     */
/* ------------------------------------------------------------------ */

async function onStart() {
  const all = parseCodes(el.codes.value);
  // Bỏ qua code kho đã ghi là Đã dùng / Hết hạn: nhập lại chỉ tốn thời gian (mỗi code mất 1 delay)
  const codes = all.filter((c) => !isSpent(c));
  const skipped = all.length - codes.length;
  if (all.length > 0 && codes.length === 0) {
    setStatus(`Cả ${all.length} code đều đã dùng hoặc hết hạn. Hãy bấm "Kiểm tra ngay" để tìm code mới.`, 'warn');
    return;
  }
  if (skipped > 0) window.dfToast?.(`Bỏ qua ${skipped} code đã dùng / hết hạn`, 'info', 2600);
  if (codes.length === 0) {
    setStatus('Hãy dán ít nhất một code vào ô danh sách.', 'error');
    return;
  }
  if (activeTabId == null) {
    setStatus('Không xác định được tab hiện tại.', 'error');
    return;
  }

  // Ghi các code sắp nhập vào kho (Mới). Kết quả từng code sẽ được content script báo về để phân loại.
  askBackground({ type: 'CODES_ADD', codes, source: 'manual' });

  try {
    await ensureContentScript(activeTabId);
    const res = await chrome.tabs.sendMessage(activeTabId, {
      type: 'START',
      tabId: activeTabId,
      codes,
      delaySec: readDelaySec(),
    });
    if (!res?.ok) setStatus(res?.error || 'Không thể bắt đầu.', 'error');
  } catch (err) {
    // Thường gặp ở các trang chrome://, Chrome Web Store hoặc trang chưa cấp quyền
    setStatus('Không chạy được trên trang này. Hãy mở trang đổi code của Garena rồi thử lại.', 'error');
  }
}

async function onStop() {
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'STOP' });
    setStatus('Đang dừng...', 'warn');
  } catch {
    // Content script không còn (trang đã tải lại) - không có gì để dừng
  }
}

/** Lưu nháp (danh sách code + delay) để mở lại popup không bị mất */
function updateCount() {
  el.count.textContent = `${parseCodes(el.codes.value).length} code`;
}

function saveDraft() {
  updateCount();
  chrome.storage.local.set({ dfDraft: { codes: el.codes.value, delay: el.delay.value } });
}

/* ------------------------------------------------------------------ */
/* Cập nhật code mới                                                   */
/* ------------------------------------------------------------------ */

/** Code đã được kho ghi là Đã dùng / Hết hạn (không cần nhập lại) */
function isSpent(code) {
  const status = registry[String(code).toLowerCase()]?.state;
  return status === 'used' || status === 'expired';
}

/** Hàng chờ code mới thực sự còn giá trị: bỏ code đã dùng / hết hạn */
const pendingCodes = () => newCodes.filter((c) => !isSpent(c));

/** Cập nhật chữ và trạng thái của nút "Thêm ... code mới" */
function updateNewUI() {
  const count = pendingCodes().length;
  upd.addNew.textContent = `Thêm ${count} code mới`;
  upd.addNew.disabled = isRunning || count === 0;
}

/** Hiện thời điểm kiểm tra gần nhất và số nguồn tải được */
function renderMeta(meta) {
  if (!meta) {
    upd.meta.textContent = 'Chưa kiểm tra';
    return;
  }
  const time = new Date(meta.checkedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  upd.meta.textContent =
    meta.ok === 0 ? `Lỗi mạng lúc ${time}` : `Lúc ${time}, ${meta.ok}/${meta.total} nguồn`;
}

/** Bấm "Kiểm tra ngay": quét nguồn thường và AI, rồi gộp giftcode AI vào hàng chờ chung. */
async function onCheck() {
  upd.check.disabled = true;
  upd.check.textContent = 'Đang cào AI...';
  try {
    const aiResult = await chrome.runtime.sendMessage({
      action: 'SCRAPE_GIFTCODES_TAVILY',
      gameName: 'Delta Force',
    })
      .then((value) => ({ status: 'fulfilled', value }))
      .catch((reason) => ({ status: 'rejected', reason }));
    const ai = aiResult.status === 'fulfilled' ? aiResult.value : null;

    if (ai?.status === 'success' && Array.isArray(ai.codes)) {
      try {
        const merged = await chrome.runtime.sendMessage({ type: 'CODES_AI_MERGE', codes: ai.codes });
        if (!merged?.ok) throw new Error(merged?.error || 'Không lưu được giftcode tìm từ AI.');
        const updatedList = await renderCategorizedCodes();
        if (merged.added > 0) {
          window.dfToast?.(`+${merged.added} code mới từ AI`, 'success', 2600);
        } else {
          window.dfToast?.('AI không tìm thấy code mới duy nhất; kho code hiện tại không thay đổi.', 'info', 3200);
        }
        console.debug(`[DF Popup] Kho code đã cập nhật: ${updatedList.length} mục.`);
      } catch (err) {
        window.dfToast?.(`Không thể gộp code AI vào kho: ${err.message}`, 'error', 3200);
      }
    } else if (ai?.status === 'error') {
      window.dfToast?.(ai.message || 'AI chưa tìm được code mới; hãy kiểm tra cấu hình và thử lại.', 'info', 3600);
    } else if (aiResult.status === 'rejected') {
      window.dfToast?.('Không kết nối được dịch vụ AI; sẽ tiếp tục kiểm tra nguồn thường.', 'info', 3000);
    }

    upd.check.textContent = 'Đang kiểm tra nguồn...';
    const scanResult = chrome.runtime.sendMessage({ type: 'CHECK_NOW' })
      .then((value) => ({ status: 'fulfilled', value }))
      .catch((reason) => ({ status: 'rejected', reason }));
    const scan = await scanResult;
    if (scan.status === 'rejected') {
      throw new Error(`Không kiểm tra được các nguồn code: ${scan.reason?.message || scan.reason}`);
    }
  } catch (err) {
    upd.meta.textContent = 'Không kiểm tra được';
    window.dfToast?.(err.message, 'error', 3200);
  } finally {
    upd.check.disabled = false;
    upd.check.textContent = 'Kiểm tra ngay';
  }
}

/** Bấm "Thêm ... code mới": đưa code mới lên ĐẦU ô danh sách rồi xoá khỏi hàng chờ */
async function onAddNew() {
  const pending = pendingCodes();
  if (pending.length === 0) return;

  const have = new Set(parseCodes(el.codes.value).map((c) => c.toLowerCase()));
  const toAdd = pending.filter((c) => !have.has(c.toLowerCase()));

  // Giữ nguyên nội dung cũ, chỉ chèn code mới lên trên cùng để được nhập trước
  el.codes.value = [...toAdd, el.codes.value.trim()].filter(Boolean).join('\n');
  el.codes.scrollTop = 0;
  saveDraft();

  // Chỉ bỏ đúng các code vừa lấy (background xử lý trong hàng đợi) - code mới tìm được giữa chừng không bị mất
  await askBackground({ type: 'CODES_PENDING_REMOVE', codes: newCodes });
  if (toAdd.length > 0) window.dfToast?.(`Đã thêm ${toAdd.length} code mới vào danh sách`, 'success');
  else window.dfToast?.('Các code này đã có trong danh sách', 'info');
}

/** Lưu cài đặt tự kiểm tra và báo background.js đặt lại bộ hẹn giờ */
async function saveSettings() {
  await chrome.storage.local.set({
    dfSettings: { auto: upd.auto.checked, intervalMin: Number(upd.interval.value) },
  });
  chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
  window.dfToast?.('Đã lưu cài đặt', 'success', 1600);
}

/** Khởi tạo khu vực cập nhật: đọc dữ liệu đã lưu và lắng nghe thay đổi */
async function initUpdates() {
  upd.check.addEventListener('click', onCheck);
  upd.addNew.addEventListener('click', onAddNew);
  upd.auto.addEventListener('change', saveSettings);
  upd.interval.addEventListener('change', saveSettings);

  const { dfNew = [], dfMeta = null, dfSettings } = await chrome.storage.local.get([
    'dfNew', 'dfMeta', 'dfSettings',
  ]);
  const settings = { auto: true, intervalMin: 10, ...(dfSettings || {}) }; // Phải trùng giá trị mặc định ở background.js
  upd.auto.checked = settings.auto;
  upd.interval.value = String(settings.intervalMin);

  newCodes = dfNew;
  updateNewUI();
  renderMeta(dfMeta);

  // Khi background.js tìm được code mới, popup đang mở sẽ tự cập nhật
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dfNew) {
      newCodes = changes.dfNew.newValue || [];
      updateNewUI();
    }
    if (changes.dfMeta) renderMeta(changes.dfMeta.newValue || null);
  });
}

/** Nhận thông báo real-time từ background khi content script quét pasif thấy code mới */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CODE_NEW_REALTIME' && Array.isArray(msg.codes) && msg.codes.length > 0) {
    const list = msg.codes.slice(0, 5).join(', ');
    const more = msg.codes.length > 5 ? ` +${msg.codes.length - 5} code` : '';
    window.dfToast?.(
      `Tìm thấy ${msg.codes.length} code mới${more} (${msg.site || 'trang web'})`,
      'success',
      3500
    );
    console.debug(`[DF Popup] CODE_NEW_REALTIME: ${msg.codes.length} codes from ${msg.site}`);
  }
  return false;
});

/* ------------------------------------------------------------------ */
/* Kho giftcode (dfCodes): Mới / Đã dùng / Hết hạn                      */
/* ------------------------------------------------------------------ */
/*
 * Popup chỉ ĐỌC kho trực tiếp từ chrome.storage.local (an toàn, không gây xung đột).
 * Mọi thay đổi (đổi trạng thái, xoá) đều gửi tin nhắn CODES_* cho background.js ghi,
 * sau đó storage.onChanged tự vẽ lại danh sách.
 */
const vault = {
  btn: $('btnVault'), badge: $('vaultBadge'), root: $('vault'), close: $('vaultClose'),
  tabs: document.querySelectorAll('#vault [data-tab]'),
  categoryTabs: document.querySelectorAll('#vault [data-category]'),
  list: $('vaultList'),
  copy: $('vaultCopy'), load: $('vaultLoad'), clear: $('vaultClear'),
};
const VAULT_MAX_ROWS = 300; // Chỉ vẽ tối đa ngần này dòng để popup luôn mượt
const CLEAR_LABEL = 'Xoá tất cả';
const STATUS_LABEL = { new: 'Mới', used: 'Đã dùng', expired: 'Hết hạn' };
const SOURCE_LABEL = { ai_search: 'AI search', scan: 'Tự tìm', page: 'Lưu từ trang', manual: 'Nhập tay', official: 'Chính thức' };

let registry = {};     // Bản sao kho đang hiển thị
let vaultTab = null;   // Trạng thái kho đang xem; null = mọi trạng thái
let vaultCategory = 'all';
let clearTimer = null; // Đang chờ bấm lần 2 để xoá
let categoryRenderId = 0;

/** Gửi lệnh cho background.js; lỗi (service worker đang khởi động...) thì trả về null */
function askBackground(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

const fmtTime = (ts) => new Date(ts).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Dựng một dòng code: [code + nguồn/thời gian] [chọn trạng thái] [xoá] */
function buildVaultRow(entry) {
  const li = document.createElement('li');
  li.dataset.code = entry.code;
  li.dataset.status = entry.state || entry.status;
  li.dataset.category = entry.category || 'PAGE_DOM';
  li.dataset.scraped = String(!!entry.isNew);

  const main = document.createElement('div');
  main.className = 'vc-main';
  const codeRow = document.createElement('div');
  codeRow.className = 'vc-code-row';
  const code = document.createElement('span');
  code.className = 'vc-code';
  code.textContent = entry.code;
  codeRow.append(code);
  const category = document.createElement('span');
  category.className = `vc-category vc-category--${String(entry.category || 'PAGE_DOM').toLowerCase()}`;
  category.textContent = entry.category === 'AI_SCRAPED' ? 'AI Scraped'
    : entry.category === 'OFFICIAL' ? 'Official' : 'DOM';
  category.title = entry.category === 'AI_SCRAPED' ? 'Được tìm thấy qua AI'
    : entry.category === 'OFFICIAL' ? 'Nguồn chính thức' : 'Trích xuất từ DOM trang';
  codeRow.append(category);
  if (entry.isNew) {
    const fresh = document.createElement('span');
    fresh.className = 'vc-new';
    fresh.textContent = 'AI mới';
    fresh.title = `Được tìm thấy ${fmtTime(entry.scrapedAt || entry.addedAt)}`;
    codeRow.append(fresh);
  }
  const meta = document.createElement('small');
  meta.className = 'vc-meta';
  meta.textContent = `${SOURCE_LABEL[entry.source] || 'Khác'}${entry.site ? ` · ${entry.site}` : ''} · ${fmtTime(entry.updatedAt)}`;
  meta.title = entry.note || '';
  main.append(codeRow, meta);

  const select = document.createElement('select');
  select.className = 'vc-status';
  select.setAttribute('aria-label', `Trạng thái của ${entry.code}`);
  for (const status of DfCodes.STATUSES) {
    const option = new Option(STATUS_LABEL[status], status, false, status === (entry.state || entry.status));
    select.append(option);
  }

  const del = document.createElement('button');
  del.className = 'vc-del';
  del.type = 'button';
  del.textContent = '✕';
  del.title = 'Xoá khỏi kho';
  del.setAttribute('aria-label', `Xoá ${entry.code}`);

  li.append(main, select, del);
  return li;
}

/** Vẽ lại huy hiệu, số đếm từng mục và (nếu đang mở) danh sách */
function renderVault() {
  const counts = DfCodes.counts(registry);
  const entries = Object.values(registry);
  $('vcCategoryAll').textContent = entries.length;
  $('vcCategoryAi').textContent = entries.filter((entry) => entry.category === 'AI_SCRAPED').length;
  $('vcCategoryActive').textContent = entries.filter((entry) => entry.status === 'ACTIVE').length;
  $('vcCategoryExpired').textContent = entries.filter((entry) => entry.status === 'EXPIRED').length;
  vault.badge.textContent = counts.new > 99 ? '99+' : String(counts.new);
  vault.badge.hidden = counts.new === 0;
  $('vcNew').textContent = counts.new;
  $('vcUsed').textContent = counts.used;
  $('vcExpired').textContent = counts.expired;
  vault.tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === (vaultTab || 'all'))));
  vault.categoryTabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.category === vaultCategory)));
  if (vault.root.hidden) return;

  const rows = filterVaultEntries();
  const items = rows.slice(0, VAULT_MAX_ROWS).map(buildVaultRow);
  if (rows.length === 0 || rows.length > VAULT_MAX_ROWS) {
    const note = document.createElement('li');
    note.className = 'vc-note';
    note.textContent = rows.length === 0 ? 'Chưa có code nào ở mục này.' : `Hiển thị ${VAULT_MAX_ROWS}/${rows.length} code mới cập nhật nhất.`;
    items[rows.length === 0 ? 'push' : 'unshift'](note);
  }
  vault.list.replaceChildren(...items);

  vault.copy.disabled = vault.clear.disabled = rows.length === 0;
  vault.load.disabled = rows.length === 0 || isRunning;
}

function disarmClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  vault.clear.textContent = CLEAR_LABEL;
}

function setVaultOpen(open) {
  vault.root.hidden = !open;
  disarmClear();
  if (open) { renderVault(); vault.close.focus(); } else { vault.btn.focus(); }
}

function setVaultTab(tab) {
  vaultTab = tab === 'all' ? null : tab;
  disarmClear();
  renderVault();
}

function setVaultCategory(category) {
  renderCategorizedCodes(category);
}

async function renderCategorizedCodes(filterType = vaultCategory) {
  const allowed = ['all', 'AI_SCRAPED', 'ACTIVE', 'EXPIRED'];
  if (!allowed.includes(filterType)) return;
  vaultCategory = filterType;
  disarmClear();
  const renderId = ++categoryRenderId;
  try {
    const stored = await chrome.storage.local.get(DfCodes.STORAGE_KEY);
    if (renderId !== categoryRenderId) return Object.values(registry);
    registry = DfCodes.migrateRegistry(stored[DfCodes.STORAGE_KEY] || {});
    renderVault();
    const updatedList = Object.values(registry);
    $('vcCategoryAll').textContent = String(updatedList.length);
    return updatedList;
  } catch (err) {
    window.dfToast?.(`Không tải được kho code: ${err.message}`, 'error');
    return [];
  }
}

function filterVaultEntries() {
  return DfCodes.list(registry, vaultTab).filter((entry) => {
    if (vaultCategory === 'all') return true;
    if (vaultCategory === 'AI_SCRAPED') return entry.category === 'AI_SCRAPED';
    return entry.status === vaultCategory;
  });
}

/** Sao chép toàn bộ code của mục đang xem (mỗi dòng một code) */
async function onVaultCopy() {
  const codes = filterVaultEntries().map((entry) => entry.code);
  try {
    await navigator.clipboard.writeText(codes.join('\n'));
    window.dfToast?.(`Đã sao chép ${codes.length} code (${STATUS_LABEL[vaultTab] || 'Tất cả'})`, 'success');
  } catch {
    window.dfToast?.('Không sao chép được, hãy thử lại', 'error');
  }
}

/** Đưa code của mục đang xem lên ĐẦU ô nhập (bỏ code đã có) để nhập lại */
function onVaultLoad() {
  const have = new Set(parseCodes(el.codes.value).map((c) => c.toLowerCase()));
  const toAdd = filterVaultEntries().map((entry) => entry.code).filter((c) => !have.has(c.toLowerCase()));
  if (toAdd.length === 0) {
    window.dfToast?.('Các code này đã có trong ô nhập', 'info');
    return;
  }
  el.codes.value = [...toAdd, el.codes.value.trim()].filter(Boolean).join('\n');
  el.codes.scrollTop = 0;
  saveDraft();
  setVaultOpen(false);
  window.dfToast?.(`Đã nạp ${toAdd.length} code vào ô nhập`, 'success');
}

/** Xoá toàn bộ mục đang xem: phải bấm 2 lần trong 3 giây để tránh xoá nhầm */
async function onVaultClear() {
  if (!clearTimer) {
    vault.clear.textContent = 'Bấm lần nữa để xoá';
    clearTimer = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  const codes = filterVaultEntries().map((entry) => entry.code);
  const res = await askBackground({ type: 'CODES_REMOVE', codes });
  if (res?.ok) window.dfToast?.(`Đã xoá ${res.removed} code`, 'success');
  else window.dfToast?.('Không xoá được, hãy thử lại', 'error');
}

/** Khởi tạo kho: gắn sự kiện, đọc dữ liệu và theo dõi thay đổi */
async function initVault() {
  vault.btn.addEventListener('click', () => setVaultOpen(true));
  vault.close.addEventListener('click', () => setVaultOpen(false));
  vault.root.addEventListener('click', (e) => { if (e.target === vault.root) setVaultOpen(false); }); // Bấm nền mờ để đóng
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !vault.root.hidden) setVaultOpen(false); });
  vault.tabs.forEach((tab) => tab.addEventListener('click', () => setVaultTab(tab.dataset.tab)));
  vault.categoryTabs.forEach((tab) => tab.addEventListener('click', () => setVaultCategory(tab.dataset.category)));
  vault.copy.addEventListener('click', onVaultCopy);
  vault.load.addEventListener('click', onVaultLoad);
  vault.clear.addEventListener('click', onVaultClear);

  // Đổi trạng thái / xoá từng dòng (event delegation)
  vault.list.addEventListener('change', async (e) => {
    const select = e.target.closest('.vc-status');
    if (!select) return;
    const res = await askBackground({ type: 'CODES_SET_STATUS', codes: [select.closest('li').dataset.code], status: select.value });
    if (res?.ok) window.dfToast?.(`Đã chuyển sang "${STATUS_LABEL[select.value]}"`, 'success', 1600);
    else window.dfToast?.('Không đổi được trạng thái', 'error');
  });
  vault.list.addEventListener('click', async (e) => {
    const del = e.target.closest('.vc-del');
    if (!del) return;
    await askBackground({ type: 'CODES_REMOVE', codes: [del.closest('li').dataset.code] });
  });

  const stored = await chrome.storage.local.get(DfCodes.STORAGE_KEY);
  registry = DfCodes.migrateRegistry(stored[DfCodes.STORAGE_KEY] || {});
  renderVault();

  // Background (hoặc content script) vừa ghi kho -> vẽ lại ngay
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[DfCodes.STORAGE_KEY]) return;
    registry = DfCodes.migrateRegistry(changes[DfCodes.STORAGE_KEY].newValue || {});
    updateNewUI();
    renderVault();
  });
}

/* ------------------------------------------------------------------ */
/* Sao lưu / khôi phục: Xuất & Nhập file JSON / CSV                     */
/* ------------------------------------------------------------------ */
/*
 * XUẤT : đọc kho "dfCodes" từ chrome.storage.local -> tạo chuỗi JSON/CSV -> Blob -> thẻ <a download>.
 *        Không cần quyền "downloads": file được lưu vào thư mục Tải xuống mặc định của Chrome.
 * NHẬP : <input type="file"> -> FileReader đọc chữ -> tự nhận JSON / CSV / danh sách chữ thường
 *        -> gửi CODES_IMPORT cho background.js, nơi duy nhất ghi kho, gộp theo quy tắc trong codes-store.js.
 * Dữ liệu từ file là dữ liệu KHÔNG TIN CẬY: chỉ dùng JSON.parse (không eval), mọi dòng đều được
 * kiểm tra lại (DfCodes.normalizeImported) và chỉ hiển thị bằng textContent.
 */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // File quá 2 MB bị từ chối
const MAX_IMPORT_ROWS = 5000;             // Đồng bộ với giới hạn ở background.js
const CSV_COLUMNS = ['code', 'category', 'status', 'state', 'source', 'site', 'addedAt', 'updatedAt', 'scrapedAt', 'note'];

const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
const pad2 = (n) => String(n).padStart(2, '0');

/** Tên file kiểu df-giftcode-backup-20261006-0914.json (giờ máy) */
function backupFilename(ext) {
  const d = new Date();
  return `df-giftcode-backup-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.${ext}`;
}

/** Tải một đoạn chữ xuống máy dưới dạng file (Blob + thẻ <a download>) */
function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // Giải phóng bộ nhớ sau khi trình duyệt đã nhận file
}

/* ---------- Xuất ---------- */

/** Một ô CSV: bao dấu nháy khi có , ; " hoặc xuống dòng. guard = chặn Excel hiểu nhầm ô là công thức (=, +, -, @) */
function csvCell(value, guard = false) {
  let text = value === null || value === undefined ? '' : String(value);
  if (guard && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",;\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Kho -> CSV (có BOM UTF-8 để Excel đọc đúng tiếng Việt, xuống dòng CRLF) */
function toCsv(rows) {
  const lines = rows.map((r) => [
    csvCell(r.code), csvCell(r.category), csvCell(r.status), csvCell(r.state),
    csvCell(r.source), csvCell(r.site, true), csvCell(iso(r.addedAt)),
    csvCell(iso(r.updatedAt)), csvCell(iso(r.scrapedAt)), csvCell(r.note, true),
  ].join(','));
  return `\uFEFF${[CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}

/** Kho -> JSON (có kèm thông tin sao lưu để dễ nhận biết file) */
function toJson(rows) {
  const counts = DfCodes.counts(Object.fromEntries(rows.map((r) => [r.code.toLowerCase(), r])));
  return JSON.stringify({
    app: 'df-giftcode-extension',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts,
    codes: rows.map((r) => ({ ...r, addedAt: iso(r.addedAt), updatedAt: iso(r.updatedAt) })),
  }, null, 2);
}

async function onExport() {
  // Đọc trực tiếp từ storage để chắc chắn là dữ liệu mới nhất
  const stored = await chrome.storage.local.get(DfCodes.STORAGE_KEY);
  const rows = DfCodes.list(stored[DfCodes.STORAGE_KEY] || {}).reverse(); // Cũ -> mới cho dễ đọc
  if (rows.length === 0) {
    window.dfToast?.('Kho đang trống, chưa có gì để xuất', 'info');
    return;
  }
  if ($('vaultFormat').value === 'csv') {
    downloadFile(backupFilename('csv'), toCsv(rows), 'text/csv');
  } else {
    downloadFile(backupFilename('json'), toJson(rows), 'application/json');
  }
  window.dfToast?.(`Đã xuất ${rows.length} code`, 'success');
}

/* ---------- Nhập ---------- */

/** Đọc file thành chữ bằng FileReader (bất đồng bộ, bọc Promise để dùng await) */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Không đọc được file'));
    reader.readAsText(file, 'utf-8');
  });
}

/** Tách CSV theo chuẩn RFC 4180: hỗ trợ ô có dấu nháy kép, dấu phẩy/xuống dòng trong ô; tự nhận , ; hoặc Tab */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false; // "" = một dấu nháy thật
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== '')); // Bỏ dòng trống
}

/** CSV -> danh sách dòng thô. Có dòng tiêu đề (cột "code") thì đọc theo tên cột, không có thì cột 1 = code, cột 2 = trạng thái */
function csvToEntries(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (!header.includes('code')) return rows.map((r) => ({ code: (r[0] || '').trim(), status: r[1] }));

  const unguard = (v) => (v === undefined ? v : v.replace(/^'(?=[=+\-@\t\r])/, '')); // Bỏ dấu ' do lúc xuất chặn công thức
  return rows.slice(1).map((r) => {
    const get = (name) => (header.includes(name) ? (r[header.indexOf(name)] ?? '').trim() : undefined);
    return {
      code: get('code'), category: get('category'), status: get('status'), state: get('state'),
      source: get('source'), site: unguard(get('site')), addedAt: get('addedat'),
      updatedAt: get('updatedat'), scrapedAt: get('scrapedat'), note: unguard(get('note')),
    };
  });
}

/** JSON -> danh sách dòng thô. Nhận: file xuất của extension, mảng object, mảng chuỗi, hoặc bản dump của "dfCodes" */
function jsonToEntries(text) {
  const data = JSON.parse(text); // Lỗi cú pháp sẽ ném ngoại lệ để onImport báo cho người dùng
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data?.codes)) list = data.codes;
  else if (data && typeof data === 'object') list = Object.values(data.dfCodes || data);
  return list.map((item) => (typeof item === 'string' ? { code: item } : item));
}

/** Tự nhận định dạng theo đuôi file / nội dung rồi trả về danh sách dòng thô (chưa kiểm tra hợp lệ) */
function parseImportFile(text, filename) {
  const clean = text.replace(/^\uFEFF/, '').trim(); // Bỏ BOM
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'json' || /^[[{]/.test(clean)) return jsonToEntries(clean);
  if (ext === 'csv') return csvToEntries(clean);
  // .txt hoặc không rõ: mỗi dòng một code (bỏ dòng chú thích bắt đầu bằng #)
  return parseCodes(clean.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n')).map((code) => ({ code }));
}

async function onImportFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    window.dfToast?.('File quá lớn (tối đa 2 MB)', 'error');
    return;
  }

  let entries;
  try {
    entries = parseImportFile(await readFileAsText(file), file.name);
  } catch {
    window.dfToast?.('File không đọc được hoặc sai định dạng JSON', 'error');
    return;
  }
  if (entries.length === 0) {
    window.dfToast?.('Không tìm thấy code nào trong file', 'error');
    return;
  }

  // Gửi cho background.js gộp vào kho (nơi duy nhất ghi kho, có hàng đợi chống ghi đè)
  const res = await askBackground({ type: 'CODES_IMPORT', entries: entries.slice(0, MAX_IMPORT_ROWS) });
  if (!res?.ok) {
    window.dfToast?.('Không nhập được, hãy thử lại', 'error');
    return;
  }
  const parts = [`+${res.added} mới`, `${res.updated} cập nhật`];
  if (res.invalid > 0) parts.push(`${res.invalid} dòng bỏ qua`);
  window.dfToast?.(`Nhập xong: ${parts.join(', ')}`, res.added + res.updated > 0 ? 'success' : 'info', 3200);
  // Kho thay đổi -> storage.onChanged ở initVault tự vẽ lại danh sách
}

function initBackup() {
  const fileInput = $('vaultFile');
  $('vaultExport').addEventListener('click', onExport);
  $('vaultImport').addEventListener('click', () => fileInput.click()); // Mở hộp chọn file
  fileInput.addEventListener('change', async () => {
    await onImportFile(fileInput.files[0]);
    fileInput.value = ''; // Cho phép chọn lại đúng file đó lần sau
  });
}

/* ------------------------------------------------------------------ */
/* Khởi tạo                                                            */
/* ------------------------------------------------------------------ */

async function init() {
  el.start.addEventListener('click', onStart);
  el.stop.addEventListener('click', onStop);
  el.codes.addEventListener('input', saveDraft);
  el.delay.addEventListener('input', saveDraft);

  // Khôi phục bản nháp
  const { dfDraft } = await chrome.storage.local.get('dfDraft');
  if (dfDraft) {
    el.codes.value = dfDraft.codes ?? '';
    el.delay.value = dfDraft.delay ?? '2.5';
  }
  updateCount();

  // Khu vực cập nhật code mới (độc lập với tab đang mở)
  await initUpdates();

  // Kho giftcode: Mới / Đã dùng / Hết hạn
  await initVault();
  initBackup(); // Nút Xuất / Nhập trong kho

  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  if (activeTabId == null) {
    render(null);
    return;
  }

  // Đọc trạng thái đã lưu của tab này
  const key = stateKey(activeTabId);
  const stored = await chrome.storage.local.get(key);
  let state = stored[key] || null;

  // Nếu state ghi "đang chạy" nhưng content script đã mất (trang bị tải lại) -> đánh dấu đã dừng
  if (state?.running && !(await ping(activeTabId))) {
    state = {
      ...state,
      running: false,
      level: 'warn',
      message: 'Trang đã được tải lại nên quá trình đã dừng.',
    };
    await chrome.storage.local.set({ [key]: state });
  }

  render(state);

  // Tự cập nhật giao diện mỗi khi content script ghi trạng thái mới
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[key]) render(changes[key].newValue || null);
  });
}

init();
