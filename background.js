/**
 * background.js - Service worker: tự động tìm CODE MỚI
 *
 * Cách hoạt động ("realtime" ở đây là kiểm tra định kỳ):
 *  - Cứ mỗi N phút (mặc định 10), tải lại các trang tổng hợp code trong SOURCES.
 *  - Tách mọi chuỗi giống giftcode (extract.js) rồi so với: danh sách đã biết (baseline + dfKnown)
 *    VÀ toàn bộ kho dfCodes (code đã thử / đã dùng / hết hạn / đã lưu đều không được báo là "mới" nữa).
 *    Dòng bảng/danh sách mà trang ghi "hết hạn" thì ghi thẳng vào kho với trạng thái Hết hạn.
 *  - Code nào chưa từng thấy sẽ được lưu vào "dfNew", hiện số trên biểu tượng
 *    extension và (nếu bật) hiện thông báo của Chrome.
 *  - Bạn mở popup và bấm "Thêm ... code mới" để đưa chúng vào ô danh sách.
 *
 * Kho giftcode (khoá "dfCodes", xem codes-store.js): mọi code đã quét / lưu / nhập đều được ghi
 * ở đây kèm trạng thái Mới / Đã dùng / Hết hạn. background.js là NƠI DUY NHẤT ghi vào kho:
 * popup và content script chỉ gửi tin nhắn CODES_*, các lệnh được xếp hàng và chạy lần lượt
 * để hai nơi cùng ghi một lúc không đè mất dữ liệu của nhau.
 */
importScripts('extract.js', 'codes-store.js', 'ai-search.js'); // Nạp tiện ích giftcode và tìm kiếm AI

/* ==================== CẤU HÌNH ==================== */

// Các trang tổng hợp code để theo dõi.
// LƯU Ý: nếu thêm trang mới, phải thêm cả địa chỉ của nó vào "host_permissions" trong manifest.json.
const SOURCES = [
  { name: 'maytinhdaiviet.com', url: 'https://maytinhdaiviet.com/tong-hop-giftcode-delta-force-moi-nhat-2026-cap-nhat-lien-tuc/' },
  { name: 'tomko.com.vn', url: 'https://tomko.com.vn/code-delta-force.html' },
  { name: 'mygear.com.vn', url: 'https://mygear.com.vn/code-delta-force' },
  { name: 'download.com.vn', url: 'https://download.com.vn/code-game-delta-force-195638' },
  { name: 'trangmmo.com', url: 'https://trangmmo.com/threads/cach-tu-ong-oi-thuong-code-delta-force.296/' },
  { name: 'fpt.vn', url: 'https://fpt.vn/tin-tuc/code-delta-force-garena-moi-nhat-15350.html' },
  { name: 'cellphones.com.vn', url: 'https://cellphones.com.vn/sforum/code-delta-force-garena' },
  { name: 'fptshop.com.vn', url: 'https://fptshop.com.vn/tin-tuc/giai-tri/code-delta-force-184570' },
  { name: 'thapdien.com', url: 'https://thapdien.com/code-game-delta-force-garena-cach-nhap-gift-code-moi-nhat/' },
  { name: 'thethao247.vn', url: 'https://thethao247.vn/400-code-garena-delta-force-moi-nhat-va-cach-nhap-d378120.html' },
  { name: 'topuplive.com', url: 'https://www.topuplive.com/news/delta-force-redeem-code.html' },
];

const ALARM_NAME = 'dfCheckNewCodes';                  // Tên bộ hẹn giờ
const DEFAULT_SETTINGS = {
  auto: true,
  intervalMin: 10,                     // Mặc định fallback (phải luôn có)
  autoIntervalPeak: 5,                 // Giờ cao điểm: kiểm tra mỗi 5 phút
  autoIntervalOffpeak: 30,             // Giờ vắng khách: kiểm tra mỗi 30 phút
  peakStartHour: 18,                   // Bắt đầu khung cao điểm (giờ VN)
  peakEndHour: 22,                     // Kết thúc khung cao điểm (giờ VN)
}; // Mặc định: tự kiểm tra mỗi 10 phút, co giãn theo khung giờ
const FETCH_TIMEOUT_MS = 15000;                        // Mỗi trang chờ tối đa 15 giây
const MAX_KNOWN = 5000;                                // Giới hạn số code lưu để không phình bộ nhớ

