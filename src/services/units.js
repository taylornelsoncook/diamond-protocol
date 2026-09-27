// Converts results into each metric's unit. Values within the same dimension convert;
// anything else must already be in the metric's unit.
const DIMENSIONS = {
  length: { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048, yd: 0.9144 },
  time: { s: 1, ms: 0.001, min: 60 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, 'ft/s': 0.3048 },
  mass: { kg: 1, lb: 0.45359237 },
  force: { N: 1, kN: 1000, lbf: 4.4482216153, kgf: 9.80665 },
  rfd: { 'N/s': 1, 'kN/s': 1000 },
  power: { W: 1, kW: 1000 }
};
// Spellings seen in device exports.
const ALIASES = {
  meters: 'm', meter: 'm', metres: 'm', metre: 'm', centimeters: 'cm', cms: 'cm', inches: 'in', inch: 'in', '"': 'in', feet: 'ft', foot: 'ft', "'": 'ft', yards: 'yd', yds: 'yd',
  sec: 's', secs: 's', seconds: 's', second: 's', msec: 'ms', milliseconds: 'ms', minutes: 'min',
  'm·s-1': 'm/s', mps: 'm/s', kph: 'km/h', 'km/hr': 'km/h', 'kmh': 'km/h', fps: 'ft/s', 'ft/sec': 'ft/s',
  kgs: 'kg', kilograms: 'kg', lbs: 'lb', pounds: 'lb', newtons: 'N', n: 'N', kn: 'kN', w: 'W', watts: 'W', kw: 'kW',
  'n/s': 'N/s', 'kn/s': 'kN/s', 'w/kg': 'W/kg', 'n/kg': 'N/kg', percent: '%', pct: '%'
};

export function normalizeUnit(u) {
  if (u == null || u === '') return null;
  const raw = String(u).trim();
  return ALIASES[raw] ?? ALIASES[raw.toLowerCase()] ?? raw;
}
const dimensionOf = (u) => Object.keys(DIMENSIONS).find((d) => u in DIMENSIONS[d]);

// convert(0.61, 'm', 'in') -> 24.02
export function convert(value, from, to) {
  const f = normalizeUnit(from), t = normalizeUnit(to);
  if (!f || f === t) return value;
  const d = dimensionOf(f);
  if (!d || d !== dimensionOf(t)) {
    const err = new Error(`Can't convert ${from} to ${to}.`);
    err.code = 'unit_mismatch';
    throw err;
  }
  return (value * DIMENSIONS[d][f]) / DIMENSIONS[d][t];
}
export function compatibleUnits(unit) {
  const d = dimensionOf(unit);
  return d ? Object.keys(DIMENSIONS[d]) : [unit];
}
// Pulls the unit out of a column header: "Jump Height(m)", "Peak Force [N]", "40 Time (s)".
export function unitFromHeader(header) {
  const m = String(header).match(/[([]\s*([^()[\]]+?)\s*[)\]]\s*$/);
  return m ? normalizeUnit(m[1]) : null;
}
