/**
 * codes-store.js - Kho giftcode: lưu trữ + phân loại trạng thái (Mới / Đã dùng / Hết hạn)
 *
 * Dùng chung ở 2 nơi (cùng một file, không cần bundler - chuẩn Manifest V3):
 *   - background.js : importScripts('codes-store.js')  -> NƠI DUY NHẤT GHI vào kho
 *   - popup.html    : <script src="codes-store.js">     -> chỉ ĐỌC / lọc / đếm để hiển thị
 *
 * ---------- Cách lưu trong chrome.storage.local ----------
 * Khoá  "dfCodes"  = một object, mỗi giftcode một mục, khoá là code viết thường:
 *   {
 *     "dfessence982": {
 *       code:      "DFessence982",   // dạng gốc để hiển thị
 *       category:  "AI_SCRAPED",     // AI_SCRAPED | PAGE_DOM | OFFICIAL
 *       status:    "UNVERIFIED",     // ACTIVE | EXPIRED | UNVERIFIED (verification result)
 *       state:     "new",            // Existing vault workflow: new | used | expired
 *       source:    "ai_search",      // ai_search (AI) | scan (tự tìm) | page (Lưu nhanh) | manual (nhập tay)
 *       site:      "tomko.com.vn",   // trang phát hiện (nếu có)
 *       addedAt:   1760000000000,    // lúc thêm vào kho
 *       updatedAt: 1760000500000,    // lần đổi trạng thái / có kết quả gần nhất
 *       note:      "Code đã hết hạn" // thông báo gần nhất của trang khi thử nhập (cắt ngắn)
 *     }
 *   }
 * Gom tất cả vào MỘT khoá để mỗi lần đọc/ghi chỉ tốn 1 lệnh storage.
 * Giới hạn MAX_ENTRIES mục: vượt quá thì xoá bớt mục cũ nhất, ưu tiên Hết hạn -> Đã dùng -> Mới.
 *
 * ---------- Quy tắc phân loại tự động khi nhập code (xem classifyResult) ----------
 *   Nhập thành công                       -> "used"    (code đã bị bạn dùng)
 *   Trang báo "đã được sử dụng"/"already" -> "used"
 *   Trang báo "hết hạn"/"expired"         -> "expired"
 *   Lỗi khác (sai code, nút bị khoá...)   -> GIỮ NGUYÊN trạng thái, chỉ cập nhật "note"
 *   Code mới được thêm luôn bắt đầu là    -> "new"
 * Trạng thái không bao giờ bị tự hạ về "new"; muốn đổi tay thì dùng Kho code trong popup.
 *
 * ---------- Nhập (import) dữ liệu từ file: quy tắc GỘP (xem mergeEntries) ----------
 *   Code chưa có trong kho            -> thêm vào (giữ trạng thái/thời gian trong file nếu có)
 *   Code đã có + file có "updatedAt"   -> bản nào cập nhật SAU hơn thì thắng (trạng thái + ghi chú)
 *   Code đã có + file KHÔNG có thời gian (vd: danh sách chữ thường) -> giữ nguyên kho, không bị reset về "new"
 *   addedAt luôn lấy mốc sớm nhất; site chỉ được điền nếu kho đang để trống.
 */
