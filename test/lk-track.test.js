import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGray, pyramid, trackPoint, trackPoints } from '../public/js/lk-track.js';

// The point tracker (public/js/lk-track.js) on made-up images: a textured patch moved by a known amount is found to
// within a fraction of a pixel; a point on a flat patch, or one that leaves the frame, is reported lost.
const W = 160, H = 120;
// A textured image: smooth value noise from a fixed lattice (never periodic, so a shift has one answer), drawn with
// an offset by sampling the lattice between its points.
const LAT = 48;
const lattice = Array.from({ length: LAT * LAT }, (_, i) => { let x = (i * 2654435761) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995) >>> 0; x ^= x >>> 15; return (x % 1000) / 1000; });
const lat = (i, j) => lattice[(((j % LAT) + LAT) % LAT) * LAT + (((i % LAT) + LAT) % LAT)];
function noise(x, y) {
  let v = 0, amp = 1, f = 1 / 9;
  for (let o = 0; o < 3; o++, amp /= 2, f *= 2.1) {
    const gx = x * f, gy = y * f, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lat(i, j) * (1 - sx) + lat(i + 1, j) * sx, b = lat(i, j + 1) * (1 - sx) + lat(i + 1, j + 1) * sx;
    v += amp * (a * (1 - sy) + b * sy);
  }
  return 40 + 160 * v / 1.75;
}
function textured(ox = 0, oy = 0) {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = noise(x - ox + 300, y - oy + 300);
  return g;
}
// The same image with a flat grey patch in one corner.
function flatCorner(g) { const out = Float32Array.from(g); for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) out[y * W + x] = 100; return out; }

test('a textured image shifted by a known amount is tracked to within half a pixel, coarse to fine', () => {
  const a = pyramid(textured(0, 0), W, H), b = pyramid(textured(3.4, -2.1), W, H);
  for (const pt of [[60, 60], [100, 40], [80, 90]]) {
    const r = trackPoint(a, b, pt);
    assert.ok(r.ok, `${pt} tracked`);
    assert.ok(Math.abs(r.pt[0] - (pt[0] + 3.4)) < 0.5 && Math.abs(r.pt[1] - (pt[1] - 2.1)) < 0.5, `${pt} → ${r.pt.map((v) => v.toFixed(2))}`);
  }
  // A bigger move still lands thanks to the pyramid.
  const c = pyramid(textured(11, 6), W, H);
  const far = trackPoint(a, c, [70, 60]);
  assert.ok(far.ok && Math.abs(far.pt[0] - 81) < 1 && Math.abs(far.pt[1] - 66) < 1, `far → ${far.pt}`);
});

test('flat patches and points leaving the frame are lost; the forward–backward check drops a bad match', () => {
  const g = flatCorner(textured(0, 0)), a = pyramid(g, W, H), b = pyramid(flatCorner(textured(2, 1)), W, H);
  assert.deepEqual(trackPoint(a, b, [15, 15]), { pt: null, ok: false }, 'no texture under the window');
  assert.ok(trackPoint(a, b, [100, 80]).ok, 'the textured part still tracks');
  const edge = trackPoint(pyramid(textured(0, 0), W, H), pyramid(textured(-30, 0), W, H), [8, 60]);
  assert.equal(edge.ok, false, 'the point would leave the frame');
  const pts = trackPoints(a, b, { hip: [100, 80], knee: [15, 15], none: null });
  assert.ok(pts.hip && Math.abs(pts.hip[0] - 102) < 0.5 && Math.abs(pts.hip[1] - 81) < 0.5);
  assert.equal(pts.knee, null); assert.equal(pts.none, null);
});

test('toGray turns RGBA bytes into luminance', () => {
  const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
  const g = toGray(data, 2, 2);
  assert.deepEqual([...g].map((v) => Math.round(v)), [255, 0, 76, 29]);
});
