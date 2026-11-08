// The photo, video and media release (version 98; owner's ask: "put all the waivers, privacy policy, media release in
// to the diamond protocol app"). Coaching use of clips and photos is always on and private (the waiver covers it); every
// public use is a separate choice a parent ticks for one athlete: social media, first or full name, school and
// commitments, paid advertising, testimonials, live streams, press. Nothing is ticked by default. The release's wording
// is the owner's setting media_release_text (a placeholder starting with "[" until the lawyer's version is saved; the
// portal shows no release and nothing can be signed while it is one). A text change bumps the version: existing choices
// stay in force but show as signed under an older version until the parent confirms them again. Coaches read the
// choices on the client page before posting anything.
import { newId, v, badRequest, HttpError } from '../util.js';
import { getSetting } from './families.js';
import { emit } from './events.js';

export const CHOICES = [
  ['social', 'Social media and website', 'Photos and video of the athlete on our social media channels, website, app and newsletters.'],
  ['first_name', 'First name with posts', 'The athlete\'s first name may appear with a post.'],
  ['full_name', 'Full name with posts', 'The athlete\'s full name may appear with a post.'],
  ['school_team', 'School, team and commitment news', 'School, team, position and commitment news (for example college signings), where the athlete has made it public.'],
  ['advertising', 'Paid advertising and printed marketing', 'Ads, flyers, banners, brochures and sponsor material.'],
  ['testimonials', 'Testimonials and quotes', 'Quotes from the athlete or parent, each approved by you in writing before it is used.'],
  ['livestream', 'Live streams and recorded broadcasts', 'Events, camps and testing days streamed or recorded.'],
  ['press', 'Media interviews and third-party coverage', 'Coverage we arrange (a newspaper, a television station, a college), with your approval each time.'],
];
const KEYS = new Set(CHOICES.map((c) => c[0]));
const LABEL = Object.fromEntries(CHOICES.map((c) => [c[0], c[1]]));

export const published = (ctx) => !String(getSetting(ctx, 'media_release_text') ?? '').trim().startsWith('[');
export const version = (ctx) => Number(getSetting(ctx, 'media_release_version') || 1);
const parse = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((k) => KEYS.has(k)) : []; } catch { return []; } };
export const summaryOf = (choices) => (!choices.length ? 'Coaching use only' : choices.map((k) => LABEL[k]).join(', '));

// The athlete's current choices: the latest signature, or coaching use only when there is none or it was withdrawn.
export function status(ctx, clientId) {
  const r = ctx.db.get('SELECT * FROM media_releases WHERE client_id = ? ORDER BY signed_at DESC, rowid DESC LIMIT 1', clientId);
  const choices = r && !r.withdrawn_at ? parse(r.choices) : [];
  return { published: published(ctx), choices, summary: summaryOf(choices), signed: !!r, signed_by: r?.signed_by ?? null, signed_at: r?.signed_at ?? null, version: r?.version ?? null,
    current: !!r && r.version === version(ctx), withdrawn_at: r?.withdrawn_at ?? null, withdrawn_by: r?.withdrawn_by ?? null };
}
// A parent signs the release for one athlete: the choices ticked (any subset, including none) and their typed name.
export function sign(ctx, client, guardian, body = {}, { ip = null } = {}) {
  if (!published(ctx)) throw new HttpError(409, 'media_release_unpublished', 'The photo and video release isn\'t published yet.');
  if (!Array.isArray(body.choices)) throw badRequest('choices must be a list of the uses you allow (it may be empty).');
  const choices = [...new Set(body.choices.map(String))];
  const bad = choices.filter((k) => !KEYS.has(k));
  if (bad.length) throw badRequest(`Unknown choice: ${bad.join(', ')}. The choices are ${[...KEYS].join(', ')}.`);
  if (body.agree !== true) throw badRequest('Check the box to agree to the release.');
  const typed = v.str(body.signed_name, 'signed_name', { max: 120 });
  if (typed.toLowerCase().replace(/\s+/g, ' ') !== guardian.name.toLowerCase().replace(/\s+/g, ' ')) throw badRequest(`Type your full name exactly as it appears on your account: ${guardian.name}.`);
  const ordered = CHOICES.map((c) => c[0]).filter((k) => choices.includes(k));
  ctx.db.run('INSERT INTO media_releases (id, client_id, family_id, guardian_id, choices, version, signed_by, ip, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId('mr'), client.id, client.family_id, guardian.id, JSON.stringify(ordered), version(ctx), `${guardian.name} <${guardian.email}>`, ip, ctx.now());
  emit(ctx, 'family.media_release_signed', { family_id: client.family_id, client_id: client.id, guardian_name: guardian.name, choices: ordered, version: version(ctx) });
  return status(ctx, client.id);
}
// Withdraw every public use: coaching use stays, as the waiver says. Future use only; the row keeps what was allowed and when.
export function withdraw(ctx, client, guardian) {
  const r = ctx.db.get('SELECT id, withdrawn_at FROM media_releases WHERE client_id = ? ORDER BY signed_at DESC, rowid DESC LIMIT 1', client.id);
  if (!r || r.withdrawn_at) return status(ctx, client.id);
  ctx.db.run('UPDATE media_releases SET withdrawn_at = ?, withdrawn_by = ? WHERE id = ?', ctx.now(), `${guardian.name} <${guardian.email}>`, r.id);
  emit(ctx, 'family.media_release_withdrawn', { family_id: client.family_id, client_id: client.id, guardian_name: guardian.name });
  return status(ctx, client.id);
}
// What the portal shows: the release text and version, the choices to tick, and each athlete's standing.
export function forFamily(ctx, athletes) {
  return { published: published(ctx), text: published(ctx) ? getSetting(ctx, 'media_release_text') : null, version: version(ctx), updated: getSetting(ctx, 'media_release_updated') || null,
    choices: CHOICES.map(([key, label, detail]) => ({ key, label, detail })), athletes: athletes.map((a) => ({ id: a.id, name: a.name, first_name: a.name.split(' ')[0], ...status(ctx, a.id) })) };
}
// For the family export (every signature, what it allowed, and any withdrawal).
export function forExport(ctx, clientId) {
  return ctx.db.all('SELECT choices, version, signed_by, signed_at, withdrawn_at, withdrawn_by FROM media_releases WHERE client_id = ? ORDER BY signed_at', clientId)
    .map((r) => ({ ...r, choices: parse(r.choices).map((k) => LABEL[k]) }));
}
