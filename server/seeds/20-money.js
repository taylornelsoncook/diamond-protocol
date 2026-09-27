// Demo money data: past membership charges (two declined), school invoices (paid by check, paid online, overdue, open)
// and a few weeks of team-session attendance. Sales belong to the floor seed.
'use strict';
const { get, all, run, insert, tx } = require('../db');
const { nextInvoiceNumber, randomToken, today, addDays, addMonths, money, businessName, appUrl, monthLabel } = require('../lib');
const schools = require('../services/money-schools');

function seed() {
  const T = today();
  if (get("SELECT 1 FROM invoices WHERE kind IN ('membership','school') LIMIT 1")) return; // already seeded
  const rows = [];

  // ---- membership history ----
  const members = all(`SELECT m.*, p.name AS plan_name, a.first_name, a.last_name, a.family_id, f.card_last4
    FROM memberships m JOIN plans p ON p.id=m.plan_id JOIN athletes a ON a.id=m.athlete_id LEFT JOIN families f ON f.id=a.family_id
    WHERE m.status IN ('active','past_due','paused') ORDER BY m.id`);
  const parkOlivia = members.find((m) => m.first_name === 'Olivia' && m.last_name === 'Park');
  for (const m of members) {
    const dates = [];
    for (let k = 0; k < 24; k++) { const d = addMonths(m.started_at, k); if (d >= T) break; dates.push(d); }
    const declines = m.card_last4 === '0002' || m === parkOlivia;
    dates.forEach((d, i) => {
      const last = i === dates.length - 1;
      if (declines && last) {
        const issued = addDays(T, m === parkOlivia ? -1 : -4);
        rows.push({ date: issued, inv: { kind: 'membership', family_id: m.family_id, athlete_id: m.athlete_id, membership_id: m.id, description: `${m.plan_name}: ${monthLabel(issued)}`,
          amount_cents: m.price_cents, status: 'failed', issued_at: issued, period: issued.slice(0, 7), pay_method: 'card',
          attempts: m === parkOlivia ? 1 : 2, next_retry: addDays(T, m === parkOlivia ? 2 : 1) } });
        return;
      }
      rows.push({ date: d, inv: { kind: 'membership', family_id: m.family_id, athlete_id: m.athlete_id, membership_id: m.id, description: `${m.plan_name}: ${monthLabel(d)}`,
        amount_cents: m.price_cents, status: 'paid', issued_at: d, period: d.slice(0, 7), paid_at: `${d}T15:00:00.000Z`, pay_method: 'card', charge_id: 'ch_test_' + randomToken(9), attempts: 1 } });
    });
  }
  if (parkOlivia) run("UPDATE memberships SET status='past_due' WHERE id=?", parkOlivia.id);

  // ---- contract details added after launch: billing phones, a club, staff notes ----
  run("UPDATE team_contracts SET billing_phone='(801) 555-0142', notes='Dana wants the PO number on every invoice. Checks come from the district office, usually in the first week.' WHERE team_name='Riverside Varsity Football'");
  run("UPDATE team_contracts SET billing_phone='(801) 555-0187' WHERE team_name='Summit Elite 16U'");
  run("UPDATE schools SET kind='club', contact_phone='(801) 555-0187' WHERE name='Summit Elite Baseball Club'");
  run("UPDATE schools SET contact_phone='(801) 555-0142' WHERE name='Riverside High School'");

  // ---- school invoices ----
  const contracts = all('SELECT * FROM team_contracts ORDER BY id');
  const plans = {
    0: [{ paid: 'check', check: '20431' }, { paid: 'check', check: '20588' }, { paid: 'ach' }, {}], // Riverside: current month open
    1: [{ paid: 'check', check: '1187' }, { overdue: true }, {}], // Summit: last month overdue
  };
  contracts.forEach((c, ci) => {
    const periods = schools.periodStarts(c, T);
    periods.forEach((p, k) => {
      const how = (plans[ci] || [])[k] || {};
      const due = addDays(p, c.terms_days ?? 30);
      const inv = { kind: 'school', contract_id: c.id, description: `${c.team_name} training, ${schools.fmtLong(p)} – ${schools.fmtLong(schools.periodEnd(p))}`,
        amount_cents: c.monthly_cents, status: how.paid ? 'paid' : 'open', issued_at: p, due_date: due, period: p };
      if (how.paid) { inv.pay_method = how.paid; inv.check_number = how.check || null; inv.paid_at = `${addDays(p, how.paid === 'ach' ? 3 : 12)}T18:00:00.000Z`; }
      if (how.overdue) inv.last_reminder = addDays(T, -3);
      rows.push({ date: p, inv, email: c.billing_email });
    });
  });

  tx(() => {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const r of rows) {
      const view_token = randomToken(16);
      const number = nextInvoiceNumber('DP');
      insert('invoices', { number, view_token, created_at: `${r.date} 15:00:00`, ...r.inv });
      if (r.email) {
        insert('outbox', { to_email: r.email, subject: `Invoice ${number} from ${businessName()}: ${money(r.inv.amount_cents)}`,
          body: `Here is invoice ${number} for ${money(r.inv.amount_cents)}.\n\n${r.inv.description}\n\nView, print or pay online:\n${appUrl()}/invoice/${view_token}`, created_at: `${r.date} 15:05:00` });
        if (r.inv.last_reminder) insert('outbox', { to_email: r.email, subject: `Reminder: invoice ${number} is past due`, body: `Invoice ${number} is still open.\n\n${appUrl()}/invoice/${view_token}`, created_at: `${r.inv.last_reminder} 16:00:00` });
      }
    }

    // ---- past team sessions with check-ins, so roster attendance has something to show ----
    const teamClass = get("SELECT * FROM classes WHERE type='team' AND team_id IS NOT NULL ORDER BY id LIMIT 1");
    if (teamClass) {
      const days = String(teamClass.weekdays).split(',').map(Number);
      const roster = all('SELECT id FROM athletes WHERE team_id=? ORDER BY id', teamClass.team_id);
      let n = 0;
      for (let d = addDays(T, -28); d < T; d = addDays(d, 1)) {
        if (!days.includes(new Date(d + 'T12:00:00').getDay())) continue;
        const starts_at = `${d}T${teamClass.start_time}`;
        if (get('SELECT 1 FROM events WHERE class_id=? AND starts_at=?', teamClass.id, starts_at)) continue;
        const eid = insert('events', { class_id: teamClass.id, type: 'team', name: teamClass.name, starts_at, duration_min: teamClass.duration_min, capacity: teamClass.capacity, location_id: teamClass.location_id, team_id: teamClass.team_id, coach_id: teamClass.coach_id });
        roster.forEach((a, i) => {
          const here = (i * 7 + n * 3) % 10 < 8; // most players, most days
          insert('bookings', { event_id: eid, athlete_id: a.id, status: 'booked', coverage: 'team', source: 'team', checked_in_at: here ? `${d}T22:35:00.000Z` : null, created_at: `${d} 20:00:00` });
        });
        n++;
      }
    }
    // ---- a partial refund and a card reminder, so Billing's Refunds view and reminders have something to show ----
    const chidi = get(`SELECT i.id FROM invoices i JOIN athletes a ON a.id=i.athlete_id WHERE a.first_name='Chidi' AND a.last_name='Okafor'
      AND i.kind='membership' AND i.status='paid' ORDER BY i.id DESC LIMIT 1`);
    if (chidi) {
      require('../services/billing').refundInvoice(chidi.id, 5000);
      insert('activity', { actor: 'System', action: 'Refunded invoice', detail: 'Chidi Okafor · $50 · missed a week for a tournament', kind: 'change' });
    }
    const kevin = get(`SELECT i.id, i.family_id, i.amount_cents FROM invoices i JOIN athletes a ON a.id=i.athlete_id WHERE a.first_name='Kevin' AND a.last_name='Nguyen' AND i.status='failed' LIMIT 1`);
    const kevinEmail = kevin && get('SELECT email FROM parents WHERE family_id=? ORDER BY is_self DESC, id LIMIT 1', kevin.family_id)?.email;
    if (kevinEmail) {
      run('UPDATE invoices SET last_reminder=? WHERE id=?', addDays(T, -2), kevin.id);
      insert('outbox', { to_email: kevinEmail, subject: `Please update your card: ${money(kevin.amount_cents)} didn't go through`, body: `Hi,\n\nWe couldn't charge your card, so this payment is still due.\n\nTo add or update your card, sign in to the parent portal and open the Family tab:\n${appUrl()}/parent\n\n${businessName()}`, created_at: `${addDays(T, -2)} 16:00:00` });
    }
    insert('activity', { actor: 'System', action: 'Demo billing loaded', detail: `${rows.length} invoices`, kind: 'change' });
  });
}

module.exports = { seed };
