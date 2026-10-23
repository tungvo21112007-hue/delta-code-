/**
 * content.js - Content Script chạy trong trang đổi code
 *
 * Quy trình mỗi code:
 *   1. Tìm ô nhập code  ->  điền code  ->  phát sự kiện 'input' và 'change'
 *   2. Tìm nút "Đổi"/"Confirm"  ->  click()
 *   3. Chờ xem trang báo thành công hay thất bại (nếu nhận diện được)
 *   4. Chờ hết thời gian delay rồi sang code tiếp theo
 *
 * >>> Nếu trang web đổi giao diện, bạn chỉ cần sửa phần CONFIG bên dưới. <<<
 *
 * Ngoài ra file này còn có AUTO-SCAN: tự phát hiện giftcode trên các trang tổng hợp
 * và hiện nút nổi [Sao chép] / [Lưu nhanh] (xem khối "AUTO-SCAN" bên dưới).
 * Khối này chạy độc lập với phần nhập code, cấu hình riêng trong biến SCAN.
 */
(() => {
  'use strict';

  // Chống nạp trùng khi popup inject lại file này
  if (window.__dfGiftcodeLoaded) return;
  window.__dfGiftcodeLoaded = true;

  /* ================================================================ */
  /* CẤU HÌNH - SỬA Ở ĐÂY KHI TRANG WEB THAY ĐỔI                      */
  /* ================================================================ */
  const CONFIG = {
    // Các selector của ô nhập code, thử lần lượt từ trên xuống.
    // Trang đổi code thường có 2 ô (UID và CDK) nên các selector cụ thể
    // được đặt trước, input[type="text"] chung chung đặt cuối cùng.
    // Mẹo: chuột phải vào ô nhập > Inspect, rồi thêm selector chính xác lên ĐẦU danh sách.
    INPUT_SELECTORS: [
      'input[placeholder*="cdk" i]',
      'input[placeholder*="code" i]',
      'input[placeholder*="mã" i]',
      'input[name*="cdk" i]',
      'input[name*="code" i]',
      'input[id*="cdk" i]',
      'input[id*="code" i]',
      'input[class*="cdk" i]',
      'input[class*="code" i]',
      'input[type="text"]',
      'input:not([type])',
    ],

    // Bỏ qua ô nào có thuộc tính (placeholder, name, id, class...) khớp mẫu này (ô UID)
    INPUT_EXCLUDE_PATTERNS: [/(^|[^a-z])uid([^a-z]|$)/i, /user\s*id/i, /player\s*id/i],

    // Selector chính xác của nút gửi (để trống nếu chưa biết, code sẽ tìm theo chữ)
    // Ví dụ: ['button.redeem-btn']
    BUTTON_SELECTORS: [],

    // Chữ trên nút gửi (viết thường). Khớp chính xác trước, khớp một phần sau.
    BUTTON_TEXTS: ['đổi', 'confirm', 'xác nhận', 'redeem', 'exchange', 'submit'],

    // Nơi trang hiển thị thông báo kết quả (toast, popup, modal...)
    MESSAGE_SELECTORS: [
      '[role="alert"]',
      '[role="dialog"]',
      '[class*="toast" i]',
      '[class*="message" i]',
      '[class*="notice" i]',
      '[class*="tip" i]',
      '[class*="modal" i]',
      '[class*="dialog" i]',
      '[class*="popup" i]',
    ],

    // Từ khoá nhận diện kết quả (viết thường). Thất bại được kiểm tra trước.
    FAIL_KEYWORDS: [
      'thất bại', 'không hợp lệ', 'hết hạn', 'đã được sử dụng', 'đã sử dụng',
      'không tồn tại', 'không đúng', 'lỗi',
      'invalid', 'expired', 'already', 'failed', 'error', 'incorrect',
      'not exist', 'not found', 'try again',
    ],
    SUCCESS_KEYWORDS: [
      'thành công', 'đã nhận', 'chúc mừng',
      'success', 'redeemed', 'congratulations',
    ],

    RESULT_WAIT_MS: 2500,        // Chờ thông báo kết quả tối đa (không vượt quá delay)
    POLL_MS: 250,                // Chu kỳ kiểm tra thông báo
    BUTTON_ENABLE_WAIT_MS: 1500, // Chờ nút hết bị vô hiệu hoá (một số trang khoá nút khi ô trống)
    INPUT_SETTLE_MS: 200,        // Nghỉ ngắn sau khi điền để trang kịp cập nhật
  };

  /* ================================================================ */
  /* TRẠNG THÁI                                                       */
  /* ================================================================ */
  class FatalError extends Error {} // Lỗi nặng: dừng cả đợt (vd: không thấy ô nhập)

  // Chữ hiển thị cho từng loại kết quả
  const RESULT_TEXT = {
    success: 'Thành công',
    fail: 'Thất bại',
    unknown: 'Đã gửi, chưa rõ kết quả',
  };

  let running = false;
  let stopRequested = false;
  let stateKey = null;
  let state = null;

  /** Cập nhật state và lưu vào storage để popup đọc */
  function publish(patch = {}) {
    Object.assign(state, patch, { updatedAt: Date.now() });
    chrome.storage.local.set({ [stateKey]: state }).catch(() => {});
  }

  /* ================================================================ */
  /* TIỆN ÍCH CHUNG                                                   */
  /* ================================================================ */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Gửi dữ liệu về background để lưu vào kho giftcode (không bao giờ làm hỏng luồng chính) */
  function reportToRegistry(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* Extension vừa được cập nhật/tải lại: bỏ qua */
    }
  }

  /** Chờ ms mili giây nhưng thoát ngay khi người dùng bấm Dừng */
  async function waitWithStop(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopRequested) {
      await sleep(Math.min(100, end - Date.now()));
    }
  }

  /** Chờ đến khi condition() đúng hoặc hết thời gian. Trả về true/false */
  async function waitFor(condition, timeoutMs, intervalMs = 100) {
    const end = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= end) return false;
      await sleep(intervalMs);
    }
    return true;
  }

  const shorten = (text, max = 120) => (text.length > max ? `${text.slice(0, max)}...` : text);

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabled(el) {
    return (
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      /(^|[\s_-])disabled([\s_-]|$)/i.test(el.className || '')
    );
  }

  /* ================================================================ */
  /* TÌM PHẦN TỬ TRÊN TRANG                                           */
  /* ================================================================ */

  /** Ô nhập có phải ô UID (cần bỏ qua) không */
  function isExcludedInput(input) {
    const attrs = [
      input.placeholder,
      input.name,
      input.id,
      input.className,
      input.getAttribute('aria-label'),
    ].join(' ');
    return CONFIG.INPUT_EXCLUDE_PATTERNS.some((pattern) => pattern.test(attrs));
  }

  /** Tìm ô nhập code: thử từng selector, lấy ô đầu tiên hợp lệ */
  function findCodeInput() {
    const seen = new Set();
    for (const selector of CONFIG.INPUT_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue; // Selector sai cú pháp thì bỏ qua
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (!(node instanceof HTMLInputElement)) continue;
        if (node.disabled || node.readOnly || !isVisible(node)) continue;
        if (isExcludedInput(node)) continue;
        return node;
      }
    }
    return null;
  }

  /** Tìm nút gửi trong một phạm vi (một phần tử cha hoặc cả document) */
  function pickButton(scope) {
    // 1. Theo selector chính xác (nếu có cấu hình)
    for (const selector of CONFIG.BUTTON_SELECTORS) {
      const btn = [...scope.querySelectorAll(selector)].find(isVisible);
      if (btn) return btn;
    }

    // 2. Theo chữ hiển thị trên nút
    const candidates = [
      ...scope.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a, [role="button"], [class*="btn" i], [class*="button" i]'
      ),
    ].filter(isVisible);

    const textOf = (el) => (el.value || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const exact = candidates.find((el) => CONFIG.BUTTON_TEXTS.includes(textOf(el)));
    if (exact) return exact;

    return (
      candidates.find((el) => {
        const text = textOf(el);
        return text.length > 0 && text.length <= 20 && CONFIG.BUTTON_TEXTS.some((t) => text.includes(t));
      }) || null
    );
  }

  /** Tìm nút gần ô nhập nhất: tìm trong các phần tử cha, từ gần ra xa, cuối cùng là cả trang */
  function findSubmitButton(input) {
    let node = input.parentElement;
    for (let i = 0; node && i < 6; i += 1, node = node.parentElement) {
      const btn = pickButton(node);
      if (btn) return btn;
    }
    return pickButton(document);
  }

  /* ================================================================ */
  /* ĐIỀN CODE + NHẬN DIỆN KẾT QUẢ                                    */
  /* ================================================================ */

  /**
   * Điền giá trị vào ô nhập sao cho cả trang web thường lẫn React/Vue đều nhận được.
   * Gán trực tiếp input.value đôi khi bị React bỏ qua, nên dùng setter gốc của trình duyệt.
   */
  function fillInput(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();

    // Xoá nội dung cũ trước để chắc chắn sự kiện thay đổi được kích hoạt
    nativeSetter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Điền code mới và giả lập sự kiện 'input' + 'change'
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Danh sách chữ của tất cả thông báo đang hiển thị trên trang (không trùng) */
  function readPageMessages() {
    const texts = new Set();
    for (const selector of CONFIG.MESSAGE_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        // Bỏ qua khối quá lớn (thường là cả khung trang chứ không phải thông báo)
        if (text && text.length <= 300) texts.add(text);
      }
    }
    return [...texts];
  }

  /**
   * Sau khi bấm nút, chờ thông báo MỚI xuất hiện rồi phân loại thành công/thất bại.
   * Chỉ xét những thông báo chưa có trước khi bấm (so từng đoạn), để chữ cũ còn trên trang
   * (vd: dòng hướng dẫn có chữ "lỗi", hoặc lỗi của code trước) không làm sai kết quả của code này.
   */
  async function waitForResult(before, maxWaitMs) {
    const seenBefore = new Set(before);
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end && !stopRequested) {
      await sleep(CONFIG.POLL_MS);
      const fresh = readPageMessages().filter((text) => !seenBefore.has(text));
      if (fresh.length === 0) continue; // Chưa có thông báo mới

      const now = fresh.join(' | ');
      const lower = now.toLowerCase();
      if (CONFIG.FAIL_KEYWORDS.some((k) => lower.includes(k))) {
        return { status: 'fail', note: shorten(now) };
      }
      if (CONFIG.SUCCESS_KEYWORDS.some((k) => lower.includes(k))) {
        return { status: 'success', note: shorten(now) };
      }
    }
    return { status: 'unknown', note: 'Đã bấm nút nhưng chưa nhận diện được thông báo' };
  }

  /** Xử lý trọn vẹn MỘT code */
  async function redeemOne(code, delayMs) {
    const input = findCodeInput();
    if (!input) {
      throw new FatalError('Không tìm thấy ô nhập code. Hãy mở đúng trang đổi code hoặc sửa INPUT_SELECTORS trong content.js.');
    }

    fillInput(input, code);
    await sleep(CONFIG.INPUT_SETTLE_MS);

    const button = findSubmitButton(input);
    if (!button) {
      throw new FatalError('Không tìm thấy nút "Đổi". Hãy sửa BUTTON_SELECTORS hoặc BUTTON_TEXTS trong content.js.');
    }

    // Một số trang khoá nút cho đến khi ô nhập hợp lệ
    const enabled = await waitFor(() => !isDisabled(button), CONFIG.BUTTON_ENABLE_WAIT_MS);
    if (!enabled) return { status: 'fail', note: 'Nút gửi đang bị vô hiệu hoá' };

    const before = readPageMessages(); // Chụp thông báo hiện có để không nhầm với thông báo cũ
    button.click();

    return waitForResult(before, Math.min(CONFIG.RESULT_WAIT_MS, delayMs));
  }

  /* ================================================================ */
  /* VÒNG LẶP CHÍNH                                                   */
  /* ================================================================ */
  async function runBatch(tabId, codes, delaySec) {
    running = true;
    stopRequested = false;
    stateKey = `dfState_${tabId}`;

    const delayMs = Math.round(delaySec * 1000);
    const total = codes.length;

    state = { running: true, total, index: 0, results: [], message: 'Bắt đầu...', level: 'running' };
    publish();

    let fatalMessage = null;

    for (let i = 0; i < total; i += 1) {
      if (stopRequested) break;

      const code = codes[i];
      const startedAt = Date.now();
      publish({ index: i + 1, message: `Đang nhập code ${i + 1}/${total}...` });

      try {
        const result = await redeemOne(code, delayMs);
        state.results.push({ code, ...result });
      } catch (err) {
        if (err instanceof FatalError) {
          fatalMessage = err.message;
          break;
        }
        state.results.push({ code, status: 'fail', note: String(err?.message || err) });
      }

      const last = state.results[state.results.length - 1];
      // Báo kết quả cho background: tự phân loại Đã dùng / Hết hạn và lưu vào kho
      reportToRegistry({ type: 'CODES_RESULT', code, status: last.status, note: last.note });
      publish({ message: `Code ${i + 1}/${total}: ${RESULT_TEXT[last.status]}` });

      // Chờ phần delay còn lại (tính từ lúc bắt đầu code này), trừ code cuối cùng
      if (i < total - 1 && !stopRequested) {
        const remaining = Math.max(0, delayMs - (Date.now() - startedAt));
        await waitWithStop(remaining);
      }
    }

    // Tổng kết
    const count = (s) => state.results.filter((r) => r.status === s).length;
    const summary = `${count('success')} thành công, ${count('fail')} thất bại, ${count('unknown')} chưa rõ`;

    if (fatalMessage) {
      publish({ running: false, level: 'error', message: `Đã dừng: ${fatalMessage}` });
    } else if (stopRequested) {
      publish({ running: false, level: 'warn', message: `Đã dừng ở code ${state.results.length}/${total} (${summary}).` });
    } else {
      publish({ running: false, level: 'ok', message: `Hoàn tất ${total}/${total}: ${summary}.` });
    }

    running = false;
  }

  /* ================================================================ */
  /* AUTO-SCAN: TỰ PHÁT HIỆN GIFTCODE TRÊN TRANG + NÚT NỔI            */
  /* ================================================================ */
  /*
   * Cách hoạt động:
   *  1. Khi mở một trang nằm trong SCAN.HOSTS, script quét toàn bộ chữ trên trang
   *     bằng regex (chữ HOA + số, dài 6-12 ký tự) và lọc bớt chuỗi không phải code.
   *  2. Nếu tìm thấy, hiện một thanh nổi ở góc dưới bên phải: [N giftcode] [Sao chép] [Lưu nhanh].
   *     Bấm "N giftcode" để mở danh sách và sao chép / lưu từng code.
   *  3. "Lưu nhanh" đưa code lên ĐẦU danh sách trong popup (cùng nơi lưu bản nháp ô code),
   *     nên lần sau mở popup là thấy ngay, chỉ việc bấm START.
   *  4. Trang tải thêm nội dung (cuộn, tab, SPA...) sẽ được quét lại tự động (MutationObserver).
   *
   * Giao diện nổi nằm trong Shadow DOM nên CSS của trang web không làm hỏng nó
   * (và CSS của nó cũng không ảnh hưởng trang).
   */
  const SCAN = {
    // Chỉ quét trên các tên miền này (khớp chính xác hoặc là tên miền con).
    // Muốn quét MỌI trang: thêm '*' vào đây VÀ đổi "matches" trong manifest.json thành ["<all_urls>"].
    HOSTS: [
      'maytinhdaiviet.com', 'tomko.com.vn', 'mygear.com.vn', 'download.com.vn', 'trangmmo.com',
      'fpt.vn', 'cellphones.com.vn', 'fptshop.com.vn', 'thapdien.com', 'thethao247.vn', 'topuplive.com',
    ],

    // Mẫu regex nhận diện code. Mặc định: chữ HOA + số, dài 6-12 ký tự, đứng riêng thành một từ.
    // Nhiều code có chữ thường (vd: DFessence982); muốn nhận cả loại này, bỏ chú thích dòng thứ hai:
    PATTERNS: [
      /\b[A-Z0-9]{6,12}\b/g,
      // /\bDF[A-Za-z0-9]{4,12}\b/g,
    ],

    // Chế độ thông minh: dùng bộ đoán của extract.js (nhận theo tiền tố DF/PWC/MOILOOT..., chuỗi ngẫu nhiên dài, code lẫn chữ thường)
    // thay cho PATTERNS ở trên. Nhận được nhiều code thật hơn nhưng có thể lẫn vài chuỗi không phải code.
    // Cần extract.js được nạp trước content.js (đã khai báo trong manifest.json), nếu không sẽ tự quay về chế độ thường.
    SMART_MODE: false,

    REQUIRE_LETTER: true, // Phải có ít nhất 1 chữ cái (loại các số như ngày tháng 20260905)
    REQUIRE_DIGIT: true,  // Phải có ít nhất 1 chữ số (loại từ viết hoa như GARENA). Đặt false nếu muốn bắt cả code toàn chữ, vd: LAISEGAME

    // Các chuỗi chắc chắn không phải code (tên riêng, linh kiện, hệ điều hành...)
    STOPWORDS: new Set(['GIFTCODE', 'REDEEM', 'GARENA', 'DELTAFORCE', 'YOUTUBE', 'FACEBOOK', 'TIKTOK', 'TELEGRAM', 'WINDOWS', 'ANDROID']),
    IGNORE_RE: /^(RTX|GTX|GTS|IPHONE|WINDOWS|ANDROID|XBOX)\d+[A-Z]*$/, // vd: RTX4090, IPHONE15

    MAX_CODES: 200,        // Dừng quét khi đã gặp ngần này code (tránh trang quá nặng)
    MAX_TEXT_NODES: 20000, // Số đoạn chữ tối đa quét trong một lần
    DEBOUNCE_MS: 800,      // Chờ trang "yên" 0.8 giây sau mỗi thay đổi rồi mới quét lại
    MAX_KNOWN: 5000,       // Phải trùng giá trị MAX_KNOWN trong background.js

    ENABLE_KEY: 'dfScanEnabled', // Khoá storage bật/tắt tính năng (mặc định bật)
    HOST_ID: 'df-autoscan-host', // id của phần tử chứa giao diện nổi

    // Không đọc chữ bên trong các thẻ này
    SKIP_TAGS: new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'IFRAME', 'CANVAS']),
  };

  // CSS của giao diện nổi (nằm trong Shadow DOM). Màu theo giao diện Miku của popup.
  const SCAN_CSS = `
    :host { all: initial; }
    :host([hidden]) { display: none !important; }
    [hidden] { display: none !important; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 500 13px/1.35 system-ui, "Segoe UI", Roboto, sans-serif; color: #1b2433;
    }
    button { font: inherit; color: inherit; border: 0; background: transparent; cursor: pointer; }
    button:focus-visible { outline: 2px solid #12b8cf; outline-offset: 2px; }

    .bar {
      display: flex; align-items: stretch; overflow: hidden;
      background: #1b2433; color: #fff; border-radius: 999px;
      box-shadow: 0 8px 24px rgba(27, 36, 51, .32);
    }
    .bar button { padding: 9px 14px; font-weight: 600; white-space: nowrap; }
    .bar button:hover { background: rgba(255, 255, 255, .1); }
    .bar .count b {
      display: inline-block; min-width: 20px; margin-right: 6px; padding: 0 6px;
      border-radius: 999px; background: #67cdcc; color: #1b2433; text-align: center;
    }
    .bar .save { background: #67cdcc; color: #1b2433; }
    .bar .save:hover { background: #54c0bf; }

    .panel {
      width: 300px; max-height: 340px; display: flex; flex-direction: column; overflow: hidden;
      background: #fff; border: 1px solid #e3edf0; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(27, 36, 51, .2);
    }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 10px 12px; background: linear-gradient(135deg, #67cdcc, #a8e2e5);
    }
    .panel-head .link { padding: 2px 4px; font-size: 12px; text-decoration: underline; }
    .list { margin: 0; padding: 4px 0; list-style: none; overflow-y: auto; }
    .list li {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 6px 12px; border-top: 1px solid #e3edf0;
    }
    .list li:first-child { border-top: 0; }
    .list .code {
      font: 600 13px ui-monospace, Consolas, "Courier New", monospace;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .list .acts { display: flex; gap: 6px; flex: none; }
    .list .acts button {
      padding: 4px 10px; border-radius: 999px; background: #f1f7f8; font-size: 12px; font-weight: 600;
    }
    .list .acts button:hover:not(:disabled) { background: #a8e2e5; }
    .list .acts button:disabled { color: #3fa9a9; cursor: default; }

    .toast {
      display: flex; align-items: center; gap: 8px; padding: 8px 14px 8px 8px; border-radius: 999px;
      background: #1b2433; color: #fff; font-size: 12.5px; font-weight: 600;
      box-shadow: 0 8px 22px rgba(27, 36, 51, .35);
      animation: toast-in .24s cubic-bezier(.2, .9, .3, 1.15) both;
    }
    .toast.out { animation: toast-out .18s ease-in both; }
    .toast .ico {
      display: grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 50%;
      background: #67cdcc; color: #1b2433; font-size: 12px; font-weight: 800;
    }
    .toast.error .ico { background: #ff6f9d; }
    .toast.info .ico { background: #a8e2e5; }
    @keyframes toast-in  { from { opacity: 0; transform: translateY(12px) scale(.96); } to { opacity: 1; transform: none; } }
    @keyframes toast-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(8px) scale(.97); } }
    @media (prefers-reduced-motion: reduce) { .toast, .toast.out { animation-duration: .01s; } }
  `;

  const scan = {
    enabled: false,        // Tính năng đang bật?
    dismissed: false,      // Người dùng đã bấm "Ẩn trên trang này" (đến khi tải lại trang)
    codes: [],             // Code đang tìm thấy, theo thứ tự xuất hiện
    reported: new Set(),   // Code đã báo qua background (tránh báo trùng lặp)
    saved: new Set(),      // Code đã bấm "Lưu" trong lần mở trang này
    observer: null,        // MutationObserver theo dõi nội dung mới
    timer: null,           // Bộ hẹn giờ debounce cho lần quét kế tiếp
    toastTimer: null,      // Bộ hẹn giờ tự ẩn thông báo nhỏ
    ui: null,              // Tham chiếu các phần tử giao diện nổi
  };

  /* ---------- Phát hiện code ---------- */

  /** Trang hiện tại có nằm trong danh sách được phép quét không? */
  function scanHostAllowed() {
    if (window !== window.top) return false; // Không quét trong iframe
    const host = location.hostname.toLowerCase();
    return SCAN.HOSTS.some((h) => h === '*' || host === h || host.endsWith(`.${h}`));
  }

  /** Lọc bớt chuỗi khớp regex nhưng không giống giftcode */
  function isCandidate(code) {
    if (SCAN.STOPWORDS.has(code) || SCAN.IGNORE_RE.test(code)) return false;
    if (SCAN.REQUIRE_LETTER && !/[A-Za-z]/.test(code)) return false;
    if (SCAN.REQUIRE_DIGIT && !/\d/.test(code)) return false;
    return true;
  }

  /** Duyệt mọi đoạn chữ trên trang và trả về danh sách code (không trùng, giữ thứ tự) */
  function collectCodes() {
    const found = new Set();
    if (!document.body) return [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SCAN.SKIP_TAGS.has(parent.tagName.toUpperCase()) || parent.isContentEditable) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Chỉ dùng chế độ thông minh khi bật công tắc VÀ extract.js đã được nạp
    const smart = SCAN.SMART_MODE && typeof isLikelyCode === 'function';

    let visited = 0;
    while (walker.nextNode()) {
      if (++visited > SCAN.MAX_TEXT_NODES) break;
      const text = walker.currentNode.nodeValue;
      if (!text || text.length < 6) continue; // Ngắn hơn 6 ký tự thì không thể chứa code

      if (smart) {
        // Chế độ thông minh: tách từng từ rồi nhờ isLikelyCode() (extract.js) quyết định
        for (const token of text.split(/[^A-Za-z0-9_]+/)) {
          if (token && isLikelyCode(token)) found.add(token);
          if (found.size >= SCAN.MAX_CODES) return [...found];
        }
        continue;
      }

      for (const pattern of SCAN.PATTERNS) {
        for (const match of text.matchAll(pattern)) { // matchAll yêu cầu regex có cờ g
          if (isCandidate(match[0])) found.add(match[0]);
          if (found.size >= SCAN.MAX_CODES) return [...found];
        }
      }
    }
    return [...found];
  }

  /* ---------- Hành động: sao chép & lưu ---------- */

  /** Sao chép chữ vào clipboard (có phương án dự phòng cho trang không cho dùng Clipboard API) */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  /**
   * Lưu code vào danh sách của popup (bản nháp ô "Danh sách code"), code mới nằm trên cùng.
   * Đồng thời ghi vào "đã biết" để tính năng tìm code mới ở background không báo trùng.
   * Trả về { added, skipped }.
   */
  async function saveCodes(codes) {
    const { dfDraft = {}, dfKnown } = await chrome.storage.local.get(['dfDraft', 'dfKnown']);
    const current = String(dfDraft.codes || '');

    // Các code đã có trong danh sách (so sánh không phân biệt hoa/thường)
    const have = new Set(
      current.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean).map((c) => c.toLowerCase()),
    );
    const toAdd = codes.filter((c) => !have.has(c.toLowerCase()));

    if (toAdd.length > 0) {
      const patch = { dfDraft: { ...dfDraft, codes: [...toAdd, current.trim()].filter(Boolean).join('\n') } };

      if (Array.isArray(dfKnown)) {
        const knownLower = new Set(dfKnown.map((c) => c.toLowerCase()));
        const extra = toAdd.filter((c) => !knownLower.has(c.toLowerCase()));
        if (extra.length > 0) patch.dfKnown = [...dfKnown, ...extra].slice(-SCAN.MAX_KNOWN);
      }
      await chrome.storage.local.set(patch);
    }
    // Ghi tất cả code đã bấm Lưu vào kho (trạng thái Mới; code đã có thì giữ nguyên trạng thái cũ)
    reportToRegistry({ type: 'CODES_ADD', codes, source: 'page', site: location.hostname });
    return { added: toAdd.length, skipped: codes.length - toAdd.length };
  }

  /* ---------- Giao diện nổi (Floating Button) ---------- */

  /** Tạo phần tử HTML nhanh: h('button', { class: 'x', text: 'Chữ' }, ...con) */
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  const TOAST_ICON = { success: '✓', error: '!', info: 'i' };

  /** Hiện toast phía trên thanh nổi (type: success | error | info), tự ẩn sau ~2.5 giây */
  function showToast(message, type = 'success') {
    const { toast } = scan.ui;
    clearTimeout(scan.toastTimer);
    toast.className = `toast ${type}`;
    toast.replaceChildren(h('span', { class: 'ico', text: TOAST_ICON[type] || 'i' }), h('span', { text: message }));
    toast.style.animation = 'none'; void toast.offsetWidth; toast.style.animation = ''; // Chạy lại hiệu ứng khi bấm liên tiếp
    toast.hidden = false;
    scan.toastTimer = setTimeout(() => {
      toast.classList.add('out');
      scan.toastTimer = setTimeout(() => { toast.hidden = true; }, 180);
    }, 2300);
  }

  function setPanelOpen(open) {
    scan.ui.panel.hidden = !open;
    scan.ui.countBtn.setAttribute('aria-expanded', String(open));
  }

  /** Dựng khung giao diện một lần duy nhất */
  function ensureUI() {
    if (scan.ui) return scan.ui;

    const host = h('div', { id: SCAN.HOST_ID });
    const root = host.attachShadow({ mode: 'open' });

    const style = h('style', { text: SCAN_CSS });
    const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: '' });
    const list = h('ul', { class: 'list' });
    const panel = h(
      'section', { class: 'panel', 'aria-label': 'Giftcode tìm thấy', hidden: '' },
      h('header', { class: 'panel-head' },
        h('strong', { text: 'Giftcode tìm thấy' }),
        h('button', { class: 'link', 'data-act': 'hide', text: 'Ẩn trên trang này' })),
      list,
    );
    const countBtn = h('button', { class: 'count', 'data-act': 'toggle', 'aria-expanded': 'false' });
    const bar = h(
      'div', { class: 'bar' },
      countBtn,
      h('button', { class: 'copy', 'data-act': 'copy-all', text: 'Sao chép' }),
      h('button', { class: 'save', 'data-act': 'save-all', text: 'Lưu nhanh' }),
    );

    root.append(style, h('div', { class: 'wrap' }, toast, panel, bar));
    root.addEventListener('click', onScanUIClick);
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPanelOpen(false); });
    document.documentElement.appendChild(host);

    scan.ui = { host, toast, list, panel, countBtn, bar };
    return scan.ui;
  }

  /** Vẽ lại số lượng và danh sách code theo scan.codes */
  function renderScanUI() {
    if (scan.codes.length === 0) {
      if (scan.ui) { scan.ui.host.hidden = true; setPanelOpen(false); }
      return;
    }
    const { host, list, countBtn } = ensureUI();
    host.hidden = false;

    // Nút đếm: "[N] giftcode"
    countBtn.replaceChildren(h('b', { text: String(scan.codes.length) }), 'giftcode');

    // Mỗi dòng: code + nút Sao chép / Lưu (Lưu xong thì khoá và đổi chữ thành "Đã lưu")
    list.replaceChildren(...scan.codes.map((code) => {
      const saved = scan.saved.has(code);
      return h('li', {},
        h('span', { class: 'code', title: code, text: code }),
        h('span', { class: 'acts' },
          h('button', { 'data-act': 'copy', 'data-code': code, text: 'Sao chép' }),
          saved
            ? h('button', { disabled: '', text: 'Đã lưu' })
            : h('button', { 'data-act': 'save', 'data-code': code, text: 'Lưu' })));
    }));
  }

  /** Xử lý mọi cú bấm trong giao diện nổi (event delegation theo data-act) */
  async function onScanUIClick(event) {
    const button = event.target.closest('button[data-act]');
    if (!button) return;

    const act = button.dataset.act;
    const one = button.dataset.code ? [button.dataset.code] : null; // Có data-code = thao tác trên 1 code
    const codes = one || scan.codes;

    if (act === 'toggle') {
      setPanelOpen(scan.ui.panel.hidden);
    } else if (act === 'hide') {
      scan.dismissed = true;
      stopScan();
    } else if (act === 'copy' || act === 'copy-all') {
      const ok = await copyToClipboard(codes.join('\n'));
      showToast(ok ? `Đã sao chép ${codes.length} code` : 'Không sao chép được, hãy thử lại', ok ? 'success' : 'error');
    } else if (act === 'save' || act === 'save-all') {
      try {
        const { added, skipped } = await saveCodes(codes);
        codes.forEach((c) => scan.saved.add(c));
        renderScanUI();
        showToast(
          added === 0
            ? 'Các code này đã có trong danh sách'
            : `Đã lưu ${added} code${skipped ? `, ${skipped} code đã có` : ''}. Mở extension để nhập.`,
          added === 0 ? 'info' : 'success',
        );
      } catch {
        showToast('Không lưu được, hãy thử lại', 'error');
      }
    }
  }

  /* ---------- Điều khiển vòng đời quét ---------- */

  function runScan() {
    if (!scan.enabled || scan.dismissed) return;
    const codes = collectCodes();
    const same = codes.length === scan.codes.length && codes.every((c, i) => c === scan.codes[i]);
    if (same) return; // Không có gì thay đổi thì không vẽ lại

    // Tự động báo code mới chưa từng được báo qua background (passive real-time)
    const newlyFound = codes.filter((c) => !scan.reported.has(c));
    if (newlyFound.length > 0) {
      newlyFound.forEach((c) => scan.reported.add(c));
      reportToRegistry({
        type: 'CODES_FOUND_PASSIVE',
        codes: newlyFound,
        source: 'page',
        site: location.hostname,
        url: location.href,
      });
    }

    scan.codes = codes;
    renderScanUI();
  }

  function scheduleScan() {
    clearTimeout(scan.timer);
    scan.timer = setTimeout(runScan, SCAN.DEBOUNCE_MS);
  }

  function startScan() {
    if (scan.enabled || scan.dismissed || !document.body) return;
    scan.enabled = true;
    runScan();
    scan.observer = new MutationObserver(scheduleScan); // Quét lại khi trang thêm nội dung mới
    scan.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopScan() {
    scan.enabled = false;
    scan.codes = [];
    clearTimeout(scan.timer);
    clearTimeout(scan.toastTimer);
    if (scan.observer) { scan.observer.disconnect(); scan.observer = null; }
    if (scan.ui) { scan.ui.host.remove(); scan.ui = null; }
  }

  /** Điểm vào: kiểm tra tên miền + cài đặt bật/tắt, rồi bắt đầu quét */
  async function initAutoScan() {
    if (!scanHostAllowed()) return;

    const stored = await chrome.storage.local.get(SCAN.ENABLE_KEY);
    if (stored[SCAN.ENABLE_KEY] !== false) startScan(); // Mặc định bật

    // Bật/tắt từ popup có hiệu lực ngay, không cần tải lại trang
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SCAN.ENABLE_KEY]) return;
      if (changes[SCAN.ENABLE_KEY].newValue === false) stopScan();
      else startScan();
    });
  }

  /* ================================================================ */
  /* NHẬN LỆNH TỪ POPUP                                               */
  /* ================================================================ */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING':
        sendResponse({ ok: true });
        break;

      case 'START': {
        if (running) {
          sendResponse({ ok: false, error: 'Đang chạy rồi, hãy bấm "Dừng lại" trước.' });
          break;
        }
        const codes = Array.isArray(msg.codes) ? msg.codes.filter((c) => typeof c === 'string' && c) : [];
        if (codes.length === 0) {
          sendResponse({ ok: false, error: 'Danh sách code trống.' });
          break;
        }
        // Không await: để vòng lặp chạy nền, popup nhận phản hồi ngay
        runBatch(msg.tabId, codes, Number(msg.delaySec) || 2.5).catch((err) => {
          publish({ running: false, level: 'error', message: `Lỗi: ${err?.message || err}` });
          running = false;
        });
        sendResponse({ ok: true });
        break;
      }

      case 'STOP':
        stopRequested = true;
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
    // Phản hồi đồng bộ nên không cần giữ kênh message mở
    return false;
  });

  // Bật tính năng tự quét giftcode trên các trang tổng hợp (xem khối AUTO-SCAN ở trên)
  initAutoScan();
})();
