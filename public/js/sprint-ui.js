// Sprint analysis screens (services/sprint.js): the coach's Sprint section (#/sprint), the client page's Sprint tab and
// the athlete app's Sprint tab. One viewer serves all three: the clip with frame-by-frame stepping, the key positions
// (two steps of toe-off, MVP, touchdown and full support, or the four moments of a cut), the angles drawn over the
// frame, each measure against the reference with its grade, the timing per step, a kinogram of the marked frames, and
// a side-by-side compare of reps. Coaches mark frames and tap points; athletes watch what their coach sent.
// Clips play from 10-minute signed addresses on the private bucket; nothing is downloaded or kept by the page.
import { h, fill, btn, busy, toast, field, input, select, ago } from './ui.js';
import { sendClip, CLIP_TYPES } from './formchecks-ui.js';

const SVG = 'http://www.w3.org/2000/svg';
const FPS = [240, 120, 60, 30, 960, 480, 50, 25, 24];
const KIND_LABEL = { top_speed: 'Top speed', acceleration: 'Acceleration', cod: 'Change of direction' };
const LANDMARK_ORDER = ['shoulder', 'hip', 'knee_swing', 'ankle_swing', 'knee_stance', 'ankle_stance', 'foot'];
const LANDMARK_LABEL = { shoulder: 'Shoulder', hip: 'Hip', knee_swing: 'Knee of the swing leg', ankle_swing: 'Ankle of the swing leg', knee_stance: 'Knee of the stance leg', ankle_stance: 'Ankle of the stance leg', foot: 'Stance foot on the ground' };
const BONES = [['shoulder', 'hip', 'trunk'], ['hip', 'knee_swing', 'swing'], ['knee_swing', 'ankle_swing', 'swing'], ['hip', 'knee_stance', 'stance'], ['knee_stance', 'ankle_stance', 'stance'], ['ankle_stance', 'foot', 'stance']];
const COLOR = { trunk: '#E4E7E5', swing: '#7DBA70', stance: '#F0B458' };
const ms = (s) => (s == null ? '—' : `${Math.round(s * 1000)} ms`);
const m2 = (x) => (x == null ? '—' : `${x.toFixed(2)} m`);
const ft = (x) => (x == null ? '' : ` (${(x * 3.281).toFixed(1)} ft)`);
const posKey = (p) => `${p.step}:${p.position}`;
const gradeChip = (g, big = false) => (g ? h('span', { class: `sp-grade sp-grade--${g[0]}${big ? ' sp-grade--big' : ''}`, title: `Grade ${g}` }, g) : h('span', { class: 'sp-grade sp-grade--none', title: 'Not graded yet' }, '–'));
const once = (el, ev) => new Promise((res, rej) => { const ok = () => { el.removeEventListener('error', bad); res(); }; const bad = () => { el.removeEventListener(ev, ok); rej(new Error('The video couldn\'t be read.')); }; el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true }); });
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val); return e; };
// The points a position needs: every measure's points, plus the stance foot where distance per step is read.
const needsOf = (pos, kind) => {
  const need = new Set(pos.measures.flatMap((m) => m.needs));
  if (pos.position === 'toe_off' && kind !== 'cod') need.add('foot');
  return LANDMARK_ORDER.filter((k) => need.has(k));
};
// Draw a pose (and cones) into an svg or a canvas 2D context, in the video's own pixels.
function drawPose(target, points, { w, scale = 1, cones = null }) {
  const r = Math.max(4, w / 150) * scale, lw = Math.max(3, w / 200) * scale;
  if (target instanceof CanvasRenderingContext2D) {
    target.lineCap = 'round';
    for (const [a, b, part] of BONES) if (points[a] && points[b]) { target.strokeStyle = COLOR[part]; target.lineWidth = lw; target.beginPath(); target.moveTo(points[a][0] * scale, points[a][1] * scale); target.lineTo(points[b][0] * scale, points[b][1] * scale); target.stroke(); }
    for (const p of Object.values(points)) { target.fillStyle = '#fff'; target.beginPath(); target.arc(p[0] * scale, p[1] * scale, r * 0.7, 0, Math.PI * 2); target.fill(); }
    return;
  }
  for (const [a, b, part] of BONES) if (points[a] && points[b]) target.append(svgEl('line', { x1: points[a][0], y1: points[a][1], x2: points[b][0], y2: points[b][1], stroke: COLOR[part], 'stroke-width': lw, 'stroke-linecap': 'round' }));
  for (const [k, p] of Object.entries(points)) target.append(svgEl('circle', { cx: p[0], cy: p[1], r, fill: '#fff', stroke: k.includes('swing') ? COLOR.swing : k.includes('stance') || k === 'foot' ? COLOR.stance : COLOR.trunk, 'stroke-width': lw / 1.5 }));
  if (cones) for (const p of [cones.a, cones.b].filter(Boolean)) target.append(svgEl('path', { d: `M${p[0]} ${p[1] - r * 3}L${p[0] - r * 1.6} ${p[1]}H${p[0] + r * 1.6}Z`, fill: '#F0B458', stroke: '#000', 'stroke-width': lw / 2 }));
}