let checking = null; // Lần kiểm tra đang chạy (tránh chạy chồng nhau)

/* ==================== CÀI ĐẶT & BỘ HẸN GIỜ ==================== */

async function getSettings() {
  const { dfSettings } = await chrome.storage.local.get('dfSettings');
  return { ...DEFAULT_SETTINGS, ...(dfSettings || {}) };
}

/** Đặt (hoặc huỷ) bộ hẹn giờ theo cài đặt hiện tại.
 *  Adaptive polling: giờ cao điểm (mặc định 18:00-22:00) kiểm tra thường xuyên hơn,
 *  giờ vắng khách kiểm tra thưa hơn để tiết kiệm băng thông và pin.
 */
async function setupAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (!settings.auto) return;

  const now = new Date();
  const hour = now.getHours();
  const start = Number(settings.peakStartHour) || 18;
  const end = Number(settings.peakEndHour) || 22;

  let minutes;
  if (hour >= start && hour < end) {
    minutes = Math.max(1, Number(settings.autoIntervalPeak) || 5);
  } else {
    minutes = Math.max(1, Number(settings.autoIntervalOffpeak) || 30);
  }

  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: minutes });
}

/** Hiện số code mới trên biểu tượng extension (để trống nếu không có) */
async function setBadge(count) {
  await chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 999)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#E3173E' });
}

/** Khôi phục huy hiệu sau khi mở lại trình duyệt (Chrome không giữ huy hiệu) */
async function restoreBadge() {
  const { dfNew = [] } = await chrome.storage.local.get('dfNew');
  await setBadge(dfNew.length);
}

/** Đặt lại popup theo chủ đề đã lưu (setPopup không được Chrome giữ sau khi khởi động lại) */
async function restoreTheme() {
  const { dfTheme } = await chrome.storage.local.get('dfTheme');
  await chrome.action.setPopup({ popup: dfTheme === 'dark' ? 'popup.dark.html' : 'popup.html' });
}

chrome.runtime.onInstalled.addListener(() => { setupAlarm(); restoreBadge(); restoreTheme(); migrateRegistry(); cleanupTabStates(); });
chrome.runtime.onStartup.addListener(() => { setupAlarm(); restoreBadge(); restoreTheme(); migrateRegistry(); cleanupTabStates(); });

/* ==================== DỌN TRẠNG THÁI CỦA CÁC TAB ĐÃ ĐÓNG ==================== */
// Mỗi tab từng chạy "START" để lại một khoá dfState_<tabId> trong storage; không dọn thì sẽ tích tụ mãi.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`dfState_${tabId}`).catch(() => {});
});

/** Xoá các khoá dfState_* còn sót của tab không còn tồn tại (tab đóng khi trình duyệt tắt, v.v.) */
async function cleanupTabStates() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((key) => key.startsWith('dfState_'));
  if (stale.length === 0) return;
  const open = new Set((await chrome.tabs.query({})).map((tab) => `dfState_${tab.id}`));
  const dead = stale.filter((key) => !open.has(key));
  if (dead.length > 0) await chrome.storage.local.remove(dead);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkSources(true); // Tự kiểm tra -> có thông báo nếu thấy code mới
});

/* ==================== KHO GIFTCODE (dfCodes) ==================== */

// Hàng đợi ghi kho: mỗi lần ghi = đọc -> sửa -> lưu, và các lần ghi chạy NỐI TIẾP nhau.
// (chrome.storage không có giao dịch; nếu hai nơi cùng đọc-sửa-lưu một lúc thì lần ghi sau sẽ đè lần trước.)
let registryQueue = Promise.resolve();

