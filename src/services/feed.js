import { newId, v, notFound, conflict, badRequest } from '../util.js';
import { emit } from './events.js';
import { notify } from './push.js';

// The team feed (the builder redesign, step 6, from the owner's TeamBuildr screenshot): coaches post to everyone, a
// team or a program; a post can be pinned for a period (first in the feed, and on the weight-room screen while it
// is pinned); athletes and parents give a fist bump and comment; coaches hide comments and close a post's comments.
// Who sees a post: everyone = every current athlete and their family; a team = its active roster; a program = the
// athletes on it. Staff see every post. Nothing here carries money.
export const AUDIENCES = ['everyone', 'team', 'program'];
export const MAX_PIN_DAYS = 90;
const asBool = (x, dflt) => (x === undefined || x === null ? dflt : x === true || x === 1 || x === 'true' || x === '1');

function postFields(ctx, body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) out.title = v.str(body.title, 'title', { max: 120, optional: true });
  if (!partial || body.body !== undefined) out.body = v.str(body.body, 'body', { max: 2000 });
  if (!partial || body.link_url !== undefined) out.link_url = v.url(body.link_url, 'link_url', { optional: true });
  if (body.pin_days !== undefined && body.pin_days !== null) {
    const days = v.int(body.pin_days, 'pin_days', { min: 0, max: MAX_PIN_DAYS });
    out.pinned_until = days ? new Date(Date.parse(ctx.now()) + days * 86400000).toISOString() : null;
  } else if (body.pinned_until !== undefined) {
    out.pinned_until = body.pinned_until === null ? null : v.date(body.pinned_until, 'pinned_until');
  }
  if (!partial || body.on_screen !== undefined) out.on_screen = asBool(body.on_screen, true) ? 1 : 0;
  if (!partial || body.comments_open !== undefined) out.comments_open = asBool(body.comments_open, true) ? 1 : 0;
  return out;
}
function audienceOf(ctx, body) {
  const audience = v.oneOf(body.audience ?? 'everyone', 'audience', AUDIENCES);
  let contract_id = null, program_id = null;
  if (audience === 'team') {
    contract_id = v.str(body.contract_id, 'contract_id');
    if (!ctx.db.get(`SELECT id FROM team_contracts WHERE id = ? AND status = 'active'`, contract_id)) throw badRequest('Pick an active team.');
  } else if (audience === 'program') {
    program_id = v.str(body.program_id, 'program_id');
    const p = ctx.db.get('SELECT id, kind FROM programs WHERE id = ?', program_id);
    if (!p || p.kind !== 'program') throw badRequest('Pick a program (not a template).');
  }
  return { audience, contract_id, program_id };
}
export function createPost(ctx, body = {}, user) {
  const who = audienceOf(ctx, body), f = postFields(ctx, body);
  const id = newId('fp'), now = ctx.now();
  ctx.db.run('INSERT INTO feed_posts (id, audience, contract_id, program_id, author_id, author_name, title, body, link_url, pinned_until, on_screen, comments_open, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, who.audience, who.contract_id, who.program_id, user.id, user.name, f.title, f.body, f.link_url, f.pinned_until, f.on_screen, f.comments_open, now);
  const post = getPost(ctx, id, { staff: true });
  emit(ctx, 'feed.posted', { post_id: id, audience: who.audience, contract_id: who.contract_id, program_id: who.program_id, title: f.title, author_name: user.name, pinned_until: f.pinned_until });
  // A tap on the phone for everyone the post reaches (nothing personal travels: the notice is fetched by the app).
  for (const cid of audienceClients(ctx, post)) notify(ctx, cid, { title: f.title ? `${user.name}: ${f.title}` : `New post from ${user.name}`, body: f.body.slice(0, 140), url: '/app#feed', kind: 'feed' });
  return post;
}
export function updatePost(ctx, id, body = {}, user) {
  const row = ctx.db.get('SELECT * FROM feed_posts WHERE id = ?', id);
  if (!row) throw notFound('Post');
  const f = postFields(ctx, body, { partial: true });
  const sets = Object.keys(f);
  if (!sets.length) throw badRequest('Nothing to change.');
  ctx.db.run(`UPDATE feed_posts SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...sets.map((k) => f[k]), ctx.now(), id);
  return getPost(ctx, id, { staff: true });
}
export function deletePost(ctx, id) {
  if (!ctx.db.get('SELECT id FROM feed_posts WHERE id = ?', id)) throw notFound('Post');
  ctx.db.run('DELETE FROM feed_posts WHERE id = ?', id);
  return { deleted: true };
}

// ---------- Who a post reaches ----------
export function audienceClients(ctx, post) {
  if (post.audience === 'team') return ctx.db.all(`SELECT r.client_id AS id FROM team_roster r JOIN clients c ON c.id = r.client_id WHERE r.contract_id = ? AND r.active = 1 AND c.archived_at IS NULL`, post.contract_id).map((x) => x.id);
  if (post.audience === 'program') return ctx.db.all(`SELECT a.client_id AS id FROM assignments a JOIN clients c ON c.id = a.client_id WHERE a.program_id = ? AND a.active = 1 AND c.archived_at IS NULL`, post.program_id).map((x) => x.id);
  return ctx.db.all(`SELECT id FROM clients WHERE archived_at IS NULL`).map((x) => x.id);
}
// The feed one athlete sees: posts to everyone, to a team they're on, or to a program they're on.
const scopeFor = (ctx, clientIds) => {
  if (!clientIds.length) return { where: "p.audience = 'everyone'", args: [] };
  const marks = clientIds.map(() => '?').join(', ');
  return { where: `(p.audience = 'everyone' OR (p.audience = 'team' AND p.contract_id IN (SELECT contract_id FROM team_roster WHERE client_id IN (${marks}) AND active = 1)) OR (p.audience = 'program' AND p.program_id IN (SELECT program_id FROM assignments WHERE client_id IN (${marks}) AND active = 1)))`, args: [...clientIds, ...clientIds] };
};
const familyClients = (ctx, familyId) => ctx.db.all('SELECT id FROM clients WHERE family_id = ? AND archived_at IS NULL', familyId).map((x) => x.id);

// ---------- Reading ----------
const SELECT = `SELECT p.*, t.name AS team_name, o.name AS org_name, pr.name AS program_name,
  (SELECT COUNT(*) FROM feed_reactions x WHERE x.post_id = p.id) AS bumps,
  (SELECT COUNT(*) FROM feed_comments c WHERE c.post_id = p.id AND c.hidden_at IS NULL) AS comment_count
  FROM feed_posts p LEFT JOIN team_contracts t ON t.id = p.contract_id LEFT JOIN organizations o ON o.id = t.org_id LEFT JOIN programs pr ON pr.id = p.program_id`;
const whoKey = (viewer) => (viewer?.client_id ? `client:${viewer.client_id}` : viewer?.guardian_id ? `guardian:${viewer.guardian_id}` : viewer?.user_id ? `user:${viewer.user_id}` : null);
function shape(ctx, p, { staff = false, viewer = null, withComments = true } = {}) {
  const now = ctx.now();
  const key = whoKey(viewer);
  const comments = withComments ? ctx.db.all(`SELECT id, by_kind, client_id, guardian_id, user_id, author_name, body, created_at, hidden_at, hidden_by FROM feed_comments WHERE post_id = ? ${staff ? '' : 'AND hidden_at IS NULL'} ORDER BY created_at`, p.id)
    .map((c) => ({ id: c.id, by_kind: c.by_kind, author_name: c.author_name, body: c.body, created_at: c.created_at, hidden: !!c.hidden_at, hidden_by: c.hidden_by ?? null,
      mine: !!(viewer && ((viewer.client_id && c.client_id === viewer.client_id) || (viewer.guardian_id && c.guardian_id === viewer.guardian_id) || (viewer.user_id && c.user_id === viewer.user_id))) })) : [];
  return { id: p.id, audience: p.audience, contract_id: p.contract_id, program_id: p.program_id,
    audience_label: p.audience === 'team' ? `${p.org_name} ${p.team_name}` : p.audience === 'program' ? p.program_name : 'Everyone',
    author_id: staff ? p.author_id : undefined, author_name: p.author_name, title: p.title, body: p.body, link_url: p.link_url,
    pinned: !!p.pinned_until && p.pinned_until > now, pinned_until: p.pinned_until, on_screen: !!p.on_screen, comments_open: !!p.comments_open,
    bumps: p.bumps, bumped: key ? !!ctx.db.get('SELECT 1 FROM feed_reactions WHERE post_id = ? AND who = ?', p.id, key) : false,
    comment_count: p.comment_count, comments, created_at: p.created_at, updated_at: p.updated_at };
}
function listWhere(ctx, { where, args }, { audience, contract_id, program_id, before, limit }) {
  const w = [where], a = [...args];
  if (audience) { w.push('p.audience = ?'); a.push(v.oneOf(audience, 'audience', AUDIENCES)); }
  if (contract_id) { w.push('p.contract_id = ?'); a.push(contract_id); }
  if (program_id) { w.push('p.program_id = ?'); a.push(program_id); }
  if (before) { w.push('p.created_at < ?'); a.push(String(before)); }
  const n = Math.min(100, Math.max(1, Number(limit) || 20));
  // Pinned posts first (newest pin first), then the rest newest first.
  const rows = ctx.db.all(`${SELECT} WHERE ${w.join(' AND ')} ORDER BY CASE WHEN p.pinned_until > ? THEN 0 ELSE 1 END, p.created_at DESC LIMIT ?`, ...a, ctx.now(), n + 1);
  return { rows: rows.slice(0, n), next: rows.length > n ? rows[n - 1].created_at : null };
}
export function listForStaff(ctx, q = {}, user = null) {
  const { rows, next } = listWhere(ctx, { where: '1 = 1', args: [] }, q);
  return { data: rows.map((p) => shape(ctx, p, { staff: true, viewer: user ? { user_id: user.id } : null })), next };
}
export function listForClient(ctx, client, q = {}) {
  const { rows, next } = listWhere(ctx, scopeFor(ctx, [client.id]), q);
  return { data: rows.map((p) => shape(ctx, p, { viewer: { client_id: client.id } })), next };
}
export function listForFamily(ctx, guardian, q = {}) {
  const { rows, next } = listWhere(ctx, scopeFor(ctx, familyClients(ctx, guardian.family_id)), q);
  return { data: rows.map((p) => shape(ctx, p, { viewer: { guardian_id: guardian.id } })), next };
}
export function getPost(ctx, id, opts = {}) {
  const p = ctx.db.get(`${SELECT} WHERE p.id = ?`, id);
  if (!p) throw notFound('Post');
  return shape(ctx, p, opts);
}
// May this athlete (or family) see the post?
function visibleTo(ctx, id, clientIds) {
  const { where, args } = scopeFor(ctx, clientIds);
  return !!ctx.db.get(`SELECT p.id FROM feed_posts p WHERE p.id = ? AND ${where}`, id, ...args);
}
const reach = (ctx, id, viewer) => {
  if (!ctx.db.get('SELECT id FROM feed_posts WHERE id = ?', id)) throw notFound('Post');
  if (viewer.user_id) return;
  const ids = viewer.client_id ? [viewer.client_id] : familyClients(ctx, viewer.family_id);
  if (!visibleTo(ctx, id, ids)) throw notFound('Post');
};

// ---------- Fist bumps and comments ----------
// viewer: { client_id } (the app), { guardian_id, family_id, name } (the portal) or { user_id, name } (staff).
export function react(ctx, id, viewer, on = null) {
  reach(ctx, id, viewer);
  const key = whoKey(viewer);
  const had = !!ctx.db.get('SELECT 1 FROM feed_reactions WHERE post_id = ? AND who = ?', id, key);
  const want = on === null || on === undefined ? !had : asBool(on, true);
  if (want && !had) ctx.db.run('INSERT INTO feed_reactions (post_id, who, client_id, guardian_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, key, viewer.client_id ?? null, viewer.guardian_id ?? null, viewer.user_id ?? null, ctx.now());
  if (!want && had) ctx.db.run('DELETE FROM feed_reactions WHERE post_id = ? AND who = ?', id, key);
  return { bumped: want, bumps: ctx.db.get('SELECT COUNT(*) AS n FROM feed_reactions WHERE post_id = ?', id).n };
}
export function comment(ctx, id, viewer, body = {}) {
  reach(ctx, id, viewer);
  const post = ctx.db.get('SELECT comments_open FROM feed_posts WHERE id = ?', id);
  if (!post.comments_open && !viewer.user_id) throw conflict('Comments are closed on this post.');
  const text = v.str(body.body, 'body', { max: 1000 });
  const cid = newId('fc');
  const kind = viewer.client_id ? 'athlete' : viewer.guardian_id ? 'parent' : 'staff';
  ctx.db.run('INSERT INTO feed_comments (id, post_id, by_kind, client_id, guardian_id, user_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    cid, id, kind, viewer.client_id ?? null, viewer.guardian_id ?? null, viewer.user_id ?? null, String(viewer.name ?? (kind === 'athlete' ? 'Athlete' : kind === 'parent' ? 'Parent' : 'Coach')).slice(0, 80), text, ctx.now());
  return { id: cid, post_id: id, by_kind: kind, author_name: viewer.name, body: text, created_at: ctx.now(), mine: true, hidden: false };
}
// An athlete or parent takes back their own comment; a coach hides anyone's (kept for the record, shown to staff).
export function removeComment(ctx, cid, viewer) {
  const c = ctx.db.get('SELECT * FROM feed_comments WHERE id = ?', cid);
  if (!c) throw notFound('Comment');
  if (viewer.user_id) { ctx.db.run('UPDATE feed_comments SET hidden_at = ?, hidden_by = ? WHERE id = ?', ctx.now(), viewer.name ?? 'a coach', cid); return { hidden: true }; }
  const mine = (viewer.client_id && c.client_id === viewer.client_id) || (viewer.guardian_id && c.guardian_id === viewer.guardian_id);
  if (!mine) throw notFound('Comment');
  ctx.db.run('DELETE FROM feed_comments WHERE id = ?', cid);
  return { deleted: true };
}
export function unhideComment(ctx, cid) {
  if (!ctx.db.get('SELECT id FROM feed_comments WHERE id = ?', cid)) throw notFound('Comment');
  ctx.db.run('UPDATE feed_comments SET hidden_at = NULL, hidden_by = NULL WHERE id = ?', cid);
  return { hidden: false };
}

// ---------- The weight-room screen ----------
// Pinned posts marked for the screen: to everyone, and to any team with a session open at this location right now.
export function forScreen(ctx, sessions = []) {
  const contracts = sessions.map((s) => s.series_id && ctx.db.get('SELECT contract_id FROM class_series WHERE id = ?', s.series_id)?.contract_id).filter(Boolean);
  const marks = contracts.map(() => '?').join(', ');
  const rows = ctx.db.all(`${SELECT} WHERE p.on_screen = 1 AND p.pinned_until > ? AND (p.audience = 'everyone'${contracts.length ? ` OR (p.audience = 'team' AND p.contract_id IN (${marks}))` : ''}) ORDER BY p.created_at DESC LIMIT 5`, ctx.now(), ...contracts);
  return rows.map((p) => ({ id: p.id, title: p.title, body: p.body, author_name: p.author_name, audience_label: p.audience === 'team' ? `${p.org_name} ${p.team_name}` : 'Everyone', created_at: p.created_at }));
}

// ---------- The family export ----------
export function forExport(ctx, familyId) {
  return {
    team_feed_comments: ctx.db.all(`SELECT c.author_name, c.by_kind, c.body, c.created_at, p.title AS post_title, p.author_name AS post_by FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
      WHERE c.client_id IN (SELECT id FROM clients WHERE family_id = ?) OR c.guardian_id IN (SELECT id FROM guardians WHERE family_id = ?) ORDER BY c.created_at`, familyId, familyId),
    team_feed_bumps: ctx.db.all(`SELECT p.title AS post_title, p.author_name AS post_by, r.created_at FROM feed_reactions r JOIN feed_posts p ON p.id = r.post_id
      WHERE r.client_id IN (SELECT id FROM clients WHERE family_id = ?) OR r.guardian_id IN (SELECT id FROM guardians WHERE family_id = ?) ORDER BY r.created_at`, familyId, familyId)
  };
}