// ---------- The viewer ----------
// opts: { api, prefix: '/v1' | '/app/api', id, editable (coach), onBack, onRemoved, athlete (true in the athlete app) }
export async function sprintViewer(opts) {
  const { api, prefix, id, editable } = opts;
  const box = h('div', { class: 'sp-viewer stack' }, h('p', { class: 'muted' }, 'Loading the clip…'));
  let clip, url, sel = null, tap = null, cal = null;
  const video = h('video', { playsinline: true, muted: true, preload: 'auto', class: 'sp-video', 'aria-label': 'Sprint clip' });
  const overlay = svgEl('svg', { class: 'sp-overlay', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Points and lines over the frame' });
  const stage = h('div', { class: 'sp-stage' }, video, overlay);
  const frameText = h('span', { class: 'small muted sp-frame' }, '');
  const scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'sp-scrub', 'aria-label': 'Position in the clip' });
  const playBtn = btn('Play', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); }, 'primary');
  const speed = select([['1', 'Full speed'], ['0.5', '½ speed'], ['0.25', '¼ speed'], ['0.125', '⅛ speed']], { value: '0.25', 'aria-label': 'Playback speed', style: 'width:auto' });
  const side = h('div', { class: 'stack sp-side' }), below = h('div', { class: 'stack' });
  const fps = () => clip.file_fps || 30;
  const frameOf = (t) => Math.floor(t * fps() + 0.02);   // the browser reports a frame's start a hair early
  const seekFrame = (n) => { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 1e9, (n + 0.5) / fps())); };
  const positions = () => clip.analysis?.positions ?? [];
  const selected = () => positions().find((p) => sel && posKey(p) === sel) ?? null;

  function drawOverlay() {
    overlay.replaceChildren();
    const w = video.videoWidth || clip.video_w || 1920, hgt = video.videoHeight || clip.video_h || 1080;
    overlay.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    const p = selected();
    if (tap) drawPose(overlay, tap.points, { w });
    else if (p?.marked && Math.abs(video.currentTime - p.t) < 0.75 / fps()) drawPose(overlay, p.points, { w });
    if (cal) drawPose(overlay, {}, { w, cones: cal });
    else if (editable && clip.calibration && settingsOpen) drawPose(overlay, {}, { w, cones: clip.calibration });
    overlay.classList.toggle('sp-overlay--tap', !!(tap || cal));
  }
  const tick = () => {
    const t = video.currentTime || 0;
    frameText.textContent = `Frame ${frameOf(t)} · ${t.toFixed(3)} s${clip.file_fps !== clip.capture_fps ? ` (filmed at ${clip.capture_fps}, plays at ${clip.file_fps})` : ''}`;
    if (video.duration) scrub.value = String(Math.round((t / video.duration) * 1000));
    playBtn.textContent = video.paused ? 'Play' : 'Pause';
    drawOverlay();
  };
  video.addEventListener('timeupdate', tick); video.addEventListener('seeked', tick); video.addEventListener('pause', tick);
  video.addEventListener('play', () => { const loop = () => { tick(); if (!video.paused) requestAnimationFrame(loop); }; loop(); });
  scrub.addEventListener('input', () => { if (video.duration) { video.pause(); video.currentTime = (Number(scrub.value) / 1000) * video.duration; } });
  speed.addEventListener('change', () => { video.playbackRate = Number(speed.value); });
  video.addEventListener('loadedmetadata', async () => {
    video.playbackRate = Number(speed.value);
    if (editable && video.videoWidth && (clip.video_w !== video.videoWidth || clip.video_h !== video.videoHeight)) {
      try { clip = await api('PATCH', `${prefix}/sprint-clips/${id}`, { video_w: video.videoWidth, video_h: video.videoHeight }); } catch { /* the size is only a check */ }
    }
    tick();
  });
  // Taps on the frame: the next point a position needs, or a cone.
  overlay.addEventListener('pointerdown', (e) => {
    if (!tap && !cal) return;
    const r = overlay.getBoundingClientRect(), w = video.videoWidth || clip.video_w, hgt = video.videoHeight || clip.video_h;
    const pt = [Math.round(((e.clientX - r.left) / r.width) * w), Math.round(((e.clientY - r.top) / r.height) * hgt)];
    if (cal) { if (!cal.a) cal.a = pt; else if (!cal.b) cal.b = pt; drawSide(); drawOverlay(); return; }
    const next = tap.need.find((k) => !tap.points[k] && !tap.skipped.has(k));
    if (next) { tap.points[next] = pt; drawSide(); drawOverlay(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!box.isConnected || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); seekFrame(frameOf(video.currentTime) + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekFrame(frameOf(video.currentTime) - 1); }
    if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
  });

  // The position picker and the selected position's measures.
  function picker() {
    const kindSteps = [...new Set(positions().map((p) => p.step))];
    return h('div', { class: 'stack-tight' }, kindSteps.map((step) => {
      const row = positions().filter((p) => p.step === step);
      return h('div', { class: 'sp-steprow' }, h('span', { class: 'small muted sp-steplabel' }, row[0]?.finish ? 'End' : clip.kind === 'cod' ? 'The cut' : `Step ${step}`),
        h('div', { class: 'row wrap', style: 'gap:6px' }, row.map((p) => h('button', { type: 'button', class: 'sp-pos', 'aria-pressed': sel === posKey(p) ? 'true' : 'false',
          onClick: () => { sel = posKey(p); tap = null; if (p.marked) { video.pause(); video.currentTime = p.t; } drawSide(); drawOverlay(); } },
        p.label, p.marked ? (p.grade ? gradeChip(p.grade) : h('span', { class: 'sp-dot', title: 'Marked' })) : null))));
    }));
  }
  function detail() {
    const p = selected();
    if (!p) return h('p', { class: 'small muted', style: 'margin:0' }, editable ? 'Pick a position, step to its frame, then press Use this frame.' : 'Pick a position to see that frame.');
    const refLine = p.measures.length ? `Reference: ${p.measures.map((m) => `${m.label.toLowerCase()} ≈${m.target}°`).join(', ')}` : null;
    const items = p.measures.map((m) => h('div', { class: 'sp-measure' },
      h('div', { class: 'row', style: 'gap:8px;align-items:center' }, gradeChip(m.grade), h('span', { class: 'strong grow' }, m.label), h('span', { class: 'sp-num' }, m.value == null ? '—' : `≈${m.value}°`)),
      m.grade ? h('div', { class: 'small' }, h('span', { class: 'strong' }, m.verdict), m.cue ? ` · ${m.cue}` : ` · within ${m.a}° of ${m.target}°.`) : h('div', { class: 'small muted' }, !editable ? 'Not measured on this rep.' : p.marked ? `Tap ${m.needs.map((n) => LANDMARK_LABEL[n].toLowerCase()).join(', ')} to measure it.` : 'Not marked yet.')));
    const actions = editable ? h('div', { class: 'row wrap', style: 'gap:8px' },
      tap ? null : btn(p.marked ? 'Use this frame instead' : 'Use this frame', () => { tap = { need: needsOf(p, clip.kind), points: Math.abs(video.currentTime - (p.t ?? -1)) < 0.75 / fps() ? { ...p.points } : {}, skipped: new Set(), t: video.currentTime }; video.pause(); drawSide(); drawOverlay(); }, p.marked ? 'secondary' : 'primary'),
      !tap && p.marked && needsOf(p, clip.kind).length ? btn('Redo the points', () => { video.currentTime = p.t; tap = { need: needsOf(p, clip.kind), points: {}, skipped: new Set(), t: p.t }; drawSide(); drawOverlay(); }, 'secondary') : null,
      !tap && p.marked ? btn('Clear', (e) => busy(e.currentTarget, async () => { clip = await api('DELETE', `${prefix}/sprint-clips/${id}/marks`, { step: p.step, position: p.position }); draw(); }), 'ghost') : null) : null;
    return h('div', { class: 'stack-tight' },
      h('div', { class: 'row', style: 'gap:10px;align-items:center' }, h('h3', { class: 'sp-h grow' }, `${p.finish ? '' : clip.kind === 'cod' ? '' : `Step ${p.step} · `}${p.label}`), p.grade ? gradeChip(p.grade, true) : null),
      h('p', { class: 'small muted', style: 'margin:0' }, p.hint, p.marked ? ` Marked at frame ${frameOf(p.t)}.` : ''),
      refLine ? h('p', { class: 'small', style: 'margin:0' }, refLine) : null,
      items.length ? h('div', { class: 'stack-tight' }, items) : null,
      tap ? tapPanel(p) : actions);
  }
  function tapPanel(p) {
    const next = tap.need.find((k) => !tap.points[k] && !tap.skipped.has(k));
    return h('div', { class: 'sp-tap stack-tight' },
      h('div', { class: 'strong' }, next ? `Tap: ${LANDMARK_LABEL[next]}` : 'All points tapped.'),
      h('div', { class: 'small muted' }, `${Object.keys(tap.points).length} of ${tap.need.length} points. Swing leg is green, stance leg amber. Frame ${frameOf(tap.t)}.`),
      h('div', { class: 'row wrap', style: 'gap:8px' },
        btn('Save', (e) => busy(e.currentTarget, async () => { clip = await api('PUT', `${prefix}/sprint-clips/${id}/marks`, { step: p.step, position: p.position, t: tap.t, points: tap.points }); tap = null; toast(`${p.label} saved.`); draw(); }), 'primary'),
        next ? btn('Skip this point', () => { tap.skipped.add(next); drawSide(); }, 'secondary') : null,
        Object.keys(tap.points).length ? btn('Undo last', () => { const last = [...tap.need].reverse().find((k) => tap.points[k]); delete tap.points[last]; drawSide(); drawOverlay(); }, 'ghost') : null,
        btn('Cancel', () => { tap = null; drawSide(); drawOverlay(); }, 'ghost')));
  }
  function drawSide() {
    fill(side, h('div', { class: 'row', style: 'gap:10px;align-items:center' }, h('div', { class: 'grow' }, h('div', { class: 'strong' }, 'Motion & positions'), h('div', { class: 'small muted' }, `${clip.analysis?.marked ?? 0} of ${clip.analysis?.total ?? 0} marked`)),
      h('span', { class: 'small muted' }, 'Rep grade'), gradeChip(clip.analysis?.grade, true)), picker(), detail());
  }
  // Timing per step.
  function timingPanel() {
    const t = clip.analysis?.timing;
    if (!t?.steps?.length) return null;
    const cod = clip.kind === 'cod';
    const rows = t.steps.map((s) => cod ? h('tr', null, h('td', null, 'The cut'), h('td', { class: 'num' }, ms(s.contact_s)), h('td', { class: 'num' }, ms(s.braking_s)), h('td', { class: 'num' }, ms(s.propulsion_s)))
      : h('tr', null, h('td', null, `Step ${s.step}`), h('td', { class: 'num' }, ms(s.contact_s)), h('td', { class: 'num' }, ms(s.flight_s)), h('td', { class: 'num' }, s.step_rate_hz ? `${s.step_rate_hz} /s` : '—'), h('td', { class: 'num' }, `${m2(s.step_length_m)}${ft(s.step_length_m)}`)));
    const head = cod ? ['', 'Ground contact', 'Braking', 'Push'] : ['', 'Ground contact', 'Flight', 'Step rate', 'Distance per step'];
    const note = cod ? 'Contact runs from the plant to the push-off; braking to the deepest point, push from there.'
      : `Contact is touchdown to the next toe-off; flight is toe-off to touchdown.${t.steps.some((s) => s.step_length_from === 'speed') ? ' Distance per step comes from the speed entered times the step time.' : t.steps.some((s) => s.step_length_from === 'cones') ? ' Distance per step is measured between the stance feet at toe-off, scaled by the cones.' : ' Add the cones or the speed for distance per step.'}`;
    return h('div', { class: 'dp-panel stack-tight' }, h('h3', { class: 'dp-panel-title' }, 'Timing'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, head.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', null, rows))),
      h('p', { class: 'small muted', style: 'margin:0' }, note, clip.rep_time_s ? ` Rep time ${clip.rep_time_s} s.` : ''));
  }
  // Clip settings (coach): direction, frame rates, kind, speed, cones.
  let settingsOpen = false;
  function settingsPanel() {
    const dirSel = select([['1', 'Running to the right'], ['-1', 'Running to the left']], { value: String(clip.direction) });
    const cap = select(FPS.map((f) => [String(f), `${f} frames a second`]), { value: String(clip.capture_fps) });
    const file = select(FPS.map((f) => [String(f), `${f} frames a second`]), { value: String(clip.file_fps) });
    const kind = select(Object.entries(KIND_LABEL), { value: clip.kind });
    const spd = input({ type: 'number', step: '0.01', min: '1', max: '13', value: clip.speed_mps ?? '', inputmode: 'decimal', placeholder: 'e.g. 9.2' });
    const rep = input({ type: 'number', step: '0.01', min: '0.3', max: '30', value: clip.rep_time_s ?? '', inputmode: 'decimal' });
    const title = input({ value: clip.title ?? '', maxlength: '80' });
    const meters = input({ type: 'number', step: '0.1', min: '0.5', max: '60', value: cal?.meters ?? clip.calibration?.meters ?? '10', inputmode: 'decimal' });
    const save = (body) => api('PATCH', `${prefix}/sprint-clips/${id}`, body);
    const conesLine = cal
      ? h('div', { class: 'sp-tap stack-tight' }, h('div', { class: 'strong' }, !cal.a ? 'Tap the first cone where it meets the ground.' : !cal.b ? 'Tap the second cone.' : 'Both cones tapped. How far apart are they?'),
        cal.b ? field('Distance between the cones (m)', meters) : null,
        h('div', { class: 'row wrap', style: 'gap:8px' }, cal.b ? btn('Save the cones', (e) => busy(e.currentTarget, async () => { clip = await save({ calibration: { a: cal.a, b: cal.b, meters: Number(meters.value) } }); cal = null; toast('Cones saved.'); draw(); }), 'primary') : null,
          btn('Cancel', () => { cal = null; draw(); }, 'ghost')))
      : h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, h('span', { class: 'small grow' }, clip.calibration ? `Cones ${clip.calibration.meters} m apart.` : 'No cones yet: two cones a known distance apart in the lane give distance per step.'),
        btn(clip.calibration ? 'Tap them again' : 'Tap the two cones', () => { video.pause(); cal = { a: null, b: null }; draw(); }, 'secondary'),
        clip.calibration ? btn('Remove', (e) => busy(e.currentTarget, async () => { clip = await save({ calibration: null }); draw(); }), 'ghost') : null);
    const body = h('div', { class: 'stack' },
      h('div', { class: 'grid-2' }, field('What this rep is', kind), field('Title', title), field('Direction of travel', dirSel), field('Filmed at', cap, 'iPhone slow motion is 240.'),
        field('The file plays at', file, 'The same as filmed, unless the clip plays slowed down on a computer (then usually 30).'), field('Rep time (s)', rep, 'From the timing gates, if you have it.'),
        field('Speed (m/s)', spd, 'Optional: from gates or radar. Gives distance per step when there are no cones.')),
      conesLine,
      h('div', { class: 'row' }, btn('Save details', (e) => busy(e.currentTarget, async () => {
        const body = { title: title.value, direction: Number(dirSel.value), capture_fps: Number(cap.value), file_fps: Number(file.value), speed_mps: spd.value === '' ? null : Number(spd.value), rep_time_s: rep.value === '' ? null : Number(rep.value) };
        if (kind.value !== clip.kind) { if (clip.analysis.marked && !confirm('Changing what this rep is clears the frames already marked. Go ahead?')) return; body.kind = kind.value; body.confirm = true; }
        clip = await save(body); toast('Saved.'); draw();
      }), 'primary')));
    const d = h('details', { class: 'dp-panel', open: settingsOpen || !!cal }, h('summary', { class: 'strong', onClick: () => { settingsOpen = !settingsOpen; setTimeout(drawOverlay); } }, 'Clip details: direction, frame rate, cones and speed'), body);
    return d;
  }
  // The kinogram: every marked frame, step by step, with the lines and the numbers.
  function kinogramPanel() {
    const holder = h('div', { class: 'stack' });
    const marked = positions().filter((p) => p.marked && !p.finish);
    const build = (e) => busy(e.currentTarget, async () => {
      const v2 = document.createElement('video'); v2.muted = true; v2.playsInline = true; v2.preload = 'auto'; v2.src = url;
      await once(v2, 'loadeddata');
      const rows = new Map();
      for (const p of marked) {
        v2.currentTime = p.t; await once(v2, 'seeked');
        const w = v2.videoWidth, hgt = v2.videoHeight, cw = 280, scale = cw / w;
        const canvas = h('canvas', { width: String(cw), height: String(Math.round(hgt * scale)), class: 'sp-kframe', role: 'img', 'aria-label': `${p.label}, step ${p.step}` });
        const c2 = canvas.getContext('2d'); c2.drawImage(v2, 0, 0, cw, hgt * scale); drawPose(c2, p.points, { w, scale });
        const nums = p.measures.filter((m) => m.value != null).map((m) => `${m.label} ≈${m.value}°`).join(' · ');
        const tile = h('button', { type: 'button', class: 'sp-ktile', onClick: () => { sel = posKey(p); video.currentTime = p.t; drawSide(); stage.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
          h('div', { class: 'sp-kimg' }, canvas, p.grade ? gradeChip(p.grade) : null), h('div', { class: 'strong small' }, p.label), nums ? h('div', { class: 'small muted' }, nums) : null);
        if (!rows.has(p.step)) rows.set(p.step, []);
        rows.get(p.step).push(tile);
      }
      fill(holder, [...rows].map(([step, tiles]) => h('div', { class: 'stack-tight' }, h('div', { class: 'small muted' }, clip.kind === 'cod' ? 'The cut' : `Step ${step}`), h('div', { class: 'sp-kgrid' }, tiles))));
      v2.removeAttribute('src'); v2.load();
    });
    return h('div', { class: 'dp-panel stack-tight' }, h('div', { class: 'row', style: 'gap:8px;align-items:center' }, h('h3', { class: 'dp-panel-title grow' }, 'Kinogram'),
      marked.length ? btn(holder.childElementCount ? 'Build it again' : 'Build the kinogram', build, 'secondary') : null),
    marked.length ? null : h('p', { class: 'small muted', style: 'margin:0' }, 'Mark positions to lay their frames side by side here.'), holder);
  }
  function reviewPanel() {
    if (!editable) return clip.review_note || clip.reviewed_at ? h('div', { class: 'dp-panel stack-tight' }, h('h3', { class: 'dp-panel-title' }, `From ${clip.reviewed_by_name?.split(' ')[0] ?? 'your coach'}`), h('p', { style: 'margin:0;white-space:pre-wrap' }, clip.review_note ?? 'Look through each position above.')) : null;
    const note = h('textarea', { class: 'dp-input', rows: '3', maxlength: '1500', placeholder: 'What you saw and the one or two things to work on.' }, clip.review_note ?? '');
    return h('div', { class: 'dp-panel stack-tight' }, h('h3', { class: 'dp-panel-title' }, clip.status === 'reviewed' ? `Sent to ${clip.client_name?.split(' ')[0]} ${ago(clip.reviewed_at).toLowerCase()}` : `Send to ${clip.client_name?.split(' ')[0] ?? 'the athlete'}`),
      h('p', { class: 'small muted', style: 'margin:0' }, 'They see every position, the grades and the timing in their app\'s Sprint tab, and your note comes as a message.'),
      field('Your note', note),
      h('div', { class: 'row wrap', style: 'gap:8px' }, btn(clip.status === 'reviewed' ? 'Send again' : 'Send the analysis', (e) => busy(e.currentTarget, async () => { clip = await api('POST', `${prefix}/sprint-clips/${id}/review`, { note: note.value }); toast('Sent.'); draw(); }), 'primary'),
        btn('Remove this clip', (e) => { if (confirm('Remove this clip and its analysis? This can\'t be undone.')) busy(e.currentTarget, async () => { await api('DELETE', `${prefix}/sprint-clips/${id}`); toast('Removed.'); opts.onRemoved?.(); }); }, 'ghost')));
  }
  function draw() {
    const head = h('div', { class: 'row wrap', style: 'gap:10px;align-items:center' },
      h('div', { class: 'grow' }, h('div', { class: 'sp-kicker' }, `${clip.kind_label}${clip.client_name && !opts.athlete ? ` · ${clip.client_name}` : ''}`),
        h('h2', { class: 'sp-title' }, clip.title || `${clip.kind_label} rep`), h('div', { class: 'small muted' }, [clip.sent_at ? `Sent ${ago(clip.sent_at).toLowerCase()}` : null, clip.uploaded_by_kind !== 'staff' && clip.uploaded_by_name ? `by ${clip.uploaded_by_name}` : null, clip.note].filter(Boolean).join(' · '))),
      opts.onBack ? btn('Back', opts.onBack, 'secondary') : null);
    fill(box, head,
      h('div', { class: 'sp-main' },
        h('div', { class: 'stack-tight sp-left' }, stage,
          h('div', { class: 'row wrap sp-controls', style: 'gap:8px;align-items:center' }, playBtn, btn('← Frame', () => seekFrame(frameOf(video.currentTime) - 1), 'secondary', { 'aria-label': 'Back one frame' }), btn('Frame →', () => seekFrame(frameOf(video.currentTime) + 1), 'secondary', { 'aria-label': 'Forward one frame' }), speed),
          scrub, frameText),
        side),
      below);
    drawSide();
    fill(below, timingPanel(), kinogramPanel(), editable ? settingsPanel() : null, reviewPanel());
    tick();
  }
  (async () => {
    try {
      clip = await api('GET', `${prefix}/sprint-clips/${id}`);
      if (opts.athlete && !clip.analysis) { fill(box, h('div', { class: 'empty' }, 'Your coach hasn\'t sent the analysis of this rep yet.'), opts.onBack ? btn('Back', opts.onBack, 'secondary') : null); return; }
      url = (await api('GET', `${prefix}/sprint-clips/${id}/video`)).url;
      video.src = url;
      const first = positions().find((p) => p.marked) ?? positions()[0];
      sel = first ? posKey(first) : null;
      draw();
      video.addEventListener('loadeddata', () => { const p = selected(); if (p?.marked) video.currentTime = p.t; }, { once: true });
      if (opts.athlete && clip.status === 'reviewed' && !clip.seen_at) api('POST', `${prefix}/sprint-clips/${id}/seen`).catch(() => {});
    } catch (e) { fill(box, h('div', { class: 'empty' }, e.message), opts.onBack ? btn('Back', opts.onBack, 'secondary') : null); }
  })();
  return box;
}

// ---------- Compare reps ----------
// Up to three clips side by side: pick a position and each jumps to its own frame for it; step them together; play together.
export function compareView({ api, prefix, ids, onBack, title = true }) {
  const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading the reps…'));
  (async () => {
    try {
      const clips = await Promise.all(ids.slice(0, 3).map(async (id) => { const c = await api('GET', `${prefix}/sprint-clips/${id}`); return { c, url: (await api('GET', `${prefix}/sprint-clips/${id}/video`)).url }; }));
      const usable = clips.filter((x) => x.c.analysis);
      if (usable.length < 2) { fill(box, h('div', { class: 'empty' }, 'Pick two reps that have been analysed to compare them.'), onBack ? btn('Back', onBack, 'secondary') : null); return; }
      const together = h('input', { type: 'checkbox', checked: true });
      let sel = null;
      const cols = usable.map(({ c, url }) => {
        const v = h('video', { src: url, playsinline: true, muted: true, preload: 'auto', class: 'sp-video' });
        const ov = svgEl('svg', { class: 'sp-overlay', preserveAspectRatio: 'none' });
        const info = h('div', { class: 'stack-tight' });
        const frame = h('span', { class: 'small muted' });
        const fps = c.file_fps || 30, fo = (t) => Math.floor(t * fps + 0.02), seek = (n) => { v.pause(); v.currentTime = Math.max(0, (n + 0.5) / fps); };
        const pose = () => { ov.replaceChildren(); const w = v.videoWidth || c.video_w || 1920, hh = v.videoHeight || c.video_h || 1080; ov.setAttribute('viewBox', `0 0 ${w} ${hh}`); const p = c.analysis.positions.find((x) => sel && posKey(x) === sel); if (p?.marked && Math.abs(v.currentTime - p.t) < 0.75 / fps) drawPose(ov, p.points, { w }); frame.textContent = `Frame ${fo(v.currentTime)}`; };
        v.addEventListener('seeked', pose); v.addEventListener('loadedmetadata', () => { v.playbackRate = 0.25; pose(); });
        const col = { c, v, seek, fo, pose, info,
          el: h('div', { class: 'stack-tight sp-col' }, h('div', { class: 'row', style: 'gap:8px;align-items:center' }, h('div', { class: 'grow' }, h('div', { class: 'strong' }, c.title || `${c.kind_label} rep`), h('div', { class: 'small muted' }, [c.client_name, c.sent_at ? ago(c.sent_at) : null, c.rep_time_s ? `${c.rep_time_s} s` : null].filter(Boolean).join(' · '))), gradeChip(c.analysis.grade, true)),
            h('div', { class: 'sp-stage' }, v, ov),
            h('div', { class: 'row', style: 'gap:6px;align-items:center' }, btn('←', () => step(col, -1), 'secondary', { 'aria-label': 'Back one frame' }), btn('→', () => step(col, 1), 'secondary', { 'aria-label': 'Forward one frame' }), frame), info) };
        return col;
      });
      const step = (col, d) => { for (const x of together.checked ? cols : [col]) x.seek(x.fo(x.v.currentTime) + d); };
      const kinds = new Set(usable.map((x) => x.c.kind));
      const posList = usable[0].c.analysis.positions.filter((p) => !p.finish);
      const show = (key) => {
        sel = key;
        for (const col of cols) {
          const p = col.c.analysis.positions.find((x) => posKey(x) === key);
          if (p?.marked) { col.v.pause(); col.v.currentTime = p.t; }
          fill(col.info, p ? [h('div', { class: 'row', style: 'gap:8px;align-items:center' }, gradeChip(p.grade), h('span', { class: 'strong' }, p.label)),
            ...p.measures.map((m) => h('div', { class: 'small' }, `${m.label}: ${m.value == null ? '—' : `≈${m.value}°`}`, m.grade ? h('span', { class: 'muted' }, ` (${m.verdict.toLowerCase()})`) : null))]
            : h('div', { class: 'small muted' }, 'A different kind of rep.'));
          col.pose();
        }
        drawButtons();
      };
      const buttons = h('div', { class: 'row wrap', style: 'gap:6px' });
      const drawButtons = () => fill(buttons, posList.map((p) => h('button', { type: 'button', class: 'sp-pos', 'aria-pressed': sel === posKey(p) ? 'true' : 'false', onClick: () => show(posKey(p)) }, usable[0].c.kind === 'cod' ? p.label : `Step ${p.step} · ${p.label}`)));
      const timing = h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Rep'), h('th', { scope: 'col' }, 'Grade'), h('th', { scope: 'col' }, 'Ground contact'), h('th', { scope: 'col' }, 'Flight'), h('th', { scope: 'col' }, 'Step rate'), h('th', { scope: 'col' }, 'Distance per step'))),
        h('tbody', null, usable.map(({ c }) => { const t = c.analysis.timing; return h('tr', null, h('td', null, c.title || c.kind_label), h('td', null, c.analysis.grade ?? '—'), h('td', { class: 'num' }, ms(t.contact_s)), h('td', { class: 'num' }, ms(t.flight_s)), h('td', { class: 'num' }, t.step_rate_hz ? `${t.step_rate_hz} /s` : '—'), h('td', { class: 'num' }, m2(t.step_length_m))); }))));
      fill(box, title ? h('div', { class: 'row wrap', style: 'gap:10px;align-items:center' }, h('h2', { class: 'sp-title grow' }, 'Compare reps'), onBack ? btn('Back', onBack, 'secondary') : null) : null,
        kinds.size > 1 ? h('p', { class: 'small muted', style: 'margin:0' }, 'These reps are different kinds, so only the positions they share line up.') : null,
        h('div', { class: 'row wrap', style: 'gap:10px;align-items:center' }, h('label', { class: 'row', style: 'gap:6px' }, together, 'Move together'),
          btn('Play together', () => { const playing = cols.some((x) => !x.v.paused); for (const x of cols) { if (playing) x.v.pause(); else x.v.play().catch(() => {}); } }, 'secondary'),
          btn('Reset alignment', () => show(sel ?? posKey(posList[0])), 'ghost')),
        buttons, h('div', { class: `sp-compare sp-compare--${cols.length}` }, cols.map((x) => x.el)), timing);
      show(posKey(posList.find((p) => usable.every((x) => x.c.analysis.positions.find((q) => posKey(q) === posKey(p))?.marked)) ?? posList[0]));
    } catch (e) { fill(box, h('div', { class: 'empty' }, e.message), onBack ? btn('Back', onBack, 'secondary') : null); }
  })();
  return box;
}