/** Chạy mutator(map) trên bản kho hiện tại rồi lưu lại. Trả về kết quả của mutator. */
function enqueue(task) {
  const run = registryQueue.then(task);
  registryQueue = run.catch(() => {}); // Một lần lỗi không làm hỏng cả hàng đợi
  return run;
}

function withRegistry(mutator) {
  return enqueue(async () => {
    const map = await readRegistry();
    const result = mutator(map);
    DfCodes.prune(map);
    await chrome.storage.local.set({ [DfCodes.STORAGE_KEY]: map });
    return result;
  });
}

async function readRegistry() {
  const stored = (await chrome.storage.local.get(DfCodes.STORAGE_KEY))[DfCodes.STORAGE_KEY];
  return DfCodes.migrateRegistry(stored && typeof stored === 'object' ? stored : {});
}

/** Code trong hàng chờ "mới" chỉ còn ý nghĩa khi chưa bị dùng / hết hạn. Lọc bỏ phần đã xử lý xong. */
const stillPending = (list, map) => list.filter((code) => {
  const entry = map[code.toLowerCase()];
  return !entry || entry.state === 'new';
});

/** Dọn hàng chờ dfNew (code đã dùng/hết hạn, hoặc popup vừa lấy đi) rồi cập nhật huy hiệu. Chạy trong hàng đợi. */
function pruneNewList(removeCodes = []) {
  return enqueue(async () => {
    const [{ dfNew = [] }, map] = await Promise.all([chrome.storage.local.get('dfNew'), readRegistry()]);
    const drop = new Set(removeCodes.map((c) => String(c).toLowerCase()));
    const next = stillPending(dfNew, map).filter((c) => !drop.has(c.toLowerCase()));
    if (next.length !== dfNew.length) await chrome.storage.local.set({ dfNew: next });
    await setBadge(next.length);
    return next.length;
  });
}

/** Lần đầu sau khi cập nhật: đưa các code đang chờ (dfNew) và code trong ô nhập (dfDraft) vào kho */
async function migrateRegistry() {
  const { dfCodesMigrated, dfNew = [], dfDraft } = await chrome.storage.local.get(['dfCodesMigrated', 'dfNew', 'dfDraft']);
  if (dfCodesMigrated) return;
  const drafted = String(dfDraft?.codes || '').split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  await withRegistry((map) => DfCodes.addEntries(map, [
    ...dfNew.map((code) => ({ code, source: 'scan' })),
    ...drafted.map((code) => ({ code, source: 'manual' })),
  ]));
  await chrome.storage.local.set({ dfCodesMigrated: true });
}

/** Xử lý các tin nhắn CODES_* (từ popup và content script). Luôn kiểm tra dữ liệu đầu vào. */
async function handleCodesMessage(msg) {
  const asCodes = (value) => (Array.isArray(value) ? value.filter((c) => typeof c === 'string').slice(0, 500) : []);

  switch (msg.type) {
    case 'CODES_ADD': { // Thêm code mới: { codes, source: 'scan'|'page'|'manual', site? }
      const entries = asCodes(msg.codes).map((code) => ({ code, source: msg.source, site: msg.site }));
      return { ok: true, ...(await withRegistry((map) => DfCodes.addEntries(map, entries))) };
    }
    case 'CODES_RESULT': { // Kết quả nhập một code: { code, status: 'success'|'fail'|'unknown', note }
      if (!['success', 'fail', 'unknown'].includes(msg.status)) return { ok: false, error: 'status không hợp lệ' };
      const status = await withRegistry((map) => DfCodes.recordResult(map, msg.code, msg.status, msg.note));
      if (status === 'used' || status === 'expired') pruneNewList().catch(() => {});
      return { ok: status !== null, status };
    }
    case 'CODES_SET_STATUS': { // Đổi tay trạng thái: { codes, status: 'new'|'used'|'expired' }
      if (!DfCodes.STATUSES.includes(msg.status)) return { ok: false, error: 'status không hợp lệ' };
      const changed = await withRegistry((map) => DfCodes.setStatus(map, asCodes(msg.codes), msg.status));
      if (msg.status !== 'new') pruneNewList().catch(() => {});
      return { ok: true, changed };
    }
    case 'CODES_IMPORT': { // Gộp dữ liệu đọc từ file: { entries: [{ code, status?, updatedAt?, ... }] } (tối đa 5000 dòng)
      const entries = Array.isArray(msg.entries) ? msg.entries.slice(0, 5000) : [];
      const merged = await withRegistry((map) => DfCodes.mergeEntries(map, entries));
      pruneNewList().catch(() => {});
      return { ok: true, ...merged };
    }
    case 'CODES_PENDING_REMOVE': { // Popup đã lấy các code này vào ô nhập: bỏ khỏi hàng chờ (chỉ đúng các code đó)
      return { ok: true, left: await pruneNewList(asCodes(msg.codes)) };
    }
    case 'CODES_REMOVE': { // Xoá khỏi kho: { codes }
      const removed = await withRegistry((map) => DfCodes.remove(map, asCodes(msg.codes)));
      return { ok: true, removed };
    }
    default:
      return { ok: false, error: 'Lệnh không hợp lệ' };
  }
}

