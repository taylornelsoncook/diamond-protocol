// Linked wearables (WHOOP, Oura): the block under Recovery & sleep on the client page and the portal's Progress tab.
// opts: { list: () => api GET, connect: (provider) => api POST returning { url }, disconnect: (id) => api DELETE, sync?: (id) => api POST,
//         first (the athlete's first name), canConnect, afterChange }
import { h, fill, btn, busy, toast, ago } from './ui.js';

const STATUS = { active: ['Connected', 'good-text'], needs_reconnect: ['Needs reconnecting', 'warn-text'] };
export function wearablesBlock(opts) {
  const box = h('div', { class: 'stack-tight' });
  const draw = async () => {
    let d;
    try { d = await opts.list(); } catch (e) { return fill(box, h('p', { class: 'small muted' }, e.message)); }
    const linked = d.data ?? [], providers = d.providers ?? [];
    const rows = linked.map((w) => {
      const [word, cls] = STATUS[w.status] ?? [w.status, 'muted'];
      return h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' },
        h('div', { class: 'grow stack-tight', style: 'min-width:200px' }, h('span', { class: 'strong' }, w.label),
          h('span', { class: `small ${cls}` }, `${word}${w.last_sync_at ? ` · last pulled ${ago(w.last_sync_at).toLowerCase()}` : ' · nothing pulled yet'}`),
          w.status === 'needs_reconnect' ? h('span', { class: 'small muted' }, `${w.label} stopped accepting our access${w.last_error ? ` (${w.last_error})` : ''}. Connect it again below.`) : null),
        opts.sync && w.status === 'active' ? btn('Pull now', (e) => busy(e.currentTarget, async () => { const r = await opts.sync(w.id); toast(r.needs_reconnect ? `${w.label} needs reconnecting.` : `Pulled ${r.days ?? 0} ${r.days === 1 ? 'day' : 'days'} from ${w.label}.`); draw(); opts.afterChange?.(); }), 'ghost') : null,
        btn('Disconnect', (e) => { if (!confirm(`Disconnect ${w.label}? What's already on file stays.`)) return; busy(e.currentTarget, async () => { await opts.disconnect(w.id); toast(`${w.label} disconnected.`); draw(); opts.afterChange?.(); }); }, 'ghost'));
    });
    const linkedKeys = new Set(linked.filter((w) => w.status === 'active').map((w) => w.provider));
    const connectable = providers.filter((p) => !linkedKeys.has(p.key));
    const connectBtns = opts.canConnect && connectable.length ? h('div', { class: 'row wrap', style: 'gap:8px;align-items:center' },
      connectable.map((p) => btn(`Connect ${p.label}`, (e) => busy(e.currentTarget, async () => {
        const r = await opts.connect(p.key);
        toast(`Opening ${p.label}'s sign-in. Sign in with ${opts.first}'s ${p.label} account and allow access.`);
        location.href = r.url;
      }), linked.length ? 'ghost' : 'secondary')),
      h('span', { class: 'small muted' }, `Sign in with ${opts.first}'s ${connectable.map((p) => p.label).join(' or ')} account; the password stays with them. Recovery, sleep, strain and workouts then arrive on their own, a few times a day.`)) : null;
    fill(box, rows.length ? rows : null,
      !rows.length && !connectable.length ? h('p', { class: 'small muted', style: 'margin:0' }, providers.length ? '' : 'No wearable is set up for connecting yet.') : null,
      connectBtns);
  };
  draw();
  return { el: box, draw };
}
// After the provider sends the parent or coach back: a toast saying how it went, from ?wearable= in the address.
export function wearableReturnNotice() {
  const q = new URLSearchParams(location.search);
  const what = q.get('wearable');
  if (!what) return;
  const label = { whoop: 'WHOOP', oura: 'Oura' }[q.get('provider')] ?? 'The wearable';
  const msg = { connected: `${label} is connected. The first pull is running; check back in a minute.`, denied: `${label} wasn't connected: access was declined.`, expired: 'That sign-in link expired. Press Connect again.', error: `${label} couldn't be connected. Try again in a minute.` }[what];
  if (msg) toast(msg, what === 'connected' ? 'good' : 'warn');
  history.replaceState(null, '', location.pathname + location.hash);
}
