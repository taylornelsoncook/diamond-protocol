// Profile tags (owner's ask: "tag profiles with certain things based off when they sign up; for example anyone who signs
// up from now until February 28th I want them to have a highlighted legacy star by their name"; schema 90).
//
// A tag is a name, an icon, a colour and the dates it covers (business days, both ends counted; no end = still open). A
// profile has the tag when the day it was made (clients.created_at in the business time zone) falls in those dates, so
// every way a profile is made counts (the sign-up form, the counter, the online sales page, a testing day, an import)
// with nothing to remember at creation. Team-only athletes (on a school or club roster with no membership) are left out
// unless the tag counts them: a coach adding a roster isn't a sign-up. The owner can also add the tag to anyone by hand
// or take it off one profile (client_tags: 'added' or 'removed', which wins over the dates). Changing a tag's dates
// changes who has it at once; hand changes stay.
//
// Staff see the tags beside the name on the client list and the client page; families never see them. The owner makes,
// changes and deletes tags (Settings → Profile tags) and adds or removes them on a client page.
import { newId, v, badRequest, notFound, conflict, isDate, zonedToUtc, addDaysToDate, localDate } from '../util.js';
import { getSetting } from './families.js';

export const ICONS = { star: '★', crown: '♛', diamond: '◆', bolt: '⚡', heart: '♥', flag: '⚑', check: '✓' };
export const COLORS = { gold: '#D4A72C', green: '#7DBA70', steel: '#E4E7E5', blue: '#6FA8DC', red: '#E06666', purple: '#A78BDB' };
const MAX_TAGS = 30;
const zone = (ctx) => getSetting(ctx, 'timezone');

const shapeTag = (t) => ({ id: t.id, name: t.name, icon: t.icon, symbol: ICONS[t.icon] ?? ICONS.star, color: t.color, hex: COLORS[t.color] ?? COLORS.gold,
  starts_on: t.starts_on, ends_on: t.ends_on ?? null, team_only: !!t.team_only, note: t.note ?? null, created_by: t.created_by ?? null, created_at: t.created_at });

// The tags with the UTC bounds of their dates, read once per list.
function rules(ctx) {
  const z = zone(ctx);
  return ctx.db.all('SELECT * FROM profile_tags ORDER BY starts_on, name COLLATE NOCASE').map((t) => ({ ...shapeTag(t),
    from: zonedToUtc(t.starts_on, '00:00', z), to: t.ends_on ? zonedToUtc(addDaysToDate(t.ends_on, 1), '00:00', z) : '9999' }));
}
const teamOnly = (c) => (c.teams?.length ?? 0) > 0 && ['none', 'canceled'].includes(c.status);
const publicTag = (t, how) => ({ id: t.id, name: t.name, icon: t.icon, symbol: t.symbol, color: t.color, hex: t.hex, how });

// tagger(ctx) → (shaped client) → its tags, each with how it got there: 'dates' (made in the tag's dates) or 'hand'.
export function tagger(ctx) {
  const all = rules(ctx);
  if (!all.length) return () => [];
  const hand = new Map();
  for (const r of ctx.db.all('SELECT client_id, tag_id, state FROM client_tags')) hand.set(`${r.client_id}:${r.tag_id}`, r.state);
  return (c) => all.flatMap((t) => {
    const h = hand.get(`${c.id}:${t.id}`);
    if (h === 'added') return [publicTag(t, 'hand')];
    if (h === 'removed') return [];
    const inDates = c.created_at >= t.from && c.created_at < t.to && (t.team_only || !teamOnly(c));
    return inDates ? [publicTag(t, 'dates')] : [];
  });
}

function fields(ctx, body, old = null) {
  const out = {};
  if (body.name !== undefined || !old) {
    out.name = v.str(body.name, 'name', { max: 30 }).trim();
    if (!out.name) throw badRequest('Name the tag, like Legacy.');
    const dup = ctx.db.get('SELECT id FROM profile_tags WHERE name = ? COLLATE NOCASE AND id != ?', out.name, old?.id ?? '');
    if (dup) throw conflict(`There's already a tag called ${out.name}. Pick another name.`);
  }
  if (body.icon !== undefined || !old) out.icon = body.icon == null ? 'star' : v.oneOf(body.icon, 'icon', Object.keys(ICONS));
  if (body.color !== undefined || !old) out.color = body.color == null ? 'gold' : v.oneOf(body.color, 'color', Object.keys(COLORS));
  if (body.starts_on !== undefined || !old) {
    out.starts_on = body.starts_on == null || body.starts_on === '' ? localDate(ctx.now(), zone(ctx)) : String(body.starts_on);
    if (!isDate(out.starts_on)) throw badRequest('Choose a real start date, like 2026-10-18.');
  }
  if (body.ends_on !== undefined) {
    out.ends_on = body.ends_on == null || body.ends_on === '' ? null : String(body.ends_on);
    if (out.ends_on && !isDate(out.ends_on)) throw badRequest('Choose a real end date, like 2027-02-28, or leave it empty.');
  }
  const start = out.starts_on ?? old?.starts_on, end = out.ends_on !== undefined ? out.ends_on : old?.ends_on;
  if (end && start > end) throw badRequest('The end date is before the start date. Swap them.');
  if (body.team_only !== undefined) { if (typeof body.team_only !== 'boolean') throw badRequest('team_only must be true or false.'); out.team_only = body.team_only ? 1 : 0; }
  if (body.note !== undefined) out.note = v.str(body.note, 'note', { max: 300, optional: true }) ?? null;
  return out;
}