/* ==================== TẢI TRANG & TÌM CODE MỚI ==================== */

/** Tải nội dung một trang, có giới hạn thời gian */
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 'no-cache' = luôn hỏi lại máy chủ nhưng dùng ETag/Last-Modified: trang không đổi thì chỉ tải về phản hồi 304 rất nhẹ
    const res = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).slice(0, 3000000); // Chỉ lấy tối đa ~3MB
  } finally {
    clearTimeout(timer);
  }
}

/** Danh sách code đã biết: lấy từ storage, lần đầu thì nạp từ baseline-codes.json */
let baselineCache = null;
async function loadBaseline() {
  if (!baselineCache) {
    const res = await fetch(chrome.runtime.getURL('baseline-codes.json'));
    baselineCache = await res.json();
  }
  return baselineCache;
}

/** Danh sách đã biết = baseline đóng gói sẵn + những gì đã thấy (dfKnown). Gộp MỖI lần để bản cập nhật extension có baseline mới là dùng được ngay. */
async function loadKnown() {
  const [{ dfKnown }, baseline] = await Promise.all([chrome.storage.local.get('dfKnown'), loadBaseline()]);
  return [...baseline, ...(Array.isArray(dfKnown) ? dfKnown : [])];
}

/** Kiểm tra tất cả nguồn một lần. notify = true thì hiện thông báo khi có code mới */
function checkSources(notify) {
  if (!checking) {
    checking = doCheck(notify).finally(() => { checking = null; });
  }
  return checking;
}

/** Gộp giftcode AI mới vào kho và hàng chờ giống các nguồn quét thông thường. */
async function mergeAiGiftcodes(codes) {
  const known = new Set((await loadKnown()).map((code) => code.toLowerCase()));
  const entries = (Array.isArray(codes) ? codes : []).flatMap((item) => {
    const entry = typeof item === 'string' ? { code: item, type: 'giftcode' } : item;
    return entry?.type === 'giftcode' && entry.status !== 'expired' && DfCodes.isValid(entry.code)
      ? [{ ...entry, code: entry.code.trim() }]
      : [];
  });

  const outcome = await enqueue(async () => {
    const [{ dfNew = [], dfKnown = [] }, map] = await Promise.all([
      chrome.storage.local.get(['dfNew', 'dfKnown']),
      readRegistry(),
    ]);
    const waiting = new Set(dfNew.map((code) => code.toLowerCase()));
    const seen = new Set();
    const fresh = entries.filter(({ code }) => {
      const key = code.toLowerCase();
      if (seen.has(key) || known.has(key) || waiting.has(key) || map[key]) return false;
      seen.add(key);
      return true;
    });

    const appended = DfCodes.appendScrapedCodes(map, fresh, Date.now());
    DfCodes.prune(map);

    const freshCodes = appended.codes;
    const newList = stillPending([...dfNew, ...freshCodes], map);
    const newKnown = [...new Set([...dfKnown, ...freshCodes])].slice(-MAX_KNOWN);
    await chrome.storage.local.set({
      [DfCodes.STORAGE_KEY]: map,
      dfKnown: newKnown,
      dfNew: newList,
    });
    return { added: freshCodes.length, newList };
  });

  await setBadge(outcome.newList.length);
  return { ok: true, added: outcome.added };
}