const DfCodes = (() => {
  'use strict';

  const STORAGE_KEY = 'dfCodes';
  const STATUSES = ['new', 'used', 'expired'];
  const VERIFICATION_STATUSES = ['ACTIVE', 'EXPIRED', 'UNVERIFIED'];
  const CATEGORIES = ['AI_SCRAPED', 'PAGE_DOM', 'OFFICIAL'];
  const SOURCES = ['ai_search', 'scan', 'page', 'manual', 'official'];
  const MAX_ENTRIES = 3000;
  const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/; // Chỉ nhận chuỗi giống code, tránh ghi dữ liệu rác vào kho

  // Từ khoá trong thông báo của trang (không phân biệt hoa/thường). Hết hạn được kiểm tra trước.
  const EXPIRED_RE = /hết hạn|hết hiệu lực|expired|expire/i;
  const USED_RE = /đã (được )?sử dụng|đã dùng|đã nhận|already (been )?(used|redeemed|claimed)|has been (used|redeemed)/i;

  const keyOf = (code) => code.toLowerCase();
  const isValid = (code) => typeof code === 'string' && CODE_RE.test(code);

  function categorizeCode(codeObj = {}) {
    const source = String(codeObj.source || '').toLowerCase();
    const category = CATEGORIES.includes(codeObj.category)
      ? codeObj.category
      : source === 'official' ? 'OFFICIAL'
        : source === 'ai_search' ? 'AI_SCRAPED' : 'PAGE_DOM';
    const result = String(codeObj.resultStatus || codeObj.verificationResult || '').toLowerCase();
    const note = String(codeObj.note || '');
    const legacyStatus = String(codeObj.state || (STATUSES.includes(codeObj.status) ? codeObj.status : '')).toLowerCase();
    let status = VERIFICATION_STATUSES.includes(codeObj.status) ? codeObj.status : 'UNVERIFIED';

    if (legacyStatus === 'expired' || result === 'expired' || /hết hạn|hết hiệu lực|expired/i.test(note)) {
      status = 'EXPIRED';
    } else if (result === 'success' || codeObj.verified === true) {
      status = 'ACTIVE';
    } else if (typeof codeObj.confidence === 'number' && Number.isFinite(codeObj.confidence)) {
      status = codeObj.confidence >= 0.8 ? 'ACTIVE' : 'UNVERIFIED';
    } else if (legacyStatus === 'used') {
      status = 'ACTIVE';
    }

    return {
      ...codeObj,
      category,
      status,
      scrapedAt: Number.isFinite(codeObj.scrapedAt)
        ? codeObj.scrapedAt
        : category === 'AI_SCRAPED' && Number.isFinite(codeObj.addedAt) ? codeObj.addedAt : null,
    };
  }

  function legacyState(entry) {
    if (STATUSES.includes(entry?.state)) return entry.state;
    if (STATUSES.includes(entry?.status)) return entry.status;
    if (entry?.status === 'EXPIRED') return 'expired';
    if (entry?.status === 'ACTIVE') return 'used';
    return 'new';
  }

  /** Add schema fields to legacy entries while preserving vault state and existing metadata. */
  function migrateRegistry(map) {
    for (const [key, entry] of Object.entries(map || {})) {
      if (!entry || typeof entry !== 'object' || typeof entry.code !== 'string') continue;
      const state = legacyState(entry);
      Object.assign(entry, categorizeCode({ ...entry, state }));
      entry.state = state;
    }
    return map;
  }

  /**
   * Từ kết quả nhập code (status: success | fail | unknown) + nội dung thông báo của trang
   * suy ra trạng thái mới của code. Trả về null nếu không đủ căn cứ (giữ nguyên trạng thái).
   */
  function classifyResult(status, note) {
    if (status === 'success') return 'used';
    if (status === 'fail') {
      const text = String(note || '');
      if (EXPIRED_RE.test(text)) return 'expired';
      if (USED_RE.test(text)) return 'used';
    }
    return null;
  }

  /** Thêm code mới (trạng thái "new"). Code đã có trong kho thì bỏ qua, không bao giờ ghi đè. */
  function addEntries(map, entries, now = Date.now()) {
    let added = 0;
    let existing = 0;
    for (const entry of entries) {
      const code = typeof entry?.code === 'string' ? entry.code.trim() : '';
      if (!isValid(code)) continue;
      const key = keyOf(code);
      const category = categorizeCode({ ...entry, source: entry.source }).category;
      if (map[key]) {
        map[key].category = category;
        existing += 1;
        continue;
      }
      map[key] = categorizeCode({
        code,
        status: 'UNVERIFIED',
        state: 'new',
        source: SOURCES.includes(entry.source) ? entry.source : 'manual',
        category,
        site: entry.site ? String(entry.site).slice(0, 60) : '',
        addedAt: now,
        updatedAt: now,
        note: '',
      });
      map[key].state = 'new';
      added += 1;
    }
    return { added, existing };
  }

  /** Gộp các code vừa được scraper tìm thấy vào kho; caller lưu map qua hàng đợi của background. */
  function appendScrapedCodes(map, newCodes, now = Date.now()) {
    console.log("Raw Scraped Codes:", newCodes);
    const result = { added: 0, existing: 0, codes: [] };
    const seen = new Set();
    for (const raw of Array.isArray(newCodes) ? newCodes : []) {
      const code = typeof raw === 'string' ? raw.trim() : String(raw?.code || '').trim();
      if (!isValid(code)) continue;
      const key = keyOf(code);
      if (seen.has(key)) {
        result.existing += 1;
        continue;
      }
      seen.add(key);
      if (map[key]) {
        map[key].category = 'AI_SCRAPED';
        result.existing += 1;
        continue;
      }
      map[key] = categorizeCode({
        code,
        status: 'UNVERIFIED',
        state: 'new',
        source: 'ai_search',
        category: 'AI_SCRAPED',
        site: raw && typeof raw === 'object' && raw.site ? String(raw.site).slice(0, 60) : '',
        addedAt: now,
        updatedAt: now,
        scrapedAt: now,
        isNew: true,
        confidence: raw && typeof raw === 'object' && Number.isFinite(raw.confidence) ? raw.confidence : undefined,
        verified: raw && typeof raw === 'object' && raw.verified === true,
        note: 'Tìm thấy qua AI search',
      });
      map[key].state = 'new';
      result.added += 1;
      result.codes.push(code);
    }
    return result;
  }

  /** Ghi nhận kết quả nhập một code: tự phân loại + lưu thông báo. Code chưa có trong kho sẽ được tạo. */
  function recordResult(map, code, resultStatus, note, now = Date.now()) {
    if (!isValid(code)) return null;
    addEntries(map, [{ code, source: 'manual' }], now); // Không làm gì nếu đã có
    const entry = map[keyOf(code)];
    const next = classifyResult(resultStatus, note);
    if (next) entry.state = next;
    Object.assign(entry, categorizeCode({ ...entry, state: entry.state, resultStatus, note }));
    entry.isNew = false;
    entry.note = String(note || '').slice(0, 160);
    entry.updatedAt = now;
    return entry.state;
  }

  /** Đổi tay trạng thái cho nhiều code. Trả về số code đã đổi. */
  function setStatus(map, codes, status, now = Date.now()) {
    if (!STATUSES.includes(status)) return 0;
    let changed = 0;
    for (const code of codes) {
      const entry = typeof code === 'string' ? map[keyOf(code)] : null;
      if (!entry || legacyState(entry) === status) continue;
      entry.state = status;
      entry.status = status === 'expired' ? 'EXPIRED' : status === 'used' ? 'ACTIVE' : 'UNVERIFIED';
      entry.isNew = false;
      entry.updatedAt = now;
      changed += 1;
    }
    return changed;
  }

  /** Xoá code khỏi kho. Trả về số mục đã xoá. */
  function remove(map, codes) {
    let removed = 0;
    for (const code of codes) {
      const key = typeof code === 'string' ? keyOf(code) : '';
      if (key && map[key]) { delete map[key]; removed += 1; }
    }
    return removed;
  }

  // Tên trạng thái người dùng có thể gõ trong file CSV (kể cả nhãn tiếng Việt) -> giá trị chuẩn
  const STATUS_ALIASES = {
    new: 'new', 'mới': 'new', moi: 'new',
    used: 'used', 'đã dùng': 'used', 'da dung': 'used', 'đã sử dụng': 'used', 'da su dung': 'used',
    expired: 'expired', 'hết hạn': 'expired', 'het han': 'expired',
  };
  const parseStatus = (value) => STATUS_ALIASES[String(value ?? '').trim().toLowerCase()] || null;

  /** Đọc thời gian từ file: số (mili-giây hoặc giây) hoặc chuỗi ngày (ISO...). Không đọc được -> null */
  function parseTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (Number.isFinite(n) && n > 1e9) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
  }

  /** Làm sạch một dòng dữ liệu đọc từ file (không tin dữ liệu bên ngoài). Sai định dạng -> null */
  function normalizeImported(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const code = typeof raw.code === 'string' ? raw.code.trim() : '';
    if (!isValid(code)) return null;
    const state = parseStatus(raw.state) || parseStatus(raw.status) || 'new';
    return categorizeCode({
      code,
      status: VERIFICATION_STATUSES.includes(raw.status) ? raw.status : 'UNVERIFIED',
      state,
      source: SOURCES.includes(raw.source) ? raw.source : 'manual',
      category: raw.category,
      site: raw.site ? String(raw.site).slice(0, 60) : '',
      addedAt: parseTime(raw.addedAt),     // null = file không có thông tin này
      updatedAt: parseTime(raw.updatedAt),
      scrapedAt: parseTime(raw.scrapedAt),
      confidence: Number.isFinite(raw.confidence) ? raw.confidence : undefined,
      verified: raw.verified === true,
      note: String(raw.note || '').slice(0, 160),
    });
  }

  /** Gộp dữ liệu nhập từ file vào kho (quy tắc ở đầu file). Trả về { added, updated, unchanged, invalid } */
  function mergeEntries(map, entries, now = Date.now()) {
    const result = { added: 0, updated: 0, unchanged: 0, invalid: 0 };
    for (const raw of entries) {
      const entry = normalizeImported(raw);
      if (!entry) { result.invalid += 1; continue; }

      const key = keyOf(entry.code);
      const current = map[key];

      if (!current) { // Code mới hoàn toàn -> thêm
        const addedAt = entry.addedAt ?? now;
        map[key] = { ...entry, addedAt, updatedAt: entry.updatedAt ?? addedAt };
        result.added += 1;
        continue;
      }

      // Code đã có -> bản cập nhật sau hơn thì thắng
      let changed = false;
      if (entry.updatedAt !== null && entry.updatedAt > current.updatedAt) {
        changed = legacyState(current) !== entry.state || current.status !== entry.status;
        current.state = entry.state;
        current.status = entry.status;
        current.updatedAt = entry.updatedAt;
        if (entry.note) current.note = entry.note;
      }
      if (entry.addedAt !== null && entry.addedAt < current.addedAt) current.addedAt = entry.addedAt;
      if (!current.site && entry.site) current.site = entry.site;
      current.category = entry.category;
      if (entry.scrapedAt) current.scrapedAt = entry.scrapedAt;
      if (changed) result.updated += 1; else result.unchanged += 1;
    }
    return result;
  }

  /** Giữ kho không vượt MAX_ENTRIES: bỏ mục cũ nhất, Hết hạn trước, rồi Đã dùng, cuối cùng mới tới Mới */
  function prune(map) {
    const keys = Object.keys(map);
    if (keys.length <= MAX_ENTRIES) return 0;
    const rank = { expired: 0, used: 1, new: 2 };
    keys.sort((a, b) => (rank[legacyState(map[a])] - rank[legacyState(map[b])]) || (map[a].updatedAt - map[b].updatedAt));
    const drop = keys.slice(0, keys.length - MAX_ENTRIES);
    drop.forEach((key) => delete map[key]);
    return drop.length;
  }

  /** Đếm số code theo từng trạng thái */
  function counts(map) {
    const result = { new: 0, used: 0, expired: 0 };
    for (const entry of Object.values(map || {})) {
      const state = legacyState(entry);
      if (result[state] !== undefined) result[state] += 1;
    }
    return result;
  }

  /** Danh sách code theo trạng thái (null = tất cả), mới cập nhật nhất lên đầu */
  function list(map, status = null) {
    return Object.values(map || {})
      .filter((entry) => !status || legacyState(entry) === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return {
    STORAGE_KEY,
    STATUSES,
    VERIFICATION_STATUSES,
    CATEGORIES,
    SOURCES,
    isValid,
    classifyResult,
    categorizeCode,
    migrateRegistry,
    addEntries,
    appendScrapedCodes,
    recordResult,
    setStatus,
    remove,
    prune,
    counts,
    list,
    mergeEntries,
  };
})();

// Cho phép chạy thử bằng Node; trong trình duyệt biến module không tồn tại nên dòng này bị bỏ qua
if (typeof module !== 'undefined') module.exports = DfCodes;
