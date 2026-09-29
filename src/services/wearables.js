// Wearable sync. A parent (or a coach holding the athlete's phone) connects the athlete's WHOOP or Oura account through
// the provider's own sign-in page (OAuth 2.0: the password never comes here), and a background job pulls recovery,
// sleep, strain, activity and workouts into the same tables a file import fills (athlete_metrics, athlete_workouts), so
// the client page, the portal's Progress tab and the athlete app show them the same way, with the same trends.
// Tokens live in wearable_connections. A token the provider refuses marks the connection "needs reconnecting" and stops
// the pulls until someone connects again; disconnecting revokes the token and keeps the data already pulled.
// Apple Health has no cloud service and Garmin opens its feed to approved partners only, so those stay file imports.
import { newId, token, v, notFound, conflict, badRequest, HttpError } from '../util.js';
import { METRICS } from './dataimport.js';
import { rateLimit } from './security.js';

const DAY = 86400000;
export const FIRST_SYNC_DAYS = 30, SYNC_DAYS = 7, STATE_MINUTES = 20, PAGE_LIMIT = 25, MAX_PAGES = 40;
// The athlete's whole history comes in after connecting, in chunks walking back from the first pull: HISTORY_CHUNK_DAYS
// per call; once anything has come back, HISTORY_EMPTY_STOP empty chunks in a row (half a year with nothing) means done,
// and HISTORY_MAX_YEARS back means done whatever came (an account that's been empty for months is still walked, so a
// band that broke in the spring doesn't hide the years before it).
export const HISTORY_CHUNK_DAYS = 90, HISTORY_EMPTY_STOP = 2, HISTORY_MAX_YEARS = 6, HISTORY_JOB_CHUNKS = 4;

// Where each provider signs people in and hands out data. Field names follow the providers' published APIs (WHOOP
// developer API v2, Oura API v2); anything missing or unscored in a record is skipped, never guessed.
export const PROVIDERS = {
  whoop: { label: 'WHOOP', authorize: 'https://api.prod.whoop.com/oauth/oauth2/auth', tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
    revoke: { url: 'https://api.prod.whoop.com/developer/v2/user/access', method: 'DELETE' }, api: 'https://api.prod.whoop.com/developer/v2',
    scopes: 'offline read:profile read:recovery read:sleep read:cycles read:workout', env: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'],
    help: 'developer.whoop.com: create an app, add the redirect address below, and copy its Client ID and Client Secret into Render as WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.' },
  oura: { label: 'Oura', authorize: 'https://cloud.ouraring.com/oauth/authorize', tokenUrl: 'https://api.ouraring.com/oauth/token',
    revoke: { url: 'https://api.ouraring.com/oauth/revoke', method: 'POST' }, api: 'https://api.ouraring.com/v2/usercollection',
    scopes: 'personal daily heartrate workout spo2', env: ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET'],
    help: 'cloud.ouraring.com/oauth/applications: create an application, add the redirect address below, and copy its Client ID and Client Secret into Render as OURA_CLIENT_ID and OURA_CLIENT_SECRET.' }
};
const creds = (p) => ({ id: process.env[PROVIDERS[p].env[0]] || '', secret: process.env[PROVIDERS[p].env[1]] || '' });
const ready = (p) => !!(creds(p).id && creds(p).secret);
const providerKey = (p) => v.oneOf(String(p ?? ''), 'provider', Object.keys(PROVIDERS));
export const redirectUri = (ctx, p) => `${(ctx.publicUrl ?? '').replace(/\/$/, '')}/wearables/${p}/callback`;

// What's set up, for Settings and the connect buttons.
export function status(ctx) {
  return { providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label, ready: ready(key), redirect_uri: redirectUri(ctx, key), help: p.help, env: p.env })) };
}