// ---------- Uploading a rep ----------
// opts: { api, start: (body) => api, finish: (id) => api, kinds: [{ key, label, tip }], onSent(clip), who: 'athlete' | 'staff' }
export function uploadForm(opts) {
  const kind = select(opts.kinds.map((k) => [k.key, k.label]), { value: opts.kinds[0]?.key });
  const tip = h('p', { class: 'small muted', style: 'margin:0' });
  const showTip = () => { tip.textContent = opts.kinds.find((k) => k.key === kind.value)?.tip ?? ''; };
  kind.addEventListener('change', showTip); showTip();
  const fpsSel = select(FPS.map((f) => [String(f), f === 240 ? '240 (iPhone slow motion)' : f === 60 ? '60 (most phones, or a screen recording)' : String(f)]), { value: '240' });
  const rep = input({ type: 'number', step: '0.01', min: '0.3', max: '30', inputmode: 'decimal', placeholder: 'e.g. 1.07' });
  const title = input({ maxlength: '80', placeholder: opts.who === 'athlete' ? 'e.g. Fly 20, rep 2' : 'e.g. Rep 2' });
  const note = input({ maxlength: '500', placeholder: opts.who === 'athlete' ? 'Anything your coach should know' : 'Optional' });
  const fileInput = h('input', { type: 'file', accept: CLIP_TYPES, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const bar = h('div', { class: 'fc-progress', hidden: true, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { style: 'width:0%' }));
  const word = h('span', { class: 'small muted' });
  const button = btn('Choose the video and send', () => fileInput.click(), 'primary');
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]; fileInput.value = '';
    if (!file) return;
    busy(button, async () => {
      bar.hidden = false;
      try {
        const clip = await sendClip({ file, start: opts.start, finish: opts.finish,
          extra: { kind: kind.value, capture_fps: Number(fpsSel.value), title: title.value || null, note: note.value || null, rep_time_s: rep.value === '' ? null : Number(rep.value) },
          onProgress: (p) => { const pct = Math.round(p * 100); bar.firstChild.style.width = `${pct}%`; bar.setAttribute('aria-valuenow', String(pct)); word.textContent = pct >= 100 ? 'Checking the clip…' : `Sending… ${pct}%`; } });
        toast(opts.who === 'athlete' ? 'Sent. Your coach will mark it up.' : 'Clip added.'); title.value = ''; note.value = ''; rep.value = '';
        opts.onSent?.(clip);
      } catch (e) { toast(e.message, 'bad'); }
      finally { bar.hidden = true; word.textContent = ''; bar.firstChild.style.width = '0%'; }
    });
  });
  return h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, field('What it is', kind), field('Filmed at', fpsSel), field('Title', title), field('Rep time (s)', rep, 'From timing gates, if you have it.')), tip, field('Note', note),
    h('p', { class: 'small muted', style: 'margin:0' }, 'One rep per clip, up to a minute and 150 MB. Film side-on with the camera still, the whole body in frame.'),
    h('div', { class: 'row wrap', style: 'gap:10px;align-items:center' }, button, word), bar, fileInput);
}

