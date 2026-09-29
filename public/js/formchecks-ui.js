// Form checks: the shared pieces for the athlete app (send a clip, read the answer), the client page (watch, answer,
// add a clip) and the parent portal (watch, remove). The clip goes from the phone straight to the private bucket with
// the one-time address the server hands out, so nothing big passes through the app's server.
// opts for formChecksBlock: { list: () => api GET → { data }, play: (id, which) => api GET → { url }, who: 'athlete' | 'staff' | 'parent',
//   first (the athlete's first name), reply?: (id, text) => api POST, replyVideo?: { start: (id, body) => api, finish: (id) => api },
//   remove?: (id) => api DELETE, seen?: (id) => api POST, afterChange?, empty (text when nothing is there) }
import { h, fill, btn, busy, toast, ago } from './ui.js';

export const CLIP_TYPES = 'video/mp4,video/quicktime,video/webm,video/x-m4v,video/*';
const mb = (n) => `${Math.max(1, Math.round((n ?? 0) / 1024 / 1024))} MB`;
const secs = (s) => (s == null ? '' : `${Math.round(s)} sec`);

// How long the clip is, from the file itself (the browser reads the header). null when it can't tell.
export function clipDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video'), url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}
// PUT the file to the signed address with progress (0 to 1). Resolves when the store has it.
export function putClip(upload, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method ?? 'PUT', upload.url);
    for (const [k, val] of Object.entries(upload.headers ?? {})) xhr.setRequestHeader(k, val);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`The upload was refused (${xhr.status}). Try again.`)));
    xhr.onerror = () => reject(new Error('The upload didn\'t go through. Check your signal and try again.'));
    xhr.onabort = () => reject(new Error('The upload was stopped.'));
    xhr.send(file);
  });
}
// The whole send: ask for an address, upload, then tell the server it's there. start(body) and finish(id) are the API calls.
export async function sendClip({ file, start, finish, extra = {}, onProgress }) {
  if (!file) throw new Error('Choose a video first.');
  if (!/^video\//.test(file.type || '')) throw new Error('Send a video from your phone (MP4, MOV or WebM).');
  const duration = await clipDuration(file);
  const s = await start({ content_type: file.type, bytes: file.size, duration_s: duration, ...extra });
  onProgress?.(0);
  await putClip(s.upload, file, onProgress);
  return finish(s.id);
}
// A file picker for one video and a progress line; onFile(file, progress) does the sending.
export function clipPicker(label, onFile, { variant = 'secondary', capture = false } = {}) {
  const input = h('input', { type: 'file', accept: CLIP_TYPES, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', ...(capture ? { capture: 'environment' } : {}) });
  const bar = h('div', { class: 'fc-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, h('div', { style: 'width:0%' }));
  const word = h('span', { class: 'small muted', hidden: true });
  const button = btn(label, () => input.click(), variant);
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    bar.hidden = false; word.hidden = false; word.textContent = `Sending ${mb(file.size)}…`;
    const progress = (p) => { const pct = Math.round(p * 100); bar.firstChild.style.width = `${pct}%`; bar.setAttribute('aria-valuenow', String(pct)); word.textContent = pct >= 100 ? 'Checking the clip…' : `Sending ${mb(file.size)}… ${pct}%`; };
    await busy(button, async () => { try { await onFile(file, progress); } finally { bar.hidden = true; word.hidden = true; bar.firstChild.style.width = '0%'; } });
  });
  return h('div', { class: 'stack-tight' }, h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' }, button, word), bar, input);
}

const STATUS = { sent: ['Waiting for your coach', 'muted'], answered: ['Answered', 'good-text'] };
export function formChecksBlock(opts) {
  const box = h('div', { class: 'stack' });
  const player = (fc, which, holder) => async (e) => busy(e.currentTarget, async () => {
    const p = await opts.play(fc.id, which);
    fill(holder, h('div', { class: 'video-frame' }, h('video', { src: p.url, controls: true, playsinline: true, autoplay: true, preload: 'metadata', 'aria-label': `${which === 'reply' ? 'The coach\'s clip for' : 'Form check clip,'} ${fc.exercise_name}` })),
      h('p', { class: 'small muted', style: 'margin:0' }, 'This link plays for 10 minutes. Press Play again for a new one.'));
    if (which === 'reply' && opts.who === 'athlete' && opts.seen && !fc.seen_by_athlete_at) { try { await opts.seen(fc.id); } catch { /* not essential */ } }
  });
  const draw = async () => {
    let d;
    try { d = await opts.list(); } catch (e) { return fill(box, h('p', { class: 'small muted' }, e.message)); }
    const list = d.data ?? [];
    if (!list.length) return fill(box, opts.empty ? h('p', { class: 'small muted', style: 'margin:0' }, opts.empty) : null);
    fill(box, list.map((fc) => {
      const [word, cls] = STATUS[fc.status] ?? [fc.status, 'muted'];
      const clipHolder = h('div', { class: 'stack-tight' }), replyHolder = h('div', { class: 'stack-tight' }), replyBox = h('div', { class: 'stack-tight' });
      const answered = fc.status === 'answered';
      const head = h('div', { class: 'row wrap', style: 'gap:8px;align-items:flex-start' },
        h('div', { class: 'grow stack-tight', style: 'min-width:200px' },
          h('span', { class: 'strong' }, opts.who === 'staff' && fc.client_name ? `${fc.client_name} · ${fc.exercise_name}` : fc.exercise_name),
          h('span', { class: 'small muted' }, [fc.workout_title, fc.sent_at ? `sent ${ago(fc.sent_at).toLowerCase()}` : null, secs(fc.duration_s), mb(fc.bytes), `kept ${fc.days_left} more ${fc.days_left === 1 ? 'day' : 'days'}`].filter(Boolean).join(' · ')),
          fc.note ? h('p', { class: 'small', style: 'margin:0;white-space:pre-wrap' }, `${opts.who === 'athlete' ? 'You wrote' : first(fc, opts) + ' wrote'}: ${fc.note}`) : null,
          h('span', { class: `small ${cls}` }, opts.who === 'staff' && fc.status === 'sent' ? 'Waiting for an answer' : opts.who === 'parent' && fc.status === 'sent' ? 'Waiting for the coach' : word)),
        h('div', { class: 'row wrap', style: 'gap:6px' },
          btn('Play', player(fc, 'clip', clipHolder), 'outline'),
          opts.remove ? btn('Remove', (e) => { if (!confirm(`Remove this ${fc.exercise_name} clip${answered ? ' and the coach\'s answer' : ''}? It can't be brought back.`)) return; busy(e.currentTarget, async () => { await opts.remove(fc.id); toast('Removed.'); draw(); opts.afterChange?.(); }); }, 'ghost') : null));
      // The answer: the coach's note and clip; on the client page, a box to write one.
      if (answered) {
        replyBox.append(h('div', { class: 'fc-note stack-tight' },
          h('span', { class: 'small strong' }, `${fc.coach_name ?? 'Your coach'} answered ${fc.answered_at ? ago(fc.answered_at).toLowerCase() : ''}`),
          fc.reply ? h('p', { style: 'margin:0;white-space:pre-wrap' }, fc.reply) : null,
          fc.has_reply_video ? h('div', { class: 'row wrap', style: 'gap:8px' }, btn('Play the coach\'s clip', player(fc, 'reply', replyHolder), 'outline')) : null, replyHolder));
      }
      if (opts.who === 'staff' && (opts.reply || opts.replyVideo)) {
        const text = h('textarea', { class: 'dp-input', rows: '3', maxlength: '1000', placeholder: answered ? 'Add to your answer…' : 'What you saw and what to change. The athlete gets it as a message too.', 'aria-label': `Your answer on ${fc.exercise_name}` });
        replyBox.append(h('div', { class: 'stack-tight' }, text, h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' },
          opts.reply ? btn(answered ? 'Send another note' : 'Send the answer', (e) => busy(e.currentTarget, async () => { await opts.reply(fc.id, text.value); toast(`Sent to ${first(fc, opts)}.`); draw(); opts.afterChange?.(); }), 'primary') : null,
          opts.replyVideo ? clipPicker(fc.has_reply_video ? 'Replace your clip' : 'Add a clip of your own', async (file, progress) => {
            await sendClip({ file, start: (b) => opts.replyVideo.start(fc.id, b), finish: () => opts.replyVideo.finish(fc.id), onProgress: progress });
            toast(`Your clip is on ${first(fc, opts)}'s form check.`); draw(); opts.afterChange?.();
          }, { variant: 'ghost' }) : null)));
      }
      return h('div', { class: 'stack-tight', style: 'padding:10px 0;border-top:1px solid var(--line-subtle)' }, head, clipHolder, replyBox);
    }));
  };
  draw();
  return { el: box, draw };
}
const first = (fc, opts) => (fc.client_name ?? opts.first ?? 'the athlete').split(' ')[0];