// ---------- Connecting ----------
function athlete(ctx, clientId) {
  const c = ctx.db.get('SELECT id, name, family_id, archived_at FROM clients WHERE id = ?', v.str(clientId, 'client_id'));
  if (!c) throw notFound('Athlete');
  if (c.archived_at) throw conflict(`${c.name} is archived. Restore them on their client page first.`);
  return c;
}
// The sign-in link for one athlete and provider. state is a one-time code we keep for 20 minutes, so a callback can
// only land on the athlete it was started for. by: { kind: 'staff' | 'parent', id }.
export function connectUrl(ctx, clientId, provider, by = {}) {
  const p = providerKey(provider);
  if (!ready(p)) throw conflict(`${PROVIDERS[p].label} isn't set up yet. The owner adds ${PROVIDERS[p].env.join(' and ')} in Render (Settings → Data import shows how).`);
  if (!ctx.publicUrl) throw conflict('Connecting a wearable needs the app\'s public address (PUBLIC_URL).');
  const c = athlete(ctx, clientId);
  rateLimit(`wearable-connect:${by.kind ?? 'x'}:${by.id ?? 'x'}`, 20, 60 * 60000);
  const state = token(24);
  ctx.db.run('DELETE FROM wearable_auth_states WHERE created_at < ?', new Date(Date.parse(ctx.now()) - STATE_MINUTES * 60000).toISOString());
  ctx.db.run('INSERT INTO wearable_auth_states (state, client_id, provider, by_kind, by_id, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    state, c.id, p, by.kind === 'staff' ? 'staff' : 'parent', by.id ?? null, by.kind === 'staff' ? `/?back=#/clients/${c.id}` : '/parent?tab=progress', ctx.now());
  const q = new URLSearchParams({ client_id: creds(p).id, redirect_uri: redirectUri(ctx, p), response_type: 'code', scope: PROVIDERS[p].scopes, state });
  return { url: `${PROVIDERS[p].authorize}?${q}`, provider: p, label: PROVIDERS[p].label, expires_in_minutes: STATE_MINUTES };
}
// Back from the provider's sign-in page. Always answers with somewhere to go: the portal's Progress tab or the client
// page, with ?wearable= saying what happened (connected, denied, expired, error). The query goes before the # so the
// page's own script can read it (the client page lives at /#/clients/<id>).
export async function callback(ctx, provider, query = {}) {
  const p = Object.hasOwn(PROVIDERS, String(provider)) ? String(provider) : null;
  const back = (to, what) => {
    const [path, hash = ''] = String(to || '/parent?tab=progress').split('#');
    const [pathname, query = ''] = path.split('?');
    const q = new URLSearchParams(query); q.set('wearable', what); q.set('provider', p ?? '');
    return { __redirect: `${pathname}?${q}${hash ? `#${hash}` : ''}` };
  };
  if (!p) return back('/parent?tab=progress', 'error');
  const row = query.state ? ctx.db.get('SELECT * FROM wearable_auth_states WHERE state = ? AND provider = ?', String(query.state), p) : null;
  if (!row || Date.parse(row.created_at) < Date.parse(ctx.now()) - STATE_MINUTES * 60000) return back('/parent?tab=progress', 'expired');
  ctx.db.run('DELETE FROM wearable_auth_states WHERE state = ?', row.state);
  const to = row.return_to;
  if (query.error || !query.code) return back(to, 'denied');
  let tok;
  try { tok = await exchange(ctx, p, { grant_type: 'authorization_code', code: String(query.code), redirect_uri: redirectUri(ctx, p) }); }
  catch (e) { console.error('wearable connect:', e.message); return back(to, 'error'); }
  let providerUserId = null;
  try { providerUserId = await profileId(ctx, p, tok.access_token); } catch { /* not essential */ }
  const id = ctx.db.get('SELECT id FROM wearable_connections WHERE client_id = ? AND provider = ?', row.client_id, p)?.id ?? newId('wear');
  ctx.db.run(`INSERT INTO wearable_connections (id, client_id, provider, provider_user_id, access_token, refresh_token, expires_at, scopes, status, connected_by_kind, connected_by, connected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT (client_id, provider) DO UPDATE SET provider_user_id = excluded.provider_user_id, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, scopes = excluded.scopes, status = 'active', connected_by_kind = excluded.connected_by_kind, connected_by = excluded.connected_by, connected_at = excluded.connected_at, last_error = NULL`,
    id, row.client_id, p, providerUserId, tok.access_token, tok.refresh_token ?? null, expiry(ctx, tok), tok.scope ?? PROVIDERS[p].scopes, row.by_kind, row.by_id, ctx.now());
  ctx.db.run('UPDATE wearable_connections SET history_from = NULL, history_empty = 0, history_found = 0, history_done = 0 WHERE id = ?', id);   // connected again: the history is walked once more (what's on file stays)
  try { const first = await syncConnection(ctx, id, { days: FIRST_SYNC_DAYS }); if (first.values + first.workouts > 0) ctx.db.run('UPDATE wearable_connections SET history_found = 1 WHERE id = ?', id); }
  catch (e) { console.error('wearable first sync:', e.message); }
  startHistory(ctx, id);   // the rest of the athlete's history follows on its own (not awaited: the parent lands back at once)
  return back(to, 'connected');
}
const expiry = (ctx, tok) => new Date(Date.parse(ctx.now()) + Math.max(60, Number(tok.expires_in) || 3600) * 1000).toISOString();

// ---------- Talking to the provider ----------
class ProviderError extends Error { constructor(status, text) { super(`the provider answered ${status}${text ? `: ${String(text).slice(0, 200)}` : ''}`); this.status = status; } }
const http = (ctx) => ctx.wearableFetch ?? fetch;          // tests hand in a stand-in
async function exchange(ctx, p, form) {
  const { id, secret } = creds(p);
  const body = new URLSearchParams({ ...form, client_id: id, client_secret: secret });
  const res = await http(ctx)(PROVIDERS[p].tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(res.status, text);
  let d; try { d = JSON.parse(text); } catch { throw new ProviderError(res.status, 'not JSON'); }
  if (!d.access_token) throw new ProviderError(res.status, 'no access token');
  return d;
}
const MAX_429_RETRIES = 3;                                  // a provider that keeps saying "slow down" is given up on
async function apiGet(ctx, p, accessToken, path, params = {}, attempt = 0) {
  const url = new URL(`${PROVIDERS[p].api}${path}`);
  for (const [k, val] of Object.entries(params)) if (val !== undefined && val !== null && val !== '') url.searchParams.set(k, String(val));
  const res = await http(ctx)(url.toString(), { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) {
    if (attempt >= MAX_429_RETRIES) throw new ProviderError(429, 'rate limited; try again later');
    const raw = res.headers?.get?.('retry-after'), ra = raw == null || raw === '' ? 2 : Number(raw);
    const wait = Number.isFinite(ra) && ra >= 0 ? ra : 2;             // seconds; an HTTP-date Retry-After counts as 2 seconds
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    return apiGet(ctx, p, accessToken, path, params, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(res.status, text);
  try { return JSON.parse(text); } catch { throw new ProviderError(res.status, 'not JSON'); }
}
async function profileId(ctx, p, accessToken) {
  const d = await apiGet(ctx, p, accessToken, p === 'whoop' ? '/user/profile/basic' : '/personal_info');
  return d?.user_id != null ? String(d.user_id) : d?.id != null ? String(d.id) : null;
}
// Every page of a list: WHOOP pages with nextToken/next_token, Oura with next_token; both put the rows in records or data.
async function pages(ctx, p, accessToken, path, params) {
  const out = [];
  let next = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const d = await apiGet(ctx, p, accessToken, path, { ...params, ...(next ? (p === 'whoop' ? { nextToken: next } : { next_token: next }) : {}) });
    out.push(...(Array.isArray(d.records) ? d.records : Array.isArray(d.data) ? d.data : []));
    next = d.next_token ?? null;
    if (!next) break;
  }
  return out;
}

// ---------- Pulling ----------
// The day a moment falls on where the athlete was: the provider's offset ("-05:00") when it gives one, else the business zone.
export function localDay(iso, offset, zone) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset ?? ''));
  if (m) return new Date(t + (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000).toISOString().slice(0, 10);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(0, 10); }
}
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const mins = (ms) => (num(ms) === null ? null : Math.round(num(ms) / 60000));
const kcal = (kj) => (num(kj) === null ? null : Math.round(num(kj) / 4.184));
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

// Rows from WHOOP for the window: cycles carry the day and strain, recoveries hang off a cycle, sleeps off their own end.
async function pullWhoop(ctx, conn, from, to, zone) {
  const range = { start: from.toISOString(), end: to.toISOString(), limit: PAGE_LIMIT };
  const [cycles, recoveries, sleeps, workouts] = await Promise.all([
    pages(ctx, 'whoop', conn.access_token, '/cycle', range), pages(ctx, 'whoop', conn.access_token, '/recovery', range),
    pages(ctx, 'whoop', conn.access_token, '/activity/sleep', range), pages(ctx, 'whoop', conn.access_token, '/activity/workout', range)]);
  const metrics = [], out = [];
  const put = (day, metric, value) => { if (day && value !== null) metrics.push({ day, metric, value }); };
  const cycleDay = new Map();
  for (const c of cycles) {
    const day = localDay(c.start, c.timezone_offset, zone);
    cycleDay.set(String(c.id), day);
    if (c.score_state !== 'SCORED' || !c.score) continue;
    put(day, 'day_strain', round1(num(c.score.strain))); put(day, 'calories_kcal', kcal(c.score.kilojoule));
    put(day, 'avg_hr_bpm', num(c.score.average_heart_rate)); put(day, 'max_hr_bpm', num(c.score.max_heart_rate));
  }
  for (const r of recoveries) {
    if (r.score_state !== 'SCORED' || !r.score) continue;
    const day = cycleDay.get(String(r.cycle_id));
    put(day, 'recovery_pct', num(r.score.recovery_score)); put(day, 'rhr_bpm', num(r.score.resting_heart_rate)); put(day, 'hrv_ms', round1(num(r.score.hrv_rmssd_milli)));
    put(day, 'spo2_pct', round1(num(r.score.spo2_percentage))); put(day, 'skin_temp_c', round1(num(r.score.skin_temp_celsius)));
  }
  for (const s of sleeps) {
    if (s.nap || s.score_state !== 'SCORED' || !s.score) continue;      // naps are left out, like the file import
    const day = localDay(s.end, s.timezone_offset, zone), st = s.score.stage_summary ?? {}, need = s.score.sleep_needed ?? {};
    const light = mins(st.total_light_sleep_time_milli), deep = mins(st.total_slow_wave_sleep_time_milli), rem = mins(st.total_rem_sleep_time_milli);
    put(day, 'sleep_min', [light, deep, rem].some((x) => x === null) ? null : light + deep + rem);
    put(day, 'in_bed_min', mins(st.total_in_bed_time_milli)); put(day, 'light_min', light); put(day, 'deep_min', deep); put(day, 'rem_min', rem); put(day, 'awake_min', mins(st.total_awake_time_milli));
    const needAll = ['baseline_milli', 'need_from_sleep_debt_milli', 'need_from_recent_strain_milli', 'need_from_recent_nap_milli'].map((k) => num(need[k]));
    put(day, 'sleep_need_min', needAll.some((x) => x === null) ? null : Math.round((needAll[0] + needAll[1] + needAll[2] + needAll[3]) / 60000));
    put(day, 'sleep_debt_min', mins(need.need_from_sleep_debt_milli));
    put(day, 'sleep_performance_pct', num(s.score.sleep_performance_percentage)); put(day, 'sleep_efficiency_pct', round1(num(s.score.sleep_efficiency_percentage)));
    put(day, 'sleep_consistency_pct', num(s.score.sleep_consistency_percentage)); put(day, 'resp_rate', round1(num(s.score.respiratory_rate)));
  }
  for (const w of workouts) {
    if (!w.start) continue;
    const sc = w.score_state === 'SCORED' && w.score ? w.score : {};
    out.push({ started_at: new Date(Date.parse(w.start)).toISOString(), ended_at: w.end ? new Date(Date.parse(w.end)).toISOString() : null, day: localDay(w.start, w.timezone_offset, zone),
      minutes: w.end ? Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60000) : null, activity: w.sport_name ?? (w.sport_id != null ? `Sport ${w.sport_id}` : 'Workout'),
      strain: round1(num(sc.strain)), calories: kcal(sc.kilojoule), avg_hr: num(sc.average_heart_rate), max_hr: num(sc.max_heart_rate) });
  }
  return { metrics, workouts: out };
}
// Rows from Oura: daily scores by day; the long sleep of the day for stages and heart numbers; steps and calories; workouts.
async function pullOura(ctx, conn, from, to) {
  const range = { start_date: from.toISOString().slice(0, 10), end_date: to.toISOString().slice(0, 10) };
  const get = (path) => pages(ctx, 'oura', conn.access_token, path, range).catch((e) => { if (e.status === 403 || e.status === 404) return []; throw e; });   // a scope the parent didn't allow
  const [readiness, dailySleep, sleeps, activity, spo2, workouts] = await Promise.all([get('/daily_readiness'), get('/daily_sleep'), get('/sleep'), get('/daily_activity'), get('/daily_spo2'), get('/workout')]);
  const metrics = [], out = [];
  const put = (day, metric, value) => { if (day && value !== null) metrics.push({ day, metric, value }); };
  for (const r of readiness) put(r.day, 'readiness_pct', num(r.score));
  for (const s of dailySleep) put(s.day, 'sleep_score_pct', num(s.score));
  for (const s of sleeps) {
    if (s.type && s.type !== 'long_sleep') continue;                 // naps and rests are left out
    const secs = (x) => (num(x) === null ? null : Math.round(num(x) / 60));
    put(s.day, 'sleep_min', secs(s.total_sleep_duration)); put(s.day, 'in_bed_min', secs(s.time_in_bed)); put(s.day, 'deep_min', secs(s.deep_sleep_duration));
    put(s.day, 'rem_min', secs(s.rem_sleep_duration)); put(s.day, 'light_min', secs(s.light_sleep_duration)); put(s.day, 'awake_min', secs(s.awake_time));
    put(s.day, 'sleep_efficiency_pct', num(s.efficiency)); put(s.day, 'hrv_ms', round1(num(s.average_hrv))); put(s.day, 'rhr_bpm', num(s.lowest_heart_rate)); put(s.day, 'resp_rate', round1(num(s.average_breath)));
  }
  for (const a of activity) { put(a.day, 'steps', num(a.steps)); put(a.day, 'calories_kcal', num(a.total_calories)); put(a.day, 'active_cal_kcal', num(a.active_calories)); }
  for (const s of spo2) put(s.day, 'spo2_pct', round1(num(s.spo2_percentage?.average)));
  for (const w of workouts) {
    if (!w.start_datetime) continue;
    out.push({ started_at: new Date(Date.parse(w.start_datetime)).toISOString(), ended_at: w.end_datetime ? new Date(Date.parse(w.end_datetime)).toISOString() : null, day: w.day ?? null,
      minutes: w.end_datetime ? Math.round((Date.parse(w.end_datetime) - Date.parse(w.start_datetime)) / 60000) : null, activity: w.activity ? String(w.activity).replace(/_/g, ' ') : 'Workout',
      strain: null, calories: num(w.calories), avg_hr: null, max_hr: null });
  }
  return { metrics, workouts: out };
}

// Pull the last days for one connection and save what's new. A refused token marks the connection for reconnecting.
// window: { from, to } (Dates) pulls that span instead of the last days, for the history walk.
export async function syncConnection(ctx, id, { days = SYNC_DAYS, window = null } = {}) {
  const conn = ctx.db.get('SELECT w.*, c.archived_at FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE w.id = ?', id);
  if (!conn) throw notFound('Wearable connection');
  if (conn.archived_at) return { id, skipped: 'archived' };
  if (conn.status !== 'active') return { id, skipped: conn.status };
  const p = conn.provider, zone = ctx.db.get(`SELECT value FROM settings WHERE key = 'timezone'`)?.value ?? 'America/Chicago';
  const now = Date.parse(ctx.now());
  try {
    if (!conn.expires_at || Date.parse(conn.expires_at) < now + 120000) {
      if (!conn.refresh_token) throw new ProviderError(401, 'no refresh token');
      let tok;
      try { tok = await exchange(ctx, p, { grant_type: 'refresh_token', refresh_token: conn.refresh_token, ...(p === 'whoop' ? { scope: 'offline' } : {}) }); }
      catch (e) {   // 400 invalid_grant (access revoked in the WHOOP or Oura app, or a refresh token already used) or 401: the sign-in is gone
        if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError(401, `refresh refused: ${String(e.message).replace(/^the provider answered \d+:? ?/, '')}`);
        throw e;
      }
      conn.access_token = tok.access_token; conn.refresh_token = tok.refresh_token ?? conn.refresh_token; conn.expires_at = expiry(ctx, tok);
      ctx.db.run('UPDATE wearable_connections SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?', conn.access_token, conn.refresh_token, conn.expires_at, id);
    }
    const span = Math.min(Math.max(Number(days) || SYNC_DAYS, 1), 90);
    const from = window?.from ?? new Date(now - span * DAY), to = window?.to ?? new Date(now);
    const pulled = p === 'whoop' ? await pullWhoop(ctx, conn, from, to, zone) : await pullOura(ctx, conn, from, to);
    const saved = save(ctx, conn, pulled);
    if (window) ctx.db.run('UPDATE wearable_connections SET last_error = NULL WHERE id = ?', id);
    else ctx.db.run('UPDATE wearable_connections SET last_sync_at = ?, last_sync_days = ?, last_error = NULL WHERE id = ?', ctx.now(), saved.days, id);
    return { id, provider: p, ...saved };
  } catch (e) {
    const refused = e instanceof ProviderError && (e.status === 401 || e.status === 403);
    ctx.db.run('UPDATE wearable_connections SET last_error = ?, status = ? WHERE id = ?', String(e.message).slice(0, 300), refused ? 'needs_reconnect' : conn.status, id);
    if (refused) return { id, provider: p, needs_reconnect: true, error: e.message };
    throw e;
  }
}
// Pull now, from a button: a provider that errors is answered as 502 with what it said, not a bare server error.
export async function syncNow(ctx, id, opts) {
  try { return await syncConnection(ctx, id, opts); }
  catch (e) { if (e instanceof ProviderError) throw new HttpError(502, 'provider_error', `The pull didn't finish: ${e.message}. Try again in a few minutes.`); throw e; }
}
// ---------- The athlete's history ----------
// Walks back from where the pulls started (history_from, else the first pull's start) HISTORY_CHUNK_DAYS at a time,
// saving each chunk, until HISTORY_EMPTY_STOP chunks in a row bring nothing or HISTORY_MAX_YEARS are covered. Up to
// maxChunks per call, so one run stays well under the providers' rate limits; the job carries on where it left off.
export async function pullHistory(ctx, id, { maxChunks = HISTORY_JOB_CHUNKS } = {}) {
  const conn = ctx.db.get('SELECT w.*, c.archived_at FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE w.id = ?', id);
  if (!conn || conn.archived_at || conn.status !== 'active' || conn.history_done) return { id, chunks: 0, done: !!conn?.history_done };
  const now = Date.parse(ctx.now()), floor = now - HISTORY_MAX_YEARS * 365 * DAY;
  let to = conn.history_from ? Date.parse(conn.history_from) : now - FIRST_SYNC_DAYS * DAY;
  let empty = conn.history_empty ?? 0, found = !!conn.history_found, chunks = 0, changed = 0;
  while (chunks < maxChunks) {
    if (to <= floor) { ctx.db.run('UPDATE wearable_connections SET history_done = 1, history_from = ? WHERE id = ?', new Date(to).toISOString(), id); return { id, chunks, changed, done: true }; }
    const from = new Date(Math.max(floor, to - HISTORY_CHUNK_DAYS * DAY));
    const r = await syncConnection(ctx, id, { window: { from, to: new Date(to) } });
    if (r.skipped || r.needs_reconnect) return { id, chunks, changed, done: false, ...r };
    chunks++; changed += r.changed;
    if (r.values + r.workouts === 0) empty++; else { empty = 0; found = true; }
    to = from.getTime();
    const done = found && empty >= HISTORY_EMPTY_STOP;
    ctx.db.run('UPDATE wearable_connections SET history_from = ?, history_empty = ?, history_found = ?, history_done = ? WHERE id = ?', from.toISOString(), empty, found ? 1 : 0, done ? 1 : 0, id);
    if (done) return { id, chunks, changed, done: true };
  }
  return { id, chunks, changed, done: false };
}
// Right after connecting: keep pulling chunks until the history is complete, pausing between chunks so the provider
// isn't hammered. Runs in the background; ctx.wearableHistory holds the promise so tests (and Pull now) can wait on it.
const HISTORY_PAUSE_MS = 2500;
export function startHistory(ctx, id) {
  ctx.wearableHistory ??= new Map();
  if (ctx.wearableHistory.has(id)) return ctx.wearableHistory.get(id);
  const run = (async () => {
    try {
      for (let i = 0; i < 40; i++) {
        const r = await pullHistory(ctx, id, { maxChunks: 1 });
        if (r.done || r.chunks === 0) break;
        if (!ctx.testMode) await new Promise((res) => setTimeout(res, HISTORY_PAUSE_MS));
      }
    } catch (e) { console.error('wearable history:', e.message); }   // the job picks it up from history_from
    finally { ctx.wearableHistory.delete(id); }
  })();
  ctx.wearableHistory.set(id, run);
  return run;
}
// One value per athlete, metric and day, like a file import: the same value stays, a different one is replaced (a pull is
// the freshest word from the device). Values outside what's possible, and a 0 where 0 can't be measured, are skipped.
function save(ctx, conn, { metrics, workouts }) {
  const source = `${conn.provider}_sync`, now = ctx.now();
  let changed = 0; const days = new Set();
  ctx.db.tx(() => {
    if (!ctx.db.get('SELECT 1 AS ok FROM wearable_connections WHERE id = ?', conn.id)) return;   // disconnected (or the family deleted) while this chunk was in flight: nothing lands
    for (const m of metrics) {
      const def = METRICS[m.metric];
      if (!def || !/^\d{4}-\d{2}-\d{2}$/.test(m.day) || m.value < def.min || m.value > def.max) continue;
      days.add(m.day);
      const cur = ctx.db.get('SELECT value FROM athlete_metrics WHERE client_id = ? AND metric = ? AND day = ?', conn.client_id, m.metric, m.day);
      if (cur && cur.value === m.value) continue;
      changed++;
      if (cur) ctx.db.run('UPDATE athlete_metrics SET value = ?, label = ?, unit = ?, source = ?, import_id = NULL, updated_at = ? WHERE client_id = ? AND metric = ? AND day = ?', m.value, def.label, def.unit, source, now, conn.client_id, m.metric, m.day);
      else ctx.db.run('INSERT INTO athlete_metrics (client_id, day, metric, value, label, unit, source, import_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)', conn.client_id, m.day, m.metric, m.value, def.label, def.unit, source, now);
    }
    for (const w of workouts) {
      ctx.db.run(`INSERT INTO athlete_workouts (id, client_id, source, started_at, ended_at, day, minutes, activity, strain, calories, avg_hr, max_hr, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT (client_id, source, started_at) DO UPDATE SET ended_at = excluded.ended_at, minutes = excluded.minutes, activity = excluded.activity, strain = excluded.strain, calories = excluded.calories, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr`,
        newId('awk'), conn.client_id, source, w.started_at, w.ended_at, w.day, w.minutes, w.activity, w.strain, w.calories, w.avg_hr, w.max_hr);
    }
  });
  return { values: metrics.length, changed, days: days.size, workouts: workouts.length };
}
// The background job: every active connection whose athlete isn't archived, one at a time; one failure never stops the rest.
export async function syncAll(ctx) {
  const rows = ctx.db.all(`SELECT w.id FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE w.status = 'active' AND c.archived_at IS NULL ORDER BY w.last_sync_at`);
  const out = { connections: rows.length, synced: 0, changed: 0, needs_reconnect: 0, failed: 0 };
  for (const r of rows) {
    try {
      const s = await syncConnection(ctx, r.id);
      if (s.needs_reconnect) { out.needs_reconnect++; continue; }
      if (s.skipped) continue;
      out.synced++; out.changed += s.changed;
      const h = await pullHistory(ctx, r.id);   // an unfinished history walks back a year per run
      out.changed += h.changed ?? 0;
    } catch (e) { out.failed++; console.error(`wearable sync ${r.id}:`, e.message); }
  }
  if (out.failed && out.failed === rows.length) throw new Error(`Every wearable pull failed (${out.failed}).`);
  return out;
}

// ---------- Listing and disconnecting ----------
const shape = (w) => ({ id: w.id, client_id: w.client_id, provider: w.provider, label: PROVIDERS[w.provider]?.label ?? w.provider, status: w.status, connected_by_kind: w.connected_by_kind,
  connected_at: w.connected_at, last_sync_at: w.last_sync_at, last_sync_days: w.last_sync_days, last_error: w.last_error,
  history_done: !!w.history_done, history_from: w.history_from ? w.history_from.slice(0, 10) : null });
export function listConnections(ctx, clientId) {
  return ctx.db.all('SELECT * FROM wearable_connections WHERE client_id = ? ORDER BY provider', clientId).map(shape);
}
export function forFamily(ctx, familyId) {
  return ctx.db.all('SELECT w.* FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE c.family_id = ? ORDER BY w.provider', familyId).map(shape);
}
// Revoke the token where the provider allows it (best effort), forget it, keep the data already pulled.
export async function disconnect(ctx, id, { familyId = null } = {}) {
  const w = ctx.db.get('SELECT w.*, c.family_id FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE w.id = ?', id);
  if (!w || (familyId && w.family_id !== familyId)) throw notFound('Wearable connection');
  const p = PROVIDERS[w.provider];
  try {
    if (w.provider === 'whoop') await http(ctx)(p.revoke.url, { method: 'DELETE', headers: { authorization: `Bearer ${w.access_token}` }, signal: AbortSignal.timeout(10000) });
    else await http(ctx)(`${p.revoke.url}?access_token=${encodeURIComponent(w.access_token)}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
  } catch (e) { console.error('wearable revoke:', e.message); }
  ctx.db.run('DELETE FROM wearable_connections WHERE id = ?', id);
  return { id, deleted: true, provider: w.provider, label: p.label };
}
// A family's data is deleted: every connection of its athletes is revoked (best effort) and forgotten, and any sign-in
// still in flight is dropped, so the job never pulls for them again. The data already pulled goes with the family's data.
export async function forgetFamily(ctx, familyId) {
  const rows = ctx.db.all('SELECT w.id FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE c.family_id = ?', familyId);
  for (const r of rows) { try { await disconnect(ctx, r.id); } catch (e) { console.error('wearable forget:', e.message); ctx.db.run('DELETE FROM wearable_connections WHERE id = ?', r.id); } }
  ctx.db.run('DELETE FROM wearable_auth_states WHERE client_id IN (SELECT id FROM clients WHERE family_id = ?)', familyId);
  return rows.length;
}
export function connectionFor(ctx, id, { familyId = null } = {}) {
  const w = ctx.db.get('SELECT w.*, c.family_id FROM wearable_connections w JOIN clients c ON c.id = w.client_id WHERE w.id = ?', id);
  if (!w || (familyId && w.family_id !== familyId)) throw notFound('Wearable connection');
  return w;
}
export { badRequest };