// ---------- A list of reps ----------
// rows from /sprint lists; onOpen(id), compare (true shows tick boxes and Compare)
export function clipList(rows, { onOpen, onCompare, athlete = false, showName = false }) {
  if (!rows.length) return h('div', { class: 'empty' }, athlete ? 'No sprint reps yet. Send one above.' : 'No sprint clips yet.');
  const picked = new Set();
  const cmp = onCompare ? btn('Compare the ticked reps', () => onCompare([...picked]), 'secondary', { disabled: true }) : null;
  const list = h('div', { class: 'list' }, rows.map((c) => {
    const ready = !athlete || c.status === 'reviewed';
    const tick = onCompare && ready ? h('input', { type: 'checkbox', 'aria-label': `Compare ${c.title || c.kind_label}`, onChange: (e) => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); if (picked.size > 3) { e.target.checked = false; picked.delete(c.id); toast('Compare up to three reps.', 'bad'); } cmp.disabled = picked.size < 2; } }) : null;
    const status = c.status === 'reviewed' ? (athlete && !c.seen_at ? h('span', { class: 'dp-badge dp-badge--good' }, 'New') : h('span', { class: 'small muted' }, 'Sent')) : athlete ? h('span', { class: 'small muted' }, 'Waiting for your coach') : h('span', { class: 'dp-badge dp-badge--warn' }, c.marked ? `${c.marked} of ${c.total} marked` : 'To mark');
    return h('div', { class: 'list-item', style: 'gap:10px;align-items:center;flex-wrap:wrap' }, tick, ready ? gradeChip(c.grade) : null,
      h('button', { type: 'button', class: 'linkish grow', style: 'text-align:left', onClick: () => onOpen(c.id) },
        h('div', { class: 'strong' }, `${showName ? `${c.client_name} · ` : ''}${c.title || c.kind_label}`),
        h('div', { class: 'small muted' }, [c.kind_label, c.sent_at ? ago(c.sent_at) : null, c.rep_time_s ? `${c.rep_time_s} s` : null, ready && c.timing?.contact_s ? `contact ${ms(c.timing.contact_s)}` : null, ready && c.timing?.step_length_m ? `${m2(c.timing.step_length_m)} a step` : null].filter(Boolean).join(' · '))),
      status);
  }));
  return h('div', { class: 'stack-tight' }, list, cmp ? h('div', { class: 'row' }, cmp) : null);
}
// Across the reps of each kind: each measure's average and range against the reference.
export function summaryBlock(summary) {
  const kinds = Object.entries(summary ?? {});
  if (!kinds.length) return null;
  return h('div', { class: 'stack' }, kinds.map(([, s]) => h('div', { class: 'stack-tight' },
    h('div', { class: 'strong' }, `${s.label}: across ${s.reps.length} ${s.reps.length === 1 ? 'rep' : 'reps'}`),
    s.positions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Position', 'Measure', 'Average', 'Range', 'Reference', 'Grade'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, s.positions.map((p) => h('tr', null, h('td', null, p.label), h('td', null, p.measure_label), h('td', { class: 'num' }, `${p.average}°`), h('td', { class: 'num' }, p.count > 1 ? `${p.low}–${p.high}°` : '—'), h('td', { class: 'num' }, `≈${p.target}°`), h('td', null, gradeChip(p.grade))))))) : h('p', { class: 'small muted', style: 'margin:0' }, 'No positions measured yet.'),
    s.consistent.length || s.varies.length ? h('p', { class: 'small', style: 'margin:0' }, s.consistent.length ? `Steady from rep to rep: ${s.consistent.join(', ')}. ` : '', s.varies.length ? `Changes most between reps: ${s.varies.join(', ')}.` : '') : null)));
}

