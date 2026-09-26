// Card checks for the test-mode hosted card page. Only brand, last 4 and expiry are ever kept.
'use strict';

function luhnValid(num) {
  const s = String(num).replace(/\D/g, '');
  if (s.length < 12) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = +s[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function cardBrand(num) {
  const s = String(num);
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(s)) return 'Mastercard';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(s)) return 'Discover';
  return 'Card';
}

// "08/29", "8/2029", "0829" → { label: "08/29", expired }
function parseExpiry(v, now = new Date()) {
  const m = String(v || '').trim().match(/^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]); let yy = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  if (yy < 100) yy += 2000;
  const expired = yy < now.getFullYear() || (yy === now.getFullYear() && mm < now.getMonth() + 1);
  return { label: `${String(mm).padStart(2, '0')}/${String(yy % 100).padStart(2, '0')}`, expired };
}

module.exports = { luhnValid, cardBrand, parseExpiry };