/**
 * Nhận mã mới từ content script quét pasif trên trang web.
 * Thêm vào dfNew (hàng chờ chưa xác nhận), cập nhật badge và phát real-time đến mọi tab/popup.
 */
async function handlePassiveFoundCodes(codes, site, source) {
  if (!Array.isArray(codes) || codes.length === 0) return { added: 0 };

  const now = Date.now();
  const [{ dfNew = [], dfKnown = [] }, map] = await Promise.all([
    chrome.storage.local.get(['dfNew', 'dfKnown']),
    readRegistry(),
  ]);

  const knownLower = new Set([...dfKnown, ...Object.keys(map)].map((c) => c.toLowerCase()));
  const waitingLower = new Set(dfNew.map((c) => c.toLowerCase()));
  const added = [];

  for (const code of codes) {
    const key = code.toLowerCase();
    if (knownLower.has(key) || waitingLower.has(key)) continue;
    dfNew.push(code);
    knownLower.add(key);
    waitingLower.add(key);
    added.push(code);
  }

  if (added.length > 0) {
    await chrome.storage.local.set({ dfNew });
    await setBadge(dfNew.length);

    // Phát real-time đến mọi tab và popup đang mở
    chrome.runtime.sendMessage({
      type: 'CODE_NEW_REALTIME',
      codes: added,
      source,
      site,
      count: dfNew.length,
    }).catch(() => {});
  }

  return { added: added.length, total: dfNew.length };
}

async function doCheck(notify) {
  const known = await loadKnown();
  const knownLower = new Set(known.map((c) => c.toLowerCase())); // So sánh không phân biệt hoa/thường để tránh trùng do trang viết hoa toàn bộ

  const found = new Map();   // chữ thường -> code gốc (còn dùng được / chưa rõ)
  const expired = new Map(); // chữ thường -> code gốc mà trang ghi là hết hạn
  const siteOf = new Map();  // chữ thường -> tên trang đầu tiên thấy code (để ghi vào kho)
  let okCount = 0;

  // Tải song song tất cả nguồn; nguồn nào lỗi thì bỏ qua, không ảnh hưởng nguồn khác
  await Promise.all(SOURCES.map(async (source) => {
    try {
      const html = await fetchText(source.url);
      const result = extractCodesDetailed(html);
      for (const [list, target] of [[result.codes, found], [result.expired, expired]]) {
        for (const code of list) {
          const key = code.toLowerCase();
          if (!target.has(key)) target.set(key, code);
          if (!siteOf.has(key)) siteOf.set(key, source.name);
        }
      }
      okCount += 1;
    } catch (err) {
      console.warn(`[DF] Không tải được ${source.name}:`, err.message);
    }
  }));

  // Một trang ghi hết hạn nhưng trang khác ghi còn dùng: tin trang ghi hết hạn (đỡ mất công thử)
  for (const key of expired.keys()) found.delete(key);

  const meta = { checkedAt: Date.now(), ok: okCount, total: SOURCES.length };

  // Mất mạng hoặc tất cả nguồn đều lỗi: chỉ ghi lại thời điểm kiểm tra
  if (okCount === 0) {
    await chrome.storage.local.set({ dfMeta: meta });
    return { success: false, fresh: 0, ...meta };
  }

  // Phần ghi chạy trong hàng đợi để không đua với popup / content script.
  // Code mới = có trên trang, chưa nằm trong danh sách đã biết VÀ chưa có trong kho (đã thử / dùng / hết hạn / lưu rồi).
  const outcome = await enqueue(async () => {
    const [{ dfNew = [] }, map] = await Promise.all([chrome.storage.local.get('dfNew'), readRegistry()]);

    const fresh = [...found.values()].filter((c) => !knownLower.has(c.toLowerCase()) && !map[c.toLowerCase()]);
    const freshExpired = [...expired.values()].filter((c) => !map[c.toLowerCase()]);

    DfCodes.addEntries(map, [
      ...fresh.map((code) => ({ code, source: 'scan', site: siteOf.get(code.toLowerCase()) })),
      ...freshExpired.map((code) => ({ code, source: 'scan', site: siteOf.get(code.toLowerCase()) })),
    ]);
    DfCodes.setStatus(map, freshExpired, 'expired'); // Trang ghi hết hạn -> vào kho luôn ở mục Hết hạn, không báo "mới"
    // Code đang chờ trong kho là "Mới" mà trang giờ ghi hết hạn -> chuyển sang Hết hạn
    DfCodes.setStatus(map, [...expired.values()].filter((c) => map[c.toLowerCase()]?.state === 'new' && map[c.toLowerCase()]?.source === 'scan'), 'expired');
    DfCodes.prune(map);

    const waiting = new Set(dfNew.map((c) => c.toLowerCase()));
    const newList = stillPending([...dfNew, ...fresh.filter((c) => !waiting.has(c.toLowerCase()))], map); // Không vào hàng chờ 2 lần, bỏ code đã dùng/hết hạn
    const newKnown = [...new Set([...(await chrome.storage.local.get('dfKnown')).dfKnown || [], ...fresh, ...freshExpired])].slice(-MAX_KNOWN);

    await chrome.storage.local.set({ [DfCodes.STORAGE_KEY]: map, dfKnown: newKnown, dfNew: newList, dfMeta: meta });
    return { fresh, newList };
  });

  await setBadge(outcome.newList.length);

  if (notify && outcome.fresh.length > 0) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Delta Force: có code mới',
      message: `Tìm thấy ${outcome.fresh.length} code mới: ${outcome.fresh.slice(0, 3).join(', ')}${outcome.fresh.length > 3 ? '...' : ''}`,
    });
  }

  return { success: true, fresh: outcome.fresh.length, ...meta };
}