// ---------- The athlete app's Sprint tab ----------
export function athleteSprint(where, { api }) {
  const state = { open: null, compare: null };
  const draw = async () => {
    if (state.open) { fill(where, await sprintViewer({ api, prefix: '/app/api', id: state.open, athlete: true, onBack: () => { state.open = null; draw(); } })); return; }
    if (state.compare) { fill(where, compareView({ api, prefix: '/app/api', ids: state.compare, onBack: () => { state.compare = null; draw(); } })); return; }
    fill(where, h('p', { class: 'muted' }, 'Loading…'));
    let d;
    try { d = await api('GET', '/app/api/sprint'); } catch (e) { fill(where, h('div', { class: 'empty' }, e.message)); return; }
    const send = d.ready ? uploadForm({ api, kinds: d.kinds, who: 'athlete', start: (b) => api('POST', '/app/api/sprint-clips', b), finish: (id) => api('POST', `/app/api/sprint-clips/${id}/done`), onSent: () => draw() })
      : h('p', { class: 'small muted', style: 'margin:0' }, 'Sending sprint clips isn\'t set up yet. Ask your coach.');
    fill(where, h('div', { class: 'stack' },
      h('div', { class: 'sp-card stack' }, h('h2', { class: 'eg-h' }, 'Send a rep'), h('p', { class: 'small muted', style: 'margin:0' }, 'Your coach marks each position, grades it and sends it back here.'), send),
      h('div', { class: 'sp-card stack' }, h('h2', { class: 'eg-h' }, 'Your reps'), clipList(d.data, { athlete: true, onOpen: (id) => { state.open = id; draw(); }, onCompare: (ids) => { state.compare = ids; draw(); } })),
      Object.keys(d.summary ?? {}).length ? h('div', { class: 'sp-card stack' }, h('h2', { class: 'eg-h' }, 'Across your reps'), summaryBlock(d.summary)) : null));
  };
  draw();
}

