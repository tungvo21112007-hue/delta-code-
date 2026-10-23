/**
 * extract.js - Tách giftcode ra khỏi nội dung một trang web
 *
 * File này được background.js nạp bằng importScripts, đồng thời có thể
 * chạy thử bằng Node (xem dòng module.exports ở cuối).
 *
 * Giftcode Delta Force không có quy tắc cố định, nên ở đây dùng cách đoán:
 *   1) Bắt đầu bằng một tiền tố quen thuộc (DF, PWC, MOILOOT...)  -> nhận
 *   2) Chuỗi ngẫu nhiên viết hoa + số, dài 12-24 ký tự            -> nhận
 *   3) Chuỗi ngẫu nhiên lẫn chữ hoa/thường, dài 16-24 ký tự       -> nhận
 * Còn lại (từ thường, tên riêng, số...) bị bỏ qua.
 * Nếu sau này code đổi kiểu đặt tên, hãy sửa CODE_PREFIXES hoặc isLikelyCode().
 */

// Tiền tố thường gặp của giftcode (phân biệt hoa/thường)
const CODE_PREFIXES = [
  'DF', 'PWC', 'POC', 'MOILOOT', 'GARENADF', 'HEDELTAFORCE', 'DELTAFORCEVN_',
  'TRILLIONRAID', 'ReturningWarrior', 'daichien', 'SIXMAJOR', 'ANIMALCUP', 'WELCOME', 'VIP',
];

/** Biến HTML thành chữ thường: bỏ script/style/thẻ HTML, giải mã vài ký tự đặc biệt */
function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')                       // Bỏ chú thích HTML
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ') // Bỏ khối script, style...
    .replace(/<[^>]+>/g, ' ')                               // Bỏ các thẻ HTML (cả class, id bên trong thẻ)
    .replace(/&nbsp;|&#160;/gi, ' ')                        // Khoảng trắng đặc biệt
    .replace(/&amp;/gi, '&')                                // Dấu &
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');                     // Các ký tự HTML còn lại
}

/** Một chuỗi có giống giftcode không? */
function isLikelyCode(t) {
  if (t.length < 7 || t.length > 32) return false;          // Quá ngắn hoặc quá dài
  if (!/^[A-Za-z0-9_]+$/.test(t)) return false;             // Chỉ chứa chữ, số, dấu gạch dưới
  if (/^\d+$/.test(t)) return false;                        // Toàn số -> không phải code
  if (/^6[A-Z0-9]{18,22}$/.test(t)) return false;           // Mã thiết lập súng (loadout), không phải giftcode

  // 1) Bắt đầu bằng tiền tố quen thuộc
  if (CODE_PREFIXES.some((p) => t.startsWith(p))) return true;

  // Các chuỗi chứa năm (2025, 2026...) thường là tiêu đề/tên bài, không phải code ngẫu nhiên
  if (/(19|20)\d\d/.test(t)) return false;

  const hasDigit = /\d/.test(t);
  const upper = (t.match(/[A-Z]/g) || []).length;
  const lower = (t.match(/[a-z]/g) || []).length;

  // 2) Chuỗi viết hoa + số, dài 12-24 ký tự (vd: A5Z1NDW8K3PJLU)
  if (/^[A-Z0-9]+$/.test(t) && hasDigit && t.length >= 12 && t.length <= 24) return true;

  // 3) Chuỗi ngẫu nhiên lẫn chữ hoa/thường, dài 16-24 ký tự (vd: N4SQWgxYcHw7gUci3bJy)
  if (/^[A-Za-z0-9]+$/.test(t) && t.length >= 16 && t.length <= 24 && upper >= 3 && lower >= 3) {
    if (/^[A-Z][a-z]+([A-Z][a-z]+)+\d*$/.test(t)) return false; // Dạng CamelCase của từ thật (vd: GiftcodeDeltaForce)
    return true;
  }

  return false;
}

/** Trả về danh sách giftcode (không trùng, giữ thứ tự xuất hiện) tìm thấy trong HTML */
function extractCodes(html) {
  const seen = new Set();
  const result = [];
  for (const token of htmlToText(html).split(/[^A-Za-z0-9_]+/)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (isLikelyCode(token)) result.push(token);
  }
  return result;
}

/**
 * Dòng "hết hạn" = dòng bảng/danh sách (<tr>, <li>) ngắn có chữ "hết hạn / hết hiệu lực / expired".
 * Cố tình chặt để KHÔNG loại nhầm code còn dùng được:
 *   - "hết hạn ngày 31/12", "sẽ hết hạn", "chưa hết hạn", "trước khi hết hạn" -> KHÔNG tính (đó là ngày hạn, không phải đã hết)
 *   - dòng dài (> 260 ký tự, thường là cả đoạn văn) -> bỏ qua
 */
const EXPIRED_WORD_RE = /hết\s+(?:hạn|hiệu\s+lực)(?!\s*(?:ngày|vào|lúc|sau|trước|từ|đến|\d))|\bexpired\b/i;
const NOT_EXPIRED_RE = /(?:chưa|sẽ|không|sắp|trước\s+khi|nếu)\s+(?:bị\s+)?hết|not\s+expired|before\s+expir|will\s+expire/i;
const EXPIRED_ROW_MAX = 260;

/**
 * Như extractCodes nhưng tách riêng các code nằm trong dòng đã báo hết hạn.
 * Trả về { codes: [còn dùng được/chưa rõ], expired: [trang ghi hết hạn] }
 */
function extractCodesDetailed(html) {
  const all = extractCodes(html);
  const expiredKeys = new Set();
  // Chỉ xét đúng phần nằm trong một <tr>...</tr> hoặc <li>...</li> (không lấy chữ rơi ngoài dòng, vd đoạn ghi chú sau bảng)
  for (const [row] of String(html).matchAll(/<(tr|li)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) {
    const text = htmlToText(row);
    if (text.length > EXPIRED_ROW_MAX || !EXPIRED_WORD_RE.test(text) || NOT_EXPIRED_RE.test(text)) continue;
    for (const token of text.split(/[^A-Za-z0-9_]+/)) {
      if (token && isLikelyCode(token)) expiredKeys.add(token);
    }
  }
  return {
    codes: all.filter((c) => !expiredKeys.has(c)),
    expired: all.filter((c) => expiredKeys.has(c)),
  };
}

// Cho phép chạy thử bằng Node; trong service worker thì biến module không tồn tại nên dòng này bị bỏ qua
if (typeof module !== 'undefined') module.exports = { extractCodes, extractCodesDetailed, isLikelyCode, htmlToText };
