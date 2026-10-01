// Sprint analysis: turn the body points the pose model found on every frame into suggested marks (owner decision:
// the app suggests every position and point, people override what's wrong). Pure functions, no browser: the test
// suite runs it on made-up runs, the browser on the model's output (sprint-auto.js).
//
// frames: [{ t (seconds into the video), pts: { shoulderL, shoulderR, hipL, hipR, kneeL, kneeR, ankleL, ankleR, heelL,
// heelR, toeL, toeR: [x, y] in the video's pixels } or null when no one was found }], in time order.
// Returns { marks: [{ step, position, t, points }], steps, direction, note } or { marks: [], note } when it can't tell.

const mid = (a, b) => (a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a ?? b ?? null);
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0);
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const LEG = ['knee', 'ankle', 'heel', 'toe'];

// The two legs as tracks A and B. The model names them left and right, but on a side view it sometimes swaps them for a
// frame or two when one leg passes the other; a swap that makes the legs jump less from the frame before is undone.
function tracks(frames) {
  const out = [];
  let prev = null;
  for (const f of frames) {
    if (!f?.pts) { out.push(null); continue; }
    const p = f.pts;
    let A = Object.fromEntries(LEG.map((k) => [k, p[`${k}L`]])), B = Object.fromEntries(LEG.map((k) => [k, p[`${k}R`]]));
    if (prev) {
      const keep = dist(A.knee, prev.A.knee) + dist(A.ankle, prev.A.ankle) + dist(B.knee, prev.B.knee) + dist(B.ankle, prev.B.ankle);
      const swap = dist(A.knee, prev.B.knee) + dist(A.ankle, prev.B.ankle) + dist(B.knee, prev.A.knee) + dist(B.ankle, prev.A.ankle);
      if (swap < keep * 0.7) [A, B] = [B, A];
    }
    const row = { t: f.t, shoulder: mid(p.shoulderL, p.shoulderR), hip: mid(p.hipL, p.hipR), A, B };
    out.push(row); prev = row;
  }
  return out;
}
// The lowest point of a foot (heel or toe, whichever is nearer the ground: y grows downward).
const footOf = (leg) => (leg.heel && leg.toe ? (leg.heel[1] > leg.toe[1] ? leg.heel : leg.toe) : leg.toe ?? leg.heel ?? leg.ankle);

// Which way a foot points (+1 right, -1 left): from the heel to the toe; a foot on the ground points the way they run.
const footDir = (leg) => (leg.toe && leg.heel && Math.abs(leg.toe[0] - leg.heel[0]) > 2 ? Math.sign(leg.toe[0] - leg.heel[0]) : 0);
// Which frames each foot is on the ground: near the ground line and not moving forward against the hip. Measured
// against the hip, so it works whether the camera stays still (the foot stops, the hip moves on) or follows the
// athlete (the hip stays put, the foot slides back across the picture).
// A cut (cod) uses the plain rule instead, the foot standing still on the ground: in the cut the athlete pushes back off
// the planted foot, so against the hip it looks like it moves forward. Film cuts with the camera still.
function contacts(rows, legLen, dir, still = false) {
  const n = rows.length, out = { A: [], B: [] };
  const absSpeed = (i, get) => {
    const a = rows[Math.max(0, i - 1)], b = rows[Math.min(n - 1, i + 1)];
    const pa = a && get(a), pb = b && get(b);
    return pa && pb && b.t > a.t ? Math.abs(pb[0] - pa[0]) / (b.t - a.t) : null;
  };
  const relSpeed = (i, side) => {   // the foot's speed along the way they run, against the hip (px/s)
    const a = rows[Math.max(0, i - 1)], b = rows[Math.min(n - 1, i + 1)];
    if (!a || !b || !(b.t > a.t)) return null;
    const fa = footOf(a[side]), fb = footOf(b[side]);
    if (!fa || !fb || !a.hip || !b.hip) return null;
    const d = footDir(rows[i][side]) || dir;
    return (((fb[0] - b.hip[0]) - (fa[0] - a.hip[0])) / (b.t - a.t)) * d;
  };
  // The ground line near each frame: the lowest foot point within a quarter second either side.
  const lowest = rows.map((r) => (r ? Math.max(footOf(r.A)?.[1] ?? -Infinity, footOf(r.B)?.[1] ?? -Infinity) : null));
  const ground = rows.map((r, i) => {
    if (!r) return null;
    let g = -Infinity;
    for (let j = i; j >= 0 && r.t - (rows[j]?.t ?? r.t) <= 0.25; j--) if (lowest[j] != null) g = Math.max(g, lowest[j]);
    for (let j = i; j < n && (rows[j]?.t ?? r.t) - r.t <= 0.25; j++) if (lowest[j] != null) g = Math.max(g, lowest[j]);
    return g;
  });
  for (const side of ['A', 'B']) {
    const on = rows.map((r, i) => {
      if (!r) return false;
      const foot = footOf(r[side]);
      if (!foot) return false;
      const near = ground[i] - foot[1] < 0.11 * legLen;   // a swinging foot lifts far more than this; noise on a small video less
      if (still) { const fs = absSpeed(i, (x) => footOf(x[side])), hs = absSpeed(i, (x) => x.hip) ?? 0; return near && (fs == null || fs < Math.max(0.45 * hs, 1.2 * legLen)); }
      const rel = relSpeed(i, side);
      return near && (rel == null || rel < 0.5 * legLen);   // a swinging foot moves forward past the hip; a planted one doesn't
    });
    // Clean up: a one-frame gap inside a contact is filled, a one-frame contact is dropped.
    for (let i = 1; i < n - 1; i++) if (!on[i] && on[i - 1] && on[i + 1]) on[i] = true;
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      let j = i; while (j + 1 < n && on[j + 1]) j++;
      if (j - i >= 1) out[side].push({ leg: side, from: i, to: j });
      i = j;
    }
  }
  return [...out.A, ...out.B].sort((a, b) => a.from - b.from);
}