// ---------- The client page's Sprint tab ----------
export function clientSprintPanel(clientId, { api, onOpen }) {
  const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const draw = async () => {
    const d = await api('GET', `/v1/clients/${clientId}/sprint`);
    const refs = d.ready ? (await api('GET', '/v1/sprint/references')).kinds : [];
    fill(box, d.ready ? h('details', { class: 'dp-panel' }, h('summary', { class: 'strong' }, 'Add a clip'), uploadForm({ api, kinds: refs, who: 'staff', start: (b) => api('POST', `/v1/clients/${clientId}/sprint-clips`, b), finish: (id) => api('POST', `/v1/sprint-clips/${id}/done`), onSent: (c) => onOpen(c.id) }))
      : h('p', { class: 'small muted', style: 'margin:0' }, 'Sprint clips use the private clips bucket. Set it up in Settings → Backups & jobs (Form-check videos) to add clips.'),
    clipList(d.data, { onOpen, onCompare: (ids) => { location.hash = `#/sprint/compare?ids=${ids.join(',')}`; } }),
    summaryBlock(d.summary));
  };
  draw().catch((e) => fill(box, h('div', { class: 'empty' }, e.message)));
  return box;
}

// ---------- The coach's Sprint section (#/sprint) ----------
export async function viewSprintCoach(main, id, { api, header, role }) {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (id === 'compare') { fill(main, header('Compare reps', 'Line the same position up across reps or athletes.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sprint' }, 'Sprint')), compareView({ api, prefix: '/v1', ids: (q.get('ids') ?? '').split(',').filter(Boolean), title: false })); return; }
  if (id === 'references') return referencesView(main, { api, header, role });
  if (id) { fill(main, header('Sprint analysis', null, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sprint' }, 'All clips')), await sprintViewer({ api, prefix: '/v1', id, editable: true, onRemoved: () => { location.hash = '#/sprint'; } })); return; }
  const status = q.get('status') ?? 'waiting', kind = q.get('kind') ?? '';
  const [d, refs, athletes] = await Promise.all([api('GET', `/v1/sprint-clips?${new URLSearchParams({ ...(status !== 'all' ? { status } : {}), ...(kind ? { kind } : {}) })}`), api('GET', '/v1/sprint/references'), api('GET', '/v1/athletes')]);
  const go = (ch) => { const n = new URLSearchParams({ status, kind, ...ch }); for (const [k, val] of [...n]) if (!val) n.delete(k); location.hash = `#/sprint?${n}`; };
  const who = h('input', { class: 'dp-input', list: 'sp-athletes', placeholder: 'Start typing a name', autocomplete: 'off' });
  const dl = h('datalist', { id: 'sp-athletes' }, athletes.data.map((a) => h('option', { value: `${a.name}${a.athlete_id ? ` (${a.athlete_id})` : ''}` })));
  const pickId = () => { const a = athletes.data.find((x) => `${x.name}${x.athlete_id ? ` (${x.athlete_id})` : ''}` === who.value.trim()); if (!a) throw new Error('Pick the athlete from the list first.'); return a.client_id; };
  let chosen = null;
  const add = d.ready ? h('details', { class: 'dp-panel' }, h('summary', { class: 'strong' }, 'Add a clip for an athlete'),
    h('div', { class: 'stack' }, field('Athlete', h('div', null, who, dl)),
      uploadForm({ api, kinds: refs.kinds, who: 'staff', start: (b) => { chosen = pickId(); return api('POST', `/v1/clients/${chosen}/sprint-clips`, b); }, finish: (cid) => api('POST', `/v1/sprint-clips/${cid}/done`), onSent: (c) => { location.hash = `#/sprint/${c.id}`; } })))
    : h('div', { class: 'test-banner' }, 'Sprint clips go to the private clips bucket. Set it up first: Settings → Backups & jobs → Form-check videos.');
  fill(main, header('Sprint', 'Clips of top speed, acceleration and change of direction. Mark the positions, see the angles and timing, send it back.',
    h('div', { class: 'row wrap', style: 'gap:8px' }, h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sprint/references' }, 'References'))),
    add,
    h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' },
      ...[['waiting', `To review${d.waiting ? ` (${d.waiting})` : ''}`], ['reviewed', 'Sent'], ['all', 'All']].map(([k, label]) => h('button', { type: 'button', class: 'sp-pos', 'aria-pressed': status === k ? 'true' : 'false', onClick: () => go({ status: k }) }, label)),
      h('span', { class: 'grow' }),
      select([['', 'Every kind'], ...Object.entries(KIND_LABEL)], { value: kind, 'aria-label': 'Kind', onChange: (e) => go({ kind: e.target.value }) })),
    clipList(d.data, { showName: true, onOpen: (cid) => { location.hash = `#/sprint/${cid}`; }, onCompare: (ids) => { location.hash = `#/sprint/compare?ids=${ids.join(',')}`; } }));
}

// ---------- References (owner edits; coaches read) ----------
async function referencesView(main, { api, header, role }) {
  const r = await api('GET', '/v1/sprint/references');
  const owner = role === 'owner';
  const inputs = [];
  const sections = r.kinds.map((k) => h('div', { class: 'dp-panel stack-tight' }, h('h3', { class: 'dp-panel-title' }, k.label), h('p', { class: 'small muted', style: 'margin:0' }, k.tip),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Position', 'Measure', 'Target (°)', 'A within ±', 'B within ±'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, k.positions.flatMap((p) => p.measures.map((m) => {
        const cell = (key) => { if (!owner) return String(m[key]); const el = input({ type: 'number', step: '0.5', value: m[key], style: 'width:90px', 'aria-label': `${k.label}, ${p.label}, ${m.label}, ${key}` }); inputs.push({ kind: k.key, pos: p.key, measure: m.measure, key, el }); return el; };
        return h('tr', null, h('td', null, p.label), h('td', null, m.label), h('td', null, cell('target')), h('td', null, cell('a')), h('td', null, cell('b')));
      })))))));
  const save = (e) => busy(e.currentTarget, async () => {
    const refs = {};
    for (const x of inputs) {
      refs[x.kind] ??= {}; refs[x.kind][x.pos] ??= [];
      let row = refs[x.kind][x.pos].find((y) => y.measure === x.measure);
      if (!row) { row = { measure: x.measure }; refs[x.kind][x.pos].push(row); }
      row[x.key] = Number(x.el.value);
    }
    await api('PATCH', '/v1/sprint/references', { references: refs }); toast('References saved. Every clip is graded against them now.');
  });
  fill(main, header('Sprint references', 'What each position is graded against: A within the first band of the target, B within the second, C beyond.', h('a', { class: 'dp-btn dp-btn--secondary', href: '#/sprint' }, 'Sprint')),
    h('p', { class: 'small muted' }, r.customized ? 'These are your references.' : 'These are starting values. Replace them with your own numbers.', ' The positions follow the kinogram method ALTIS teaches.'),
    ...sections,
    owner ? h('div', { class: 'row wrap', style: 'gap:8px' }, btn('Save the references', save, 'primary'), btn('Back to the starting values', (e) => { if (confirm('Put every reference back to the starting values?')) busy(e.currentTarget, async () => { await api('PATCH', '/v1/sprint/references', { reset: true }); toast('Back to the starting values.'); referencesView(main, { api, header, role }); }); }, 'ghost'))
      : h('p', { class: 'small muted' }, 'The owner changes these.'));
}
