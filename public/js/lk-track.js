// Point tracking in the browser (owner's ask: "manually select the points and have them track the points through the
// full video"): pyramidal Lucas–Kanade optical flow on grey frames, no dependencies, pure (tested in node on made-up
// images). A point tapped on one frame is followed into the next by matching the small window around it; a window
// with no texture, a match that doesn't hold when tracked back, or a point that leaves the frame is reported lost.
export const DEFAULTS = { win: 9, levels: 3, iters: 20, minDet: 1e-3, maxBack: 2.5 };

// RGBA bytes (an ImageData's data) to a grey Float32 image.
export function toGray(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}
// Half the size, each pixel the mean of its 2×2 block.
export function downsample(img) {
  const w = Math.floor(img.w / 2), h = Math.floor(img.h / 2), g = new Float32Array(w * h), s = img.g, W = img.w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (2 * y) * W + 2 * x;
    g[y * w + x] = (s[i] + s[i + 1] + s[i + W] + s[i + W + 1]) / 4;
  }
  return { g, w, h };
}
export function pyramid(gray, w, h, levels = DEFAULTS.levels) {
  const out = [{ g: gray, w, h }];
  for (let l = 1; l < levels; l++) { const prev = out[l - 1]; if (prev.w < 16 || prev.h < 16) break; out.push(downsample(prev)); }
  return out;
}
// Bilinear sample; outside the image reads the edge.
function at(img, x, y) {
  const { g, w, h } = img;
  const cx = Math.min(Math.max(x, 0), w - 1.001), cy = Math.min(Math.max(y, 0), h - 1.001);
  const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0, i = y0 * w + x0;
  return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy;
}
// One point, one level: iterate the flow d so that prev(x) ≈ next(x + d) over the window.
function lkLevel(prev, next, x, y, d, { win, iters, minDet }) {
  let gxx = 0, gxy = 0, gyy = 0;
  const n = (2 * win + 1) ** 2, Ix = new Float32Array(n), Iy = new Float32Array(n), I0 = new Float32Array(n);
  let k = 0;
  for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++, k++) {
    const px = x + dx, py = y + dy;
    Ix[k] = (at(prev, px + 1, py) - at(prev, px - 1, py)) / 2;
    Iy[k] = (at(prev, px, py + 1) - at(prev, px, py - 1)) / 2;
    I0[k] = at(prev, px, py);
    gxx += Ix[k] * Ix[k]; gxy += Ix[k] * Iy[k]; gyy += Iy[k] * Iy[k];
  }
  const det = gxx * gyy - gxy * gxy;
  if (det < minDet * n * n || gxx + gyy < 1e-6 * n) return { d, ok: false };   // no texture to hold on to
  let vx = d[0], vy = d[1];
  for (let it = 0; it < iters; it++) {
    let bx = 0, by = 0; k = 0;
    for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++, k++) {
      const dt = at(next, x + dx + vx, y + dy + vy) - I0[k];
      bx += Ix[k] * dt; by += Iy[k] * dt;
    }
    const sx = -(gyy * bx - gxy * by) / det, sy = -(-gxy * bx + gxx * by) / det;
    vx += sx; vy += sy;
    if (Math.abs(sx) + Math.abs(sy) < 0.01) break;
  }
  return { d: [vx, vy], ok: Number.isFinite(vx) && Number.isFinite(vy) };
}
// Track one point from the previous pyramid into the next: coarse to fine, each level starting from the one above.
export function trackPoint(prevPyr, nextPyr, pt, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const L = Math.min(prevPyr.length, nextPyr.length);
  let d = [0, 0];
  for (let l = L - 1; l >= 0; l--) {
    const s = 2 ** l;
    const r = lkLevel(prevPyr[l], nextPyr[l], pt[0] / s, pt[1] / s, d, o);
    if (!r.ok) return { pt: null, ok: false };
    d = l > 0 ? [r.d[0] * 2, r.d[1] * 2] : r.d;
  }
  const out = [pt[0] + d[0], pt[1] + d[1]];
  const { w, h } = prevPyr[0];
  if (out[0] < 0 || out[1] < 0 || out[0] > w - 1 || out[1] > h - 1) return { pt: null, ok: false };
  return { pt: out, ok: true };
}
// Every point, with a forward–backward check: a match that doesn't come back to where it started is lost.
export function trackPoints(prevPyr, nextPyr, points, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = {};
  for (const [key, pt] of Object.entries(points)) {
    if (!pt) { out[key] = null; continue; }
    const fwd = trackPoint(prevPyr, nextPyr, pt, o);
    if (!fwd.ok) { out[key] = null; continue; }
    const back = trackPoint(nextPyr, prevPyr, fwd.pt, o);
    out[key] = back.ok && Math.hypot(back.pt[0] - pt[0], back.pt[1] - pt[1]) <= o.maxBack ? fwd.pt : null;
  }
  return out;
}
