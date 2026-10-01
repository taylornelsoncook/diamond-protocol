// The step finder (public/js/sprint-detect.js) on made-up runs: a stick figure at 240 frames a second whose foot
// contacts we know, so the suggested toe-offs and touchdowns can be checked to the frame, and a cut for change of
// direction. The real model's points come from the browser; this checks what we do with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEvents, framePoints } from '../public/js/sprint-detect.js';

const FPS = 240, GROUND = 900;
// A runner moving at `speed` px/s to the right; contacts alternate legs: [leg, from, to] in seconds.
function run({ contacts, seconds, speed = 900, flip = [] }) {
  const frames = [];
  const footX = {};   // where each foot sits during its contact
  for (const [leg, from] of contacts) footX[`${leg}${from}`] = 200 + speed * (from + 0.04);
  for (let i = 0; i < seconds * FPS; i++) {
    const t = i / FPS, hipX = 200 + speed * t, hipY = 500 - 12 * Math.sin(t * 2 * Math.PI * 4.4);
    const legPt = (leg) => {
      const mine = contacts.filter((c) => c[0] === leg);
      const on = mine.find(([, a, b]) => t >= a && t <= b);
      if (on) return [footX[`${leg}${on[1]}`], GROUND];
      const before = [...mine].reverse().find(([, , b]) => b < t), after = mine.find(([, a]) => a > t);
      const x0 = before ? footX[`${leg}${before[1]}`] : hipX - 150, x1 = after ? footX[`${leg}${after[1]}`] : hipX + 250;
      const a = before ? before[2] : t - 0.1, b = after ? after[1] : t + 0.1, k = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return [x0 + (x1 - x0) * k, GROUND - 160 * Math.sin(Math.PI * k)];
    };
    const pts = { shoulderL: [hipX + 30, hipY - 300], shoulderR: [hipX + 30, hipY - 300], hipL: [hipX, hipY], hipR: [hipX, hipY] };
    for (const [leg, s] of [['A', 'L'], ['B', 'R']]) {
      const foot = legPt(leg), knee = [(hipX + foot[0]) / 2 + 40, (hipY + foot[1]) / 2];
      Object.assign(pts, { [`knee${s}`]: knee, [`ankle${s}`]: [foot[0], foot[1] - 30], [`heel${s}`]: [foot[0] - 15, foot[1]], [`toe${s}`]: [foot[0] + 25, foot[1]] });
    }
    if (flip.includes(i)) for (const k of ['knee', 'ankle', 'heel', 'toe']) [pts[`${k}L`], pts[`${k}R`]] = [pts[`${k}R`], pts[`${k}L`]];   // the model mixes the legs up
    frames.push({ t, pts });
  }
  return frames;
}
const near = (a, b, frames = 2) => Math.abs(a - b) <= frames / FPS + 1e-9;

test('top speed: toe-offs, touchdowns, MVP, strike and full support from the feet; a swapped frame is undone', () => {
  // Contact 0.10 s, flight 0.125 s, alternating legs.
  const contacts = [['A', 0.05, 0.15], ['B', 0.275, 0.375], ['A', 0.5, 0.6], ['B', 0.725, 0.825], ['A', 0.95, 1.05]];
  const frames = run({ contacts, seconds: 1.15, flip: [130, 131] });
  const r = findEvents(frames, { kind: 'top_speed', steps: 3 });
  assert.equal(r.steps, 3, r.note);
  assert.equal(r.direction, 1);
  const t = (step, position) => r.marks.find((m) => m.step === step && m.position === position)?.t;
  assert.ok(near(t(1, 'toe_off'), 0.15), `toe-off 1 at ${t(1, 'toe_off')}`);
  assert.ok(near(t(1, 'touchdown'), 0.275), `touchdown 1 at ${t(1, 'touchdown')}`);
  assert.ok(near(t(2, 'toe_off'), 0.375));
  assert.ok(near(t(3, 'touchdown'), 0.725));
  assert.ok(near(t(4, 'toe_off'), 0.825), 'the next toe-off closes the last step');
  for (const s of [1, 2, 3]) {
    assert.ok(t(s, 'toe_off') < t(s, 'mvp') && t(s, 'mvp') <= t(s, 'strike') && t(s, 'strike') < t(s, 'touchdown') && t(s, 'touchdown') <= t(s, 'full_support'), `step ${s} in order`);
  }
  const fs = r.marks.find((m) => m.step === 1 && m.position === 'full_support');
  assert.ok(Math.abs(fs.points.foot[0] - fs.points.hip[0]) < 25, 'full support: the foot under the hip');
  const td = r.marks.find((m) => m.step === 1 && m.position === 'touchdown');
  assert.ok(['shoulder', 'hip', 'knee_stance', 'ankle_stance', 'knee_swing', 'ankle_swing', 'foot'].every((k) => Array.isArray(td.points[k])), 'every point suggested');
  assert.equal(td.points.foot[1], GROUND, 'the landing foot on the ground');
});

