// Small SVG trend line for a test's history. "Up" on the chart always means better.
export function sparkline(points, { better = 'higher', width = 120, height = 36, label = 'Trend' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width); svg.setAttribute('height', height);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  const vals = points.map((p) => (better === 'lower' ? -p.value : p.value));
  if (vals.length < 2) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', width / 2); c.setAttribute('cy', height / 2); c.setAttribute('r', 3); c.setAttribute('fill', 'currentColor');
    svg.append(c); return svg;
  }
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1, pad = 4;
  const xy = vals.map((v, i) => [pad + (i * (width - 2 * pad)) / (vals.length - 1), height - pad - ((v - min) / span) * (height - 2 * pad)]);
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
  const [lx, ly] = xy.at(-1);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', lx); dot.setAttribute('cy', ly); dot.setAttribute('r', 3.5); dot.setAttribute('fill', 'currentColor');
  svg.append(dot);
  return svg;
}
const LABEL = { s: 's', ms: 'ms', in: 'in', ft: 'ft', cm: 'cm', m: 'm', lb: 'lb', kg: 'kg', mph: 'mph', 'km/h': 'km/h', 'm/s': 'm/s', 'ft/s': 'ft/s', N: 'N', W: 'W', 'W/kg': 'W/kg', 'N/kg': 'N/kg', '%': '%', reps: 'reps', ratio: '', level: '', rpm: 'rpm', points: 'pts', 'ml/kg/min': 'ml/kg/min' };
export function fmtResult(v, unit, decimals = 2, { delta = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'in' && Math.abs(v) >= 48 && !delta) { const ft = Math.floor(v / 12), inch = v - ft * 12; return `${ft}′ ${inch.toFixed(inch % 1 ? 1 : 0)}″`; }
  const n = Number(v).toFixed(decimals ?? 2);
  return `${delta && v > 0 ? '+' : ''}${n}${LABEL[unit] === '' ? '' : ` ${LABEL[unit] ?? unit}`}`;
}
export const fmtDate = (d) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
