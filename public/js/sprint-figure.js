// Example figures for the sprint positions (owner's ask: "under the sprint frame, give an example of what toe off,
// MVP, strike, touchdown and full support are"): a stick figure per position and kind, drawn from the reference
// angles, the stance leg amber and the swing leg green like the viewer's overlay, the point to tap marked. Pure:
// figureSpec gives the joints and angles (tested in node), figureSvg the SVG markup; nothing here reads the DOM.
const R = Math.PI / 180;
// Angles in degrees. Thighs are measured from straight down, + = forward (the athlete runs to the right). A knee
// angle is the angle inside the joint (180 = straight); the shin folds backward from the thigh. A shin given as
// shin_angle (+ = knee ahead of the ankle) sets the shin itself. trunk is forward of vertical.
export const SPECS = {
  top_speed: {
    toe_off: { st: -42, st_knee: 155, sw: 48, sw_knee: 45, trunk: 7, ground: 'stance', mark: 'the last frame the pushing foot is on the ground' },
    mvp: { st: -22, st_knee: 50, sw: 68, sw_knee: 105, trunk: 7, ground: null, mark: 'the feet level in flight, the hip at its highest' },
    strike: { st: 0, st_knee: 60, sw: 30, sw_knee: 80, trunk: 7, ground: null, mark: 'the back thigh straight up and down' },
    touchdown: { st: 14, st_shin: 0, sw: -22, sw_knee: 42, trunk: 7, ground: 'stance', mark: 'the foot lands under a vertical shin' },
    full_support: { st: 16, st_knee: 150, sw: 30, sw_knee: 45, trunk: 7, ground: 'stance', mark: 'the foot right under the hip' }
  },
  acceleration: {
    toe_off: { st: -50, st_knee: 168, sw: 40, sw_knee: 50, trunk: 35, ground: 'stance', mark: 'pushing the ground away, the knee near straight' },
    mvp: { st: -25, st_knee: 60, sw: 65, sw_knee: 95, trunk: 35, ground: null, mark: 'the feet level in flight' },
    strike: { st: 0, st_knee: 70, sw: 30, sw_knee: 85, trunk: 35, ground: null, mark: 'the back thigh straight up and down' },
    touchdown: { st: 5, st_shin: 35, sw: -20, sw_knee: 50, trunk: 35, ground: 'stance', mark: 'the shin leaning forward as the foot lands' },
    full_support: { st: 20, st_knee: 140, sw: 45, sw_knee: 50, trunk: 35, ground: 'stance', mark: 'the hip over the foot, the trunk still leaning' }
  },
  cod: {
    penultimate: { st: 20, st_knee: 120, sw: -25, sw_knee: 110, trunk: 5, ground: 'stance', mark: 'the step before the plant, sitting to slow down' },
    plant: { st: 40, st_shin: -40, sw: -10, sw_knee: 120, trunk: 15, ground: 'stance', mark: 'the plant foot ahead, the knee bent, the shin laid back' },
    deepest: { st: 30, st_knee: 115, sw: -5, sw_knee: 110, trunk: 20, ground: 'stance', mark: 'the lowest point of the cut' },
    push_off: { st: -35, st_knee: 165, sw: 30, sw_knee: 90, trunk: 25, ground: 'stance', mark: 'pushing out of the cut' }
  }
};
export const LEG_COLORS = { stance: '#E0A33B', swing: '#7DBA70' };

