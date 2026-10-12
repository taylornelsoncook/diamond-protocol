import { h, fill, toast, btn } from './ui.js';

// The team feed (the builder redesign, step 6): one block for the dashboard (Today, with Post for owners and coaches
// and hide/unhide on comments), the athlete app (the Workout tab's Team feed card) and the parent portal (Home).
// api: { get(path), post(path, body), del(path) } with paths under the caller's base (dashboard '/v1/feed',
// app '/app/api/feed', portal 'feed'). Options: staff (comments show hidden ones, with Hide/Show and Remove post),
// compose (a Post button opening the caller's dialog), limit, title.
const when = (iso) => {
  const d = new Date(iso), now = new Date();
  const h24 = (now - d) / 36e5;
  if (h24 < 1) return 'just now';
  if (h24 < 24) return `${Math.round(h24)} h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
};
const paragraphs = (text) => String(text ?? '').split(/\n{2,}/).map((p) => h('p', { style: 'margin:0;white-space:pre-line' }, p));

export function feedBlock(api, { staff = false, canPost = false, onPost = null, onEdit = null, limit = 10, empty = 'Nothing posted yet.', compact = false } = {}) {
  const state = { items: [], next: null };
  const list = h('div', { class: 'fd-list' });
  const foot = h('div', { class: 'row', style: 'justify-content:center' });
  const el = h('div', { class: 'fd stack', style: 'gap:12px' }, canPost && onPost ? h('div', { class: 'row' }, btn('Post to the feed', () => onPost(load), 'primary')) : null, list, foot);
  const q = (before) => `?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;

  const commentRow = (p, c) => h('div', { class: `fd-comment${c.hidden ? ' fd-comment--hidden' : ''}` },
    h('div', { class: 'grow', style: 'min-width:0' }, h('span', { class: 'strong small' }, c.author_name), h('span', { class: 'small muted' }, ` · ${when(c.created_at)}${c.hidden ? ` · hidden by ${c.hidden_by}` : ''}`), h('div', { class: 'small', style: 'white-space:pre-line' }, c.body)),
    staff ? btn(c.hidden ? 'Show' : 'Hide', (e) => act(e, async () => { if (c.hidden) await api.post(`/comments/${c.id}/unhide`, {}); else await api.del(`/comments/${c.id}`); await load(); }), 'ghost', { style: 'min-height:32px;padding:0 8px' })
      : c.mine ? btn('Take back', (e) => act(e, async () => { await api.del(`/comments/${c.id}`); await load(); }), 'ghost', { style: 'min-height:32px;padding:0 8px' }) : null);
  const act = async (e, fn) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (x) { toast(x.message, 'warn'); } finally { b.disabled = false; } };
  const post = (p) => {
    const bump = h('button', { type: 'button', class: `fd-bump${p.bumped ? ' is-on' : ''}`, 'aria-pressed': String(p.bumped), 'aria-label': `Fist bump (${p.bumps})`, onClick: (e) => act(e, async () => {
      const r = await api.post(`/${p.id}/react`, {}); p.bumped = r.bumped; p.bumps = r.bumps; bump.classList.toggle('is-on', r.bumped); bump.setAttribute('aria-pressed', String(r.bumped)); count.textContent = String(r.bumps);
    }) }, '👊 ', h('span', { class: 'fd-count' }, String(p.bumps)));
    const count = bump.querySelector('.fd-count');
    const comments = h('div', { class: 'fd-comments' }, p.comments.map((c) => commentRow(p, c)));
    const box = h('textarea', { class: 'dp-input', rows: '1', placeholder: p.comments_open || staff ? 'Write a comment' : 'Comments are closed', 'aria-label': 'Your comment', disabled: !(p.comments_open || staff) });
    const send = btn('Send', (e) => act(e, async () => {
      const body = box.value.trim(); if (!body) return;
      const c = await api.post(`/${p.id}/comments`, { body }); box.value = ''; p.comments.push(c); comments.append(commentRow(p, c)); p.comment_count += 1; summary.textContent = `${p.comment_count} ${p.comment_count === 1 ? 'comment' : 'comments'}`;
    }), 'secondary', { style: 'min-height:40px' });
    const summary = h('summary', { class: 'small muted' }, `${p.comment_count} ${p.comment_count === 1 ? 'comment' : 'comments'}`);
    const open = h('details', { class: 'fd-thread', open: !compact && p.comments.length > 0 ? true : null }, summary,
      comments, p.comments_open || staff ? h('div', { class: 'row', style: 'align-items:flex-start' }, box, send) : h('p', { class: 'small muted', style: 'margin:0' }, 'Comments are closed on this post.'));
    return h('article', { class: `fd-post${p.pinned ? ' fd-post--pinned' : ''}` },
      h('div', { class: 'row wrap small muted', style: 'gap:6px' }, p.pinned ? h('span', { class: 'dp-badge dp-badge--good' }, 'Pinned') : null, h('span', { class: 'strong', style: 'color:var(--steel)' }, p.author_name), h('span', null, `· ${p.audience_label} · ${when(p.created_at)}`),
        staff && onEdit ? h('span', { class: 'grow', style: 'text-align:right' }, btn('Edit', () => onEdit(p, load), 'ghost', { style: 'min-height:32px;padding:0 8px' })) : null),
      p.title ? h('h3', { class: 'fd-title' }, p.title) : null,
      h('div', { class: 'fd-body stack-tight' }, paragraphs(p.body)),
      p.link_url ? h('a', { class: 'small', href: p.link_url, target: '_blank', rel: 'noopener' }, p.link_url.replace(/^https:\/\//, '').slice(0, 60)) : null,
      h('div', { class: 'row wrap', style: 'gap:10px;align-items:center' }, bump, open));
  };
  const draw = () => {
    fill(list, state.items.length ? state.items.map(post) : h('p', { class: 'muted small', style: 'margin:0' }, empty));
    fill(foot, state.next ? btn('Older posts', (e) => act(e, more), 'ghost') : null);
  };
  async function load() {
    try { const r = await api.get(q()); state.items = r.data; state.next = r.next; draw(); }
    catch (e) { fill(list, h('p', { class: 'warn-text small' }, e.message || 'Couldn\'t load the feed.')); }
  }
  async function more() { const r = await api.get(q(state.next)); state.items = state.items.concat(r.data); state.next = r.next; draw(); }
  load();
  el.reload = load;
  return el;
}