test('a camera that follows the athlete: the same steps, read against the hip', () => {
  const contacts = [['A', 0.05, 0.15], ['B', 0.275, 0.375], ['A', 0.5, 0.6], ['B', 0.725, 0.825]];
  const still = run({ contacts, seconds: 0.9 });
  const panned = still.map((f) => ({ t: f.t, pts: Object.fromEntries(Object.entries(f.pts).map(([k, p]) => [k, [p[0] - 900 * f.t, p[1]]])) }));   // the hip stays put in the picture
  const r = findEvents(panned, { kind: 'top_speed', steps: 2 });
  const t = (step, position) => r.marks.find((m) => m.step === step && m.position === position)?.t;
  assert.equal(r.direction, 1, 'from the way the feet point');
  assert.ok(near(t(1, 'toe_off'), 0.15) && near(t(1, 'touchdown'), 0.275) && near(t(2, 'toe_off'), 0.375) && near(t(3, 'toe_off'), 0.6), JSON.stringify(r.marks.map((m) => [m.step, m.position, m.t])));
});

test('change of direction: the plant is the contact where the hip stops; penultimate, deepest and push-off around it', () => {
  // In at 700 px/s, a long plant (0.25 s) where the hip all but stops, then out the other way.
  const frames = [];
  const contacts = [['A', 0.05, 0.15], ['B', 0.3, 0.4], ['A', 0.55, 0.8], ['B', 0.95, 1.05]];
  const base = run({ contacts, seconds: 1.1, speed: 700 });
  for (const f of base) {   // the hip slows to a stop during the plant and drops; afterwards it goes back
    const t = f.t, x = t < 0.55 ? 200 + 700 * t : t < 0.8 ? 585 + 40 * Math.sin(((t - 0.55) / 0.25) * Math.PI) : 585 - 700 * (t - 0.8);
    const y = t >= 0.55 && t <= 0.8 ? 560 - 60 * Math.sin(((t - 0.55) / 0.25) * Math.PI) : 500;
    const dx = x - f.pts.hipL[0];
    const pts = { ...f.pts, hipL: [x, 1000 - y], hipR: [x, 1000 - y], shoulderL: [x + 20, 700 - y], shoulderR: [x + 20, 700 - y] };
    void dx;
    frames.push({ t, pts });
  }
  const r = findEvents(frames, { kind: 'cod' });
  const t = (p) => r.marks.find((m) => m.position === p)?.t;
  assert.ok(near(t('plant'), 0.55, 3), `plant at ${t('plant')} (${r.note})`);
  assert.ok(near(t('push_off'), 0.8, 3), `push-off at ${t('push_off')}`);
  assert.ok(t('penultimate') >= 0.3 && t('penultimate') <= 0.4, 'the step before');
  assert.ok(t('deepest') > t('plant') && t('deepest') < t('push_off'));
});

test('nothing to go on: no athlete, or no foot contacts, says why', () => {
  assert.match(findEvents([{ t: 0, pts: null }, { t: 0.1, pts: null }]).note, /wasn't found/);
  const floating = Array.from({ length: 50 }, (_, i) => ({ t: i / 60, pts: Object.fromEntries(['shoulder', 'hip', 'knee', 'ankle', 'heel', 'toe'].flatMap((k) => [[`${k}L`, [100 + i * 10, k === 'toe' || k === 'heel' ? 400 + (i % 7) * 30 : 300]], [`${k}R`, [100 + i * 10, k === 'toe' || k === 'heel' ? 400 + ((i + 3) % 7) * 30 : 300]]])) }));
  assert.ok(findEvents(floating).marks.length === 0 || findEvents(floating).note);
  assert.deepEqual(framePoints([], 100, 100), null);
  const lm = Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: 0.5 }));
  assert.deepEqual(framePoints(lm, 1000, 500).hipL, [230, 250]);
});
