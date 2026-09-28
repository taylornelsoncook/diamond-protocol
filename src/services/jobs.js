import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { newId, notFound, conflict } from '../util.js';
import { sendEmail } from './mail.js';
import { audit } from './security.js';

// Background jobs. Every run is recorded in job_runs (status, time taken, result, error); a failure emails the
// owners once, reminds them daily while it keeps failing, and says when it recovers. A lease in job_state
// means only one server copy sharing this database runs a job in any one interval.
// A job's run() may be async; returning { skipped: true } records the run as skipped (nothing to do).
// quiet jobs (the 15-second webhook sender) record only failures, so the history isn't all no-op rows.
// A run is written when it finishes; if a server stops mid-run, its lease simply runs out and the next tick retries.
export const KEEP_DAYS = 30;
const REALERT_MS = 24 * 3600e3;
const INSTANCE = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const firstLine = (error) => String(error ?? '').split('\n')[0].replace(/^Error:\s*/, '').slice(0, 300);
const every = (ms) => (ms < 60e3 ? `${ms / 1000} seconds` : ms < 3600e3 ? `${ms / 60e3} minutes` : ms === 3600e3 ? 'hour' : `${ms / 3600e3} hours`);

function summarize(v) {
  if (v === undefined || v === null) return null;
  try { return (typeof v === 'string' ? v : JSON.stringify(v))?.slice(0, 500) ?? null; } catch { return String(v).slice(0, 500); }
}