const thighFromVertical = (hip, knee, dir) => (hip && knee ? Math.atan2((knee[0] - hip[0]) * dir, knee[1] - hip[1]) * (180 / Math.PI) : null);

// Points in our names for one frame, given which track is the stance leg there.
function pointsAt(r, stance, foot = 'low') {
  const swing = stance === 'A' ? 'B' : 'A', S = r[stance], W = r[swing];
  const p = { shoulder: r.shoulder, hip: r.hip, knee_stance: S.knee, ankle_stance: S.ankle, knee_swing: W.knee, ankle_swing: W.ankle,
    foot: foot === 'toe' ? (S.toe ?? footOf(S)) : footOf(S) };
  return Object.fromEntries(Object.entries(p).filter(([, v]) => Array.isArray(v) && v.every(Number.isFinite)).map(([k, v]) => [k, [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10]]));
}

export function findEvents(frames, { kind = 'top_speed', steps = 2 } = {}) {
  const rows = tracks(frames);
  const seen = rows.filter(Boolean);
  if (seen.length < 8) return { marks: [], note: 'The athlete wasn\'t found in enough frames. Film side-on with the whole body in view.' };
  const legLen = median(seen.flatMap((r) => [dist(r.hip, r.A.ankle), dist(r.hip, r.B.ankle)])) || 100;
  // The way they run: where the feet point, else the way the hip travels.
  const pointing = seen.flatMap((r) => [footDir(r.A), footDir(r.B)]).filter(Boolean);
  const first = seen[0].hip, last = seen[seen.length - 1].hip;
  let dir = pointing.length >= 6 ? (Math.sign(pointing.reduce((a, b) => a + b, 0)) || 1) : ((last[0] - first[0]) >= 0 ? 1 : -1);
  const cs = contacts(rows, legLen, dir, kind === 'cod');
  if (cs.length < 2) return { marks: [], note: 'No foot contacts were found. Film side-on, the camera still, with the feet in view.' };
  const at = (i) => rows[i];
  const marks = [];
  const put = (step, position, i, stance, foot) => { const r = at(i); if (r) marks.push({ step, position, t: Math.round(r.t * 10000) / 10000, points: pointsAt(r, stance, foot) }); };
  const best = (from, to, score) => { let bi = null, bs = Infinity; for (let i = from; i <= to; i++) { const r = at(i); if (!r) continue; const s = score(r); if (s != null && s < bs) { bs = s; bi = i; } } return bi; };

  if (kind === 'cod') {
    // The plant is the contact where the hip moves least (the cut); the step before it is the penultimate step.
    const hipSpeed = (c) => { const a = at(c.from), b = at(c.to); return a && b && b.t > a.t ? Math.abs(b.hip[0] - a.hip[0]) / (b.t - a.t) : Infinity; };
    let pi = 1, ps = Infinity;
    for (let i = 1; i < cs.length; i++) { const s = hipSpeed(cs[i]); if (s < ps) { ps = s; pi = i; } }
    const plant = cs[pi], pen = cs[pi - 1];
    dir = (at(plant.from).hip[0] - at(pen.from).hip[0]) >= 0 ? 1 : -1;   // the way in
    const pf = best(pen.from, pen.to, (r) => Math.abs(footOf(r[pen.leg])[0] - r.hip[0]));
    put(1, 'penultimate', pf ?? pen.from, pen.leg);
    put(1, 'plant', plant.from, plant.leg);
    put(1, 'deepest', best(plant.from, plant.to, (r) => -r.hip[1]) ?? plant.from, plant.leg);
    put(1, 'push_off', plant.to, plant.leg, 'toe');
    return { marks, steps: 1, direction: dir, note: `Found the cut at ${at(plant.from).t.toFixed(2)} s.` };
  }

  // Top speed and acceleration: a step runs from one foot's toe-off to the other foot's next toe-off.
  let start = 0;
  while (start + 1 < cs.length && cs[start + 1].leg === cs[start].leg) start++;
  const usable = [];
  for (let i = start; i + 1 < cs.length && usable.length < 4; i++) { if (cs[i + 1].leg !== cs[i].leg && cs[i + 1].from > cs[i].to) usable.push([cs[i], cs[i + 1]]); else break; }
  if (!usable.length) return { marks: [], note: 'No full step was found (one foot leaving, the other landing). Film a little longer, side-on.' };
  const n = Math.min(Math.max(steps, 2), 4, usable.length);
  usable.slice(0, n).forEach(([a, b], k) => {
    const s = k + 1;   // a = the pushing leg's contact, b = the next foot's
    put(s, 'toe_off', a.to, a.leg, 'toe');
    const mvp = best(a.to + 1, b.from - 1, (r) => r.hip[1]) ?? Math.round((a.to + b.from) / 2);   // the highest hip in the air
    put(s, 'mvp', mvp, a.leg);
    // Strike: the back (pushing) thigh closest to vertical between MVP and touchdown.
    const strike = best(mvp, b.from - 1, (r) => { const x = thighFromVertical(r.hip, r[a.leg].knee, dir); return x == null ? null : Math.abs(x); }) ?? Math.round((mvp + b.from) / 2);
    put(s, 'strike', strike, b.leg);
    put(s, 'touchdown', b.from, b.leg);
    put(s, 'full_support', best(b.from, b.to, (r) => Math.abs(footOf(r[b.leg])[0] - r.hip[0])) ?? b.from, b.leg);
    if (k === n - 1) put(s + 1, 'toe_off', b.to, b.leg, 'toe');
  });
  return { marks, steps: Math.max(2, n), direction: dir, note: `Found ${n} ${n === 1 ? 'step' : 'steps'}${usable.length < 2 ? ': film a little longer for two' : ''}.` };
}

// The model's 33 points (BlazePose order) to our names.
const IDX = { shoulderL: 11, shoulderR: 12, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32 };
export function framePoints(landmarks, w, h) {
  if (!landmarks?.length) return null;
  return Object.fromEntries(Object.entries(IDX).map(([k, i]) => [k, landmarks[i] ? [landmarks[i].x * w, landmarks[i].y * h] : null]));
}
// The foot contacts found (for checking a clip by hand): [{ leg, from, to }] in seconds.
export function contactsOf(frames, { kind = 'top_speed' } = {}) {
  const rows = tracks(frames), seen = rows.filter(Boolean);
  if (seen.length < 8) return [];
  const legLen = median(seen.flatMap((r) => [dist(r.hip, r.A.ankle), dist(r.hip, r.B.ankle)])) || 100;
  const pointing = seen.flatMap((r) => [footDir(r.A), footDir(r.B)]).filter(Boolean);
  const dir = Math.sign(pointing.reduce((a, b) => a + b, 0)) || 1;
  return contacts(rows, legLen, dir, kind === 'cod').map((c) => ({ leg: c.leg, from: rows[c.from].t, to: rows[c.to].t }));
}
