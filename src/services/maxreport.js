import { v } from '../util.js';
import { latestMax, LOAD_TESTS } from './programs.js';
import { estimatedMax } from './maxes.js';
import { csvCell } from './security.js';

// The max report (the builder redesign, step 4, from the owner's screenshot): athletes down, lifts across, a total per
// athlete and an average per lift. A lift is any active test whose one metric is a load in pounds (the 1RM tests the
// library ships with, and the coach's own). The number is the max on file (a testing day's result or one typed on the
// profile, newest first); where there is none, the estimate from logged sets stands in, marked so. Owners and coaches.
// The built-in 3-rep max is left out: it isn't one lift (the lift is named in the notes), so its numbers can't be a column.
export function lifts(ctx) {
  const rows = ctx.db.all(`SELECT t.key, t.name FROM perf_tests t WHERE t.active = 1
    AND (SELECT COUNT(*) FROM perf_metrics m WHERE m.test_id = t.id) = 1
    AND EXISTS (SELECT 1 FROM perf_metrics m WHERE m.test_id = t.id AND m.key = 'load' AND m.unit = 'lb')
    AND (t.builtin = 0 OR t.key IN (${Object.keys(LOAD_TESTS).map(() => '?').join(', ')})) ORDER BY t.sort, t.name`, ...Object.keys(LOAD_TESTS));
  const order = Object.keys(LOAD_TESTS);
  return rows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99)).map((t) => ({ key: t.key, name: t.name.replace(/\s*1RM$/i, ''), lift: LOAD_TESTS[t.key] ?? null }));
}
export function maxReport(ctx, { contract_id, program_id, estimates = true } = {}) {
  const where = ['c.archived_at IS NULL'], args = [];
  if (contract_id) { where.push('c.id IN (SELECT client_id FROM team_roster WHERE contract_id = ? AND active = 1)'); args.push(v.str(contract_id, 'contract_id')); }
  if (program_id) { where.push('c.id IN (SELECT client_id FROM assignments WHERE program_id = ? AND active = 1)'); args.push(v.str(program_id, 'program_id')); }
  if (!contract_id && !program_id) where.push(`(c.id IN (SELECT client_id FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due')) OR c.id IN (SELECT client_id FROM assignments WHERE active = 1) OR c.id IN (SELECT client_id FROM team_roster WHERE active = 1))`);
  const clients = ctx.db.all(`SELECT c.id, c.name, c.athlete_id FROM clients c WHERE ${where.join(' AND ')} ORDER BY c.name COLLATE NOCASE`, ...args);
  const cols = lifts(ctx);
  const useEst = estimates !== false && estimates !== 'false';
  const rows = clients.map((c) => {
    const maxes = {};
    let total = 0, estimated = false;
    for (const l of cols) {
      const on = latestMax(ctx, c.id, l.key);
      let cell = on ? { value: on.value, date: on.recorded_at.slice(0, 10), estimated: false } : null;
      if (!cell && useEst && LOAD_TESTS[l.key]) { const e = estimatedMax(ctx, c.id, l.key); if (e) { cell = { value: e.value, date: e.date.slice(0, 10), estimated: true, from: e.from }; } }
      maxes[l.key] = cell;
      if (cell) { total += cell.value; if (cell.estimated) estimated = true; }
    }
    return { id: c.id, name: c.name, athlete_id: c.athlete_id, maxes, total: total || null, estimated };
  });
  const averages = {};
  for (const l of cols) { const xs = rows.map((r) => r.maxes[l.key]?.value).filter((x) => x != null); averages[l.key] = xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null; }
  const totals = rows.map((r) => r.total).filter((x) => x != null);
  return { lifts: cols, athletes: rows, averages, average_total: totals.length ? Math.round((totals.reduce((s, x) => s + x, 0) / totals.length) * 10) / 10 : null, with_estimates: useEst };
}
export function maxReportCsv(ctx, query = {}) {
  const r = maxReport(ctx, query);
  const head = ['Athlete', 'Athlete ID', ...r.lifts.map((l) => `${l.name} (lb)`), 'Total'];
  const line = (cells) => cells.map(csvCell).join(',');
  const body = [line(head), ...r.athletes.map((a) => line([a.name, a.athlete_id ?? '', ...r.lifts.map((l) => (a.maxes[l.key] ? `${a.maxes[l.key].value}${a.maxes[l.key].estimated ? ' (est.)' : ''}` : '')), a.total ?? ''])),
    line(['Average', '', ...r.lifts.map((l) => r.averages[l.key] ?? ''), r.average_total ?? ''])].join('\r\n') + '\r\n';
  return { __file: { type: 'text/csv; charset=utf-8', filename: 'max-report.csv', body } };
}