// GET /v1/profile-tags: every tag with how many profiles have it now (archived left out of the count).
export function listTags(ctx, clients) {
  const tagsOf = tagger(ctx);
  const counts = new Map();
  for (const c of clients.filter((x) => !x.archived_at)) for (const t of tagsOf(c)) counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
  return { data: rules(ctx).map(({ from, to, ...t }) => ({ ...t, clients: counts.get(t.id) ?? 0 })), icons: ICONS, colors: COLORS };
}
export function getTag(ctx, id) {
  const t = ctx.db.get('SELECT * FROM profile_tags WHERE id = ?', id);
  if (!t) throw notFound('Tag');
  return t;
}
export function createTag(ctx, body = {}, actor) {
  if (ctx.db.get('SELECT COUNT(*) AS n FROM profile_tags').n >= MAX_TAGS) throw conflict(`You can have up to ${MAX_TAGS} tags. Delete one you no longer use.`);
  const f = fields(ctx, body);
  const id = newId('tag');
  ctx.db.run(`INSERT INTO profile_tags (id, name, icon, color, starts_on, ends_on, team_only, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, f.name, f.icon, f.color, f.starts_on, f.ends_on ?? null, f.team_only ?? 0, f.note ?? null, actor?.name ?? null, ctx.now());
  return shapeTag(getTag(ctx, id));
}
export function updateTag(ctx, id, body = {}) {
  const old = getTag(ctx, id);
  const f = fields(ctx, body, old);
  const keys = Object.keys(f);
  if (keys.length) ctx.db.run(`UPDATE profile_tags SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), id);
  return shapeTag(getTag(ctx, id));
}
// Deleting a tag takes it off every profile (hand changes go with it); the profiles themselves are untouched.
export function deleteTag(ctx, id) {
  getTag(ctx, id);
  ctx.db.run('DELETE FROM profile_tags WHERE id = ?', id);
  return { deleted: true };
}

// POST /v1/clients/:id/tags { tag_id, on }: the owner adds the tag to one profile or takes it off. When the dates
// already say the same, the hand change is dropped, so moving the dates later still counts for this profile.
export function setClientTag(ctx, client, body = {}, actor) {
  const t = shapeTag(getTag(ctx, v.str(body.tag_id, 'tag_id', { max: 60 })));
  if (typeof body.on !== 'boolean') throw badRequest('on must be true (add the tag) or false (take it off).');
  ctx.db.run('DELETE FROM client_tags WHERE client_id = ? AND tag_id = ?', client.id, t.id);
  const byDates = tagger(ctx)(client).some((x) => x.id === t.id);
  if (byDates !== body.on) ctx.db.run('INSERT INTO client_tags (client_id, tag_id, state, by_name, created_at) VALUES (?, ?, ?, ?, ?)', client.id, t.id, body.on ? 'added' : 'removed', actor?.name ?? null, ctx.now());
  return { client_id: client.id, tag_id: t.id, on: body.on };
}

// The family export (a data request): the tags this athlete has, by name, and how.
export function forExport(ctx, clientId) {
  const r = ctx.db.get(`SELECT c.id, c.created_at,
      (SELECT status FROM subscriptions WHERE client_id = c.id ORDER BY (status = 'canceled'), created_at DESC LIMIT 1) AS status,
      (SELECT COUNT(*) FROM team_roster t JOIN team_contracts tc ON tc.id = t.contract_id WHERE t.client_id = c.id AND t.active = 1 AND tc.status = 'active') AS teams
    FROM clients c WHERE c.id = ?`, clientId);
  if (!r) return [];
  return tagger(ctx)({ id: r.id, created_at: r.created_at, status: r.status ?? 'none', teams: Array(r.teams).fill(null) })
    .map((t) => ({ tag: t.name, how: t.how === 'hand' ? 'added by the owner' : 'joined in its dates' }));
}