// The joints as [x, y] with the hip at the origin, y down, a thigh 1 unit long; plus the angles the drawing shows.
export function figureSpec(kind, position) {
  const s = SPECS[kind]?.[position];
  if (!s) return null;
  const thigh = 1, shin = 0.95, trunk = 1.15, foot = 0.28;
  const hip = [0, 0];
  const dir = (deg) => [Math.sin(deg * R), Math.cos(deg * R)];
  const along = (from, deg, len) => [from[0] + dir(deg)[0] * len, from[1] + dir(deg)[1] * len];
  // Stance leg: a shin from the knee angle (folding backward), or a shin set by its own angle.
  const kneeS = along(hip, s.st, thigh);
  const shinSdeg = s.st_shin !== undefined ? -s.st_shin : s.st - (180 - s.st_knee);
  const ankleS = along(kneeS, shinSdeg, shin);
  const kneeW = along(hip, s.sw, thigh);
  const shinWdeg = s.sw - (180 - s.sw_knee);
  const ankleW = along(kneeW, shinWdeg, shin);
  const shoulder = along(hip, 180 - s.trunk, trunk);   // up and forward
  const head = along(shoulder, 180 - s.trunk, 0.28);
  // Feet point forward, flat on the ground for the stance foot when it's down, toe-up otherwise.
  const footS = [ankleS[0] + foot, s.ground === 'stance' ? ankleS[1] : ankleS[1] - 0.08];
  const footW = [ankleW[0] + foot * 0.9, ankleW[1] - 0.1];
  const stKnee = s.st_shin !== undefined ? 180 - (s.st - shinSdeg) : s.st_knee;
  return { kind, position, points: { hip, shoulder, head, knee_stance: kneeS, ankle_stance: ankleS, foot_stance: footS, knee_swing: kneeW, ankle_swing: ankleW, foot_swing: footW },
    angles: { thigh_separation: s.sw - s.st, stance_knee: Math.round(stKnee), swing_knee: s.sw_knee, trunk_lean: s.trunk, shin_angle: s.st_shin ?? null },
    ground: s.ground === 'stance' ? ankleS[1] : Math.max(ankleS[1], ankleW[1]) + 0.35, mark: s.mark };
}

// SVG markup for a spec: 160 × 190 box, the stance leg amber, the swing leg green, the ground line, and the point
// to tap (`mark`: hip, knee_stance, ankle_stance, knee_swing, ankle_swing or shoulder) ringed.
export function figureSvg(spec, { mark = null, width = 160, height = 190 } = {}) {
  if (!spec) return '';
  const S = 48, cx = width * 0.5, cy = 76;   // scale and the hip's place in the box
  const P = ([x, y]) => [cx + x * S, cy + y * S];
  const line = (a, b, color, w = 5) => { const [x1, y1] = P(a), [x2, y2] = P(b); return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`; };
  const dot = (a, color, r = 4) => { const [x, y] = P(a); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}"/>`; };
  const p = spec.points, g = cy + spec.ground * S;
  const parts = [
    `<line x1="8" y1="${g.toFixed(1)}" x2="${width - 8}" y2="${g.toFixed(1)}" stroke="#6b7370" stroke-width="2" stroke-dasharray="4 4"/>`,
    // The stance leg under the swing leg so the front leg reads on top.
    line(p.hip, p.knee_stance, LEG_COLORS.stance), line(p.knee_stance, p.ankle_stance, LEG_COLORS.stance), line(p.ankle_stance, p.foot_stance, LEG_COLORS.stance, 4),
    line(p.hip, p.knee_swing, LEG_COLORS.swing), line(p.knee_swing, p.ankle_swing, LEG_COLORS.swing), line(p.ankle_swing, p.foot_swing, LEG_COLORS.swing, 4),
    line(p.hip, p.shoulder, '#E4E7E5'),
    `<circle cx="${P(p.head)[0].toFixed(1)}" cy="${P(p.head)[1].toFixed(1)}" r="9" fill="none" stroke="#E4E7E5" stroke-width="4"/>`,
    dot(p.hip, '#E4E7E5'), dot(p.knee_stance, LEG_COLORS.stance), dot(p.ankle_stance, LEG_COLORS.stance), dot(p.knee_swing, LEG_COLORS.swing), dot(p.ankle_swing, LEG_COLORS.swing), dot(p.shoulder, '#E4E7E5', 3),
    `<text x="${width - 6}" y="${height - 6}" text-anchor="end" font-size="11" fill="#9aa39e" font-family="IBM Plex Sans, sans-serif">runs →</text>`
  ];
  if (mark && p[mark]) { const [x, y] = P(p[mark]); parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="#fff" stroke-width="2.5"/>`); }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Example of ${spec.position.replace('_', ' ')}: ${spec.mark}">${parts.join('')}</svg>`;
}
