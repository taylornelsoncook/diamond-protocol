// Formatting and units for test results (browser). Mirrors server/services/testing-core.js.
// fmtValue(77,'in') → 6′ 5″ · fmtValue(5.9,'s') → 5.90 s · fmtChange(-0.19,'s') → -0.19 s

const FACTORS = { in: ['len', 2.54], cm: ['len', 1], m: ['len', 100], ft: ['len', 30.48], lb: ['mass', 0.45359237], kg: ['mass', 1] };
const CHOICES = { in: ['in', 'cm'], cm: ['cm', 'in'], ft: ['ft', 'm'], m: ['m', 'ft'], lb: ['lb', 'kg'], kg: ['kg', 'lb'] };
export const unitsFor = (unit) => CHOICES[unit] || [unit];
export function convert(v, from, to) {
  if (from === to || v == null) return v;
  const a = FACTORS[from], b = FACTORS[to];
  if (!a || !b || a[0] !== b[0]) return null;
  return (v * a[1]) / b[1];
}
const trim = (n, d) => String(Number(Number(n).toFixed(d)));

export function fmtNumber(v, unit) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  if (unit === 's' || unit === 'ratio') return Number(v).toFixed(2);
  if (unit === 'in' || unit === 'cm') return Number(v).toFixed(1);
  return trim(v, 2);
}
export function fmtValue(v, unit) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  v = Number(v);
  if (unit === 'in' && v >= 48) {
    const ft = Math.floor(v / 12); const inch = Math.round((v - ft * 12) * 10) / 10;
    return `${ft}′ ${Number.isInteger(inch) ? inch : inch.toFixed(1)}″`;
  }
  if (unit === 's') return v.toFixed(2) + ' s';
  if (unit === 'in' || unit === 'cm') return v.toFixed(1) + ' ' + unit;
  if (unit === 'ratio') return v.toFixed(2);
  if (unit === '%') return trim(v, 1) + '%';
  return trim(v, 2) + ' ' + unit;
}
export function fmtChange(change, unit) {
  if (change == null) return '';
  const sign = change > 0 ? '+' : change < 0 ? '-' : '±';
  const a = Math.abs(change);
  const num = unit === 's' || unit === 'ratio' ? a.toFixed(2) : trim(a, 1);
  return `${sign}${num}${unit === '%' ? ' pts' : unit === 'ratio' ? '' : ' ' + unit}`;
}
export const fmtPct = (p) => (p == null ? '' : `${p > 0 ? '+' : p < 0 ? '-' : ''}${Math.abs(p).toFixed(1)}%`);
export const scoring = (t) => (t.lower_better ? 'lower is better' : 'higher is better');

// Accepts 5.94, "6'5\"", "6' 5", "6-5" (feet-inches for inch tests) and "1:05.3" for seconds.
export function parseEntry(raw, unit) {
  const s = String(raw ?? '').trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/,/g, '');
  if (!s) return null;
  if (unit === 'in') {
    const m = s.match(/^(\d+)\s*(?:'|ft)\s*(\d+(?:\.\d+)?)?\s*(?:"|in)?$/i) || s.match(/^(\d+)-(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 12 + Number(m[2] || 0);
  }
  if (unit === 's') { const m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/); if (m) return Number(m[1]) * 60 + Number(m[2]); }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}
export const better = (t, a, b) => (t.lower_better ? a < b : a > b);
// Outside what's possible for a test? Same rule as the server: a test can have a lowest, a highest, both or neither.
export const outOfRange = (t, v) => (t.min_value != null && v < t.min_value) || (t.max_value != null && v > t.max_value);
export function bestOf(t, vals) { let m = null; for (const v of vals) if (v != null && (m == null || better(t, v, m))) m = v; return m; }

// Small trend line; the last point gets a dot. Higher on the chart always means better.
export function trendSvg(history, lowerBetter, { w = 110, h = 30, color = 'var(--green-mid)' } = {}) {
  if (!history || history.length < 2) return '';
  const vals = history.map((p) => (lowerBetter ? -p.value : p.value));
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * (w - 8) + 4, h - 4 - ((v - min) / span) * (h - 8)]);
  const last = pts[pts.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/><circle cx="${last[0]}" cy="${last[1]}" r="3" fill="${color}"/></svg>`;
}
