import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS, figureSpec, figureSvg } from '../public/js/sprint-figure.js';
import { KINDS, POSITIONS } from '../src/services/sprint.js';

// The example figures the viewer shows under each position (owner's ask): one per kind and position, drawn from the
// reference angles, with the stance foot on the ground where it is down and the point to tap ringed.
const deg = (a, b, c) => { const ab = [a[0] - b[0], a[1] - b[1]], cb = [c[0] - b[0], c[1] - b[1]]; return Math.acos((ab[0] * cb[0] + ab[1] * cb[1]) / (Math.hypot(...ab) * Math.hypot(...cb))) * 180 / Math.PI; };

test('every kind has a figure for every position, and the angles drawn match the spec', () => {
  for (const [kind, k] of Object.entries(KINDS)) {
    for (const position of k.positions) {
      assert.ok(SPECS[kind][position], `${kind} ${position}`);
      const f = figureSpec(kind, position);
      assert.ok(f.points.hip && f.points.knee_stance && f.points.ankle_stance && f.points.knee_swing && f.points.ankle_swing && f.points.shoulder, `${kind} ${position} has every tappable point`);
      // The knee angles the geometry gives are the ones the spec names (within a degree).
      const sk = deg(f.points.hip, f.points.knee_stance, f.points.ankle_stance), wk = deg(f.points.hip, f.points.knee_swing, f.points.ankle_swing);
      assert.ok(Math.abs(sk - f.angles.stance_knee) < 1.5, `${kind} ${position} stance knee ${sk.toFixed(1)} vs ${f.angles.stance_knee}`);
      assert.ok(Math.abs(wk - f.angles.swing_knee) < 1.5, `${kind} ${position} swing knee ${wk.toFixed(1)} vs ${f.angles.swing_knee}`);
      assert.ok(POSITIONS[position], `${position} is a known position`);
    }
  }
  assert.equal(figureSpec('cod', 'mvp'), null, 'a cut has no MVP');
});

test('the figures read like the positions: 90° between the thighs at toe-off and MVP, the back thigh vertical at strike, the foot under the hip at full support', () => {
  const ts = (p) => figureSpec('top_speed', p);
  assert.equal(ts('toe_off').angles.thigh_separation, 90);
  assert.equal(ts('mvp').angles.thigh_separation, 90);
  assert.equal(SPECS.top_speed.strike.st, 0, 'the back thigh straight down');
  assert.equal(ts('touchdown').angles.shin_angle, 0, 'a vertical shin at touchdown');
  assert.ok(Math.abs(ts('full_support').points.ankle_stance[0]) < 0.1, 'the foot right under the hip');
  // The stance foot sits on the ground line where the foot is down; in flight both feet are above it.
  assert.ok(Math.abs(ts('touchdown').points.ankle_stance[1] - ts('touchdown').ground) < 1e-9);
  assert.ok(ts('mvp').points.ankle_stance[1] < ts('mvp').ground && ts('mvp').points.ankle_swing[1] < ts('mvp').ground);
  // Acceleration leans the trunk; the cut's plant has the shin laid back (the foot ahead of the knee).
  assert.equal(figureSpec('acceleration', 'toe_off').angles.trunk_lean, 35);
  const plant = figureSpec('cod', 'plant');
  assert.ok(plant.points.ankle_stance[0] > plant.points.knee_stance[0], 'the plant foot is ahead of the knee');
});

test('the SVG carries the legs in their colours, the ground line and a ring on the point to tap', () => {
  const svg = figureSvg(figureSpec('top_speed', 'strike'), { mark: 'knee_swing' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 160 190"/);
  assert.match(svg, /aria-label="Example of strike: the back thigh straight up and down"/);
  assert.ok((svg.match(/stroke="#E0A33B"/g) ?? []).length >= 3, 'the stance leg in amber');
  assert.ok((svg.match(/stroke="#7DBA70"/g) ?? []).length >= 3, 'the swing leg in green');
  assert.match(svg, /stroke-dasharray="4 4"/, 'the ground line');
  assert.equal((svg.match(/r="11"/g) ?? []).length, 1, 'one ring, on the marked point');
  assert.equal((figureSvg(figureSpec('top_speed', 'strike')).match(/r="11"/g) ?? []).length, 0, 'no ring without a mark');
  assert.equal(figureSvg(null), '');
});