export function createJobRunner(ctx) {
  const jobs = [];
  const running = new Set();
  const timers = [];

  function define(name, everyMs, run, { atStart = false, quiet = false } = {}) {
    if (jobs.some((j) => j.name === name)) throw new Error(`Two jobs are named ${name}`);
    jobs.push({ name, everyMs, run, atStart, quiet });
  }
  const byName = (name) => jobs.find((j) => j.name === name);

  // Take the job's lease for 90% of an interval. One conditional upsert, so exactly one copy wins.
  function claim(j, now = Date.now(), force = false) {
    const r = ctx.db.run(`INSERT INTO job_state (job, lease_until, holder) VALUES (?, ?, ?)
      ON CONFLICT(job) DO UPDATE SET lease_until = excluded.lease_until, holder = excluded.holder
      WHERE ? OR job_state.lease_until IS NULL OR job_state.lease_until <= ?`, j.name, iso(now + Math.round(j.everyMs * 0.9)), INSTANCE, force ? 1 : 0, iso(now));
    return Number(r.changes) === 1;
  }

  // Runs a job once and records it. Never throws. Returns the run, or null if another run holds the job.
  async function runJob(j, { trigger = 'schedule', force = false } = {}) {
    if (running.has(j.name) || !claim(j, Date.now(), force)) return null;
    running.add(j.name);
    const t0 = Date.now();
    let status, result = null, error = null;
    try {
      const out = await j.run();
      status = out && typeof out === 'object' && out.skipped ? 'skipped' : 'ok';
      result = summarize(out);
    } catch (e) {
      status = 'failed';
      error = String(e?.stack ?? e).slice(0, 2000);
      console.error(`[job ${j.name}]`, e?.message ?? e);
    } finally { running.delete(j.name); }
    const run = { id: newId('jrun'), job: j.name, trigger, status, started_at: iso(t0), finished_at: iso(), duration_ms: Date.now() - t0, result, error, instance: INSTANCE };
    try {
      if (!(j.quiet && status !== 'failed' && trigger === 'schedule')) {
        ctx.db.run('INSERT INTO job_runs (id, job, trigger, status, started_at, finished_at, duration_ms, result, error, instance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          run.id, run.job, run.trigger, run.status, run.started_at, run.finished_at, run.duration_ms, run.result, run.error, run.instance);
      }
      await afterRun(j, status, error);
    } catch (e) { console.error(`[job ${j.name}] could not record the run:`, e.message); }
    return run;
  }

  async function afterRun(j, status, error) {
    if (status === 'skipped') return;
    const st = ctx.db.get('SELECT * FROM job_state WHERE job = ?', j.name);
    const owners = ctx.db.all(`SELECT name, email FROM users WHERE role = 'owner' AND active = 1`);
    const link = ctx.publicUrl ? `\n\nSee the run history under Settings → Backups & jobs:\n${ctx.publicUrl.replace(/\/$/, '')}/#/settings?tab=backups` : '\n\nSee the run history under Settings → Backups & jobs.';
    if (status === 'ok') {
      ctx.db.run('UPDATE job_state SET fail_streak = 0, last_ok_at = ?, alerted_at = NULL WHERE job = ?', iso(), j.name);
      if (!st?.alerted_at) return;
      const n = `${st.fail_streak} failed run${st.fail_streak === 1 ? '' : 's'}`;
      audit(ctx, { actor_type: 'system', actor_name: 'Background jobs', action: 'job recovered', target: j.name, status: 200 });
      for (const o of owners) await sendEmail(ctx, { to: o.email, subject: `Fixed: "${j.name}" is running again`, text: `Hi ${o.name},\n\nThe background job "${j.name}" ran successfully again after ${n}. Nothing more to do.${link}` });
      return;
    }
    const streak = (st?.fail_streak ?? 0) + 1;
    const due = !st?.alerted_at || Date.now() - Date.parse(st.alerted_at) >= REALERT_MS;
    ctx.db.run('UPDATE job_state SET fail_streak = ?, alerted_at = ? WHERE job = ?', streak, due ? iso() : st.alerted_at, j.name);
    if (!due) return;
    audit(ctx, { actor_type: 'system', actor_name: 'Background jobs', action: 'job failed', target: j.name, status: 500 });
    const since = st?.last_ok_at ? `It last worked ${st.last_ok_at.slice(0, 16).replace('T', ' ')} UTC.` : 'It has not worked yet on this server.';
    for (const o of owners) {
      await sendEmail(ctx, { to: o.email, subject: `Background job failed: ${j.name}`,
        text: `Hi ${o.name},\n\nThe background job "${j.name}" failed${streak > 1 ? ` (${streak} runs in a row)` : ''}:\n\n${firstLine(error)}\n\n${since} It runs every ${every(j.everyMs)} and keeps retrying. You'll get one reminder a day while it keeps failing, and an email when it recovers.${link}` });
    }
  }

  const prune = () => ctx.db.run('DELETE FROM job_runs WHERE started_at < ?', iso(Date.now() - KEEP_DAYS * 86400e3));

  function start() {
    try { prune(); } catch (e) { console.error('[jobs] prune', e.message); }
    for (const j of jobs) {
      if (j.atStart) runJob(j);
      timers.push(setInterval(() => runJob(j), j.everyMs));
    }
    timers.push(setInterval(() => { try { prune(); } catch (e) { console.error('[jobs] prune', e.message); } }, 6 * 3600e3));
  }
  const stop = () => { timers.forEach(clearInterval); timers.length = 0; };

  // Health of every job, for the owner's Staff & security page.
  function status() {
    return jobs.map((j) => {
      const st = ctx.db.get('SELECT * FROM job_state WHERE job = ?', j.name) ?? {};
      const recent = ctx.db.all('SELECT id, trigger, status, started_at, finished_at, duration_ms, result, error FROM job_runs WHERE job = ? ORDER BY started_at DESC, rowid DESC LIMIT 10', j.name);
      const lastRunAt = [recent[0]?.started_at, st.last_ok_at].filter(Boolean).sort().pop() ?? null;
      return {
        name: j.name, every_seconds: j.everyMs / 1000, running: running.has(j.name),
        health: st.fail_streak ? 'failing' : lastRunAt ? 'ok' : 'waiting',
        fail_streak: st.fail_streak ?? 0, last_ok_at: st.last_ok_at ?? null, last_run_at: lastRunAt,
        last_error: st.fail_streak ? firstLine(recent.find((r) => r.status === 'failed')?.error) : null, recent
      };
    });
  }

  async function runNow(name) {
    const j = byName(name);
    if (!j) throw notFound('Job');
    const r = await runJob(j, { trigger: 'manual', force: true });
    if (!r) throw conflict(`${name} is already running. Try again when it finishes.`);
    return r;
  }

  return { define, byName, runJob, claim, start, stop, status, runNow, prune, jobs, INSTANCE };
}