/* ==================== NHẬN LỆNH TỪ POPUP ==================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'SCRAPE_GIFTCODES_TAVILY') {
    Promise.resolve()
      .then(() => DfAiSearch.scrapeGiftcodesWithTavily(msg.gameName || 'Delta Force'))
      .then((codes) => sendResponse({ status: 'success', codes }))
      .catch((err) => {
        console.error('[DF AI Search] Tavily scrape request failed:', err);
        sendResponse({ status: 'error', codes: [], message: String(err?.message || err) });
      });
    return true;
  }
  if (msg?.action === 'SCRAPE_AI_CODES' || msg?.type === 'SCRAPE_AI_CODES') {
    Promise.resolve()
      .then(() => DfAiSearch.scrapeGiftcodesFromAI(msg.query || msg.gameQuery))
      .then((codes) => sendResponse({ status: 'success', codes }))
      .catch((err) => {
        console.error('[DF AI Search] Scrape request failed:', err);
        sendResponse({ status: 'error', codes: [], message: String(err?.message || err) });
      });
    return true;
  }
  if (msg?.type === 'SEARCH_MULTI_SOURCE_CODE') {
    DfAiSearch.searchMultiSourceCode(msg.query)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'CHECK_NOW') {
    checkSources(false).then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Giữ kênh mở để trả lời bất đồng bộ
  }
  if (msg?.type === 'CODES_FOUND_PASSIVE') {
    handlePassiveFoundCodes(msg.codes, msg.site, msg.source).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, error: err.message })
    );
    return true;
  }
  if (msg?.type === 'SETTINGS_CHANGED') {
    setupAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'CODES_AI_MERGE') {
    mergeAiGiftcodes(msg.codes).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (typeof msg?.type === 'string' && msg.type.startsWith('CODES_')) {
    handleCodesMessage(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // Trả lời bất đồng bộ
  }
  return false;
});
