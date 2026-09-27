// Floor demo data: sessions for the next weeks, bookings (some unpaid, some checked in), a waitlist,
// past check-ins so "gone quiet" means something, and this month's sales across locations.
'use strict';
const { get, all, run, insert, update, tx } = require('../db');
const { addDays, ageOn } = require('../lib');
const booking = require('../services/booking');
const billing = require('../services/billing');
require('../services/floor-util'); // time off table and session notes

function seed() {
  const coach = get("SELECT id FROM staff WHERE role='coach' ORDER BY id LIMIT 1");
  const desk = get("SELECT id FROM staff WHERE role='frontdesk' ORDER BY id LIMIT 1");
  const owner = get("SELECT id FROM staff WHERE role='owner' ORDER BY id LIMIT 1");
  if (!owner) return; // demo base data wasn't loaded
  booking.generateEvents();
  const T = booking.todayLocal();
  const loc = Object.fromEntries(all('SELECT id, kind FROM locations WHERE archived=0 ORDER BY id').map((l) => [l.kind, l.id]));
  const ath = Object.fromEntries(all('SELECT * FROM athletes').map((a) => [`${a.first_name} ${a.last_name}`, a]));
  const A = (n) => ath[n];
  // Demo bookings respect each class's age range, as a parent's booking would.
  const fits = (a, classId, day) => {
    const c = classId && get('SELECT min_age, max_age FROM classes WHERE id=?', classId);
    const age = ageOn(a.birthday, day);
    return !c || age == null || !((c.min_age && age < c.min_age) || (c.max_age && age > c.max_age));
  };
  const tryBook = (eid, name, opts = {}) => {
    const a = A(name); if (!a) return null;
    const e = get('SELECT class_id, starts_at FROM events WHERE id=?', eid);
    if (e && !fits(a, e.class_id, e.starts_at.slice(0, 10))) return null;
    try { return booking.book(eid, a.id, { quiet: true, ...opts }); } catch { return null; } };

  tx(() => {
    // Something on the floor today, whatever day it is.
    let today = all("SELECT * FROM events WHERE substr(starts_at,1,10)=? AND cancelled=0 AND type IN ('class','camp','clinic') ORDER BY starts_at", T);
    if (!today.length) {
      const id = insert('events', { type: 'class', name: 'Open training', starts_at: `${T}T17:30`, duration_min: 60, capacity: 12, price_cents: 3000, location_id: loc.facility, coach_id: coach?.id });
      today = [get('SELECT * FROM events WHERE id=?', id)];
    }
    const nowISO = new Date().toISOString();
    const first = today[0];
    for (const n of ['Ava Lopez', 'Emma Jensen', 'Isabela Silva', 'Kevin Nguyen', 'Mason Harper', 'Daniel Reyes']) tryBook(first.id, n);
    for (const n of ['Ava Lopez', 'Emma Jensen']) {
      const b = get("SELECT id FROM bookings WHERE event_id=? AND athlete_id=? AND status='booked'", first.id, A(n)?.id);
      if (b) update('bookings', b.id, { checked_in_at: nowISO });
    }
    if (today[1]) for (const n of ['Chidi Okafor', 'Jaylen Brooks', 'Olivia Park']) tryBook(today[1].id, n);

    // Upcoming sessions this week and next: a few bookings each, some unpaid.
    const upcoming = all("SELECT * FROM events WHERE substr(starts_at,1,10)>? AND substr(starts_at,1,10)<=? AND cancelled=0 AND type IN ('class','clinic') ORDER BY starts_at", T, addDays(T, 10));
    const pool = ['Ava Lopez', 'Chidi Okafor', 'Emma Jensen', 'Nate Jensen', 'Kevin Nguyen', 'Isabela Silva', 'Jaylen Brooks', 'Olivia Park', 'Daniel Reyes', 'Mason Harper'];
    upcoming.forEach((e, i) => {
      for (let k = 0; k < 2 + (i % 3); k++) tryBook(e.id, pool[(i * 3 + k) % pool.length]);
    });
    // A full session with a waitlist.
    const park = all("SELECT e.* FROM events e JOIN classes c ON c.id=e.class_id WHERE c.name='Park Sprint Club' AND substr(e.starts_at,1,10)>? ORDER BY e.starts_at LIMIT 1", T)[0];
    if (park) {
      update('events', park.id, { capacity: 3 });
      run("UPDATE bookings SET status='cancelled' WHERE event_id=?", park.id);
      for (const n of ['Chidi Okafor', 'Jaylen Brooks', 'Kevin Nguyen', 'Olivia Park']) tryBook(park.id, n);
    }
    // Team sessions: nobody booked yet (the roster comes from the team).

    // Past sessions with check-ins, so "last seen" is real. Olivia and Nate have gone quiet.
    const lastSeen = { 'Ava Lopez': 2, 'Chidi Okafor': 1, 'Emma Jensen': 3, 'Jaylen Brooks': 2, 'Kevin Nguyen': 5, 'Daniel Reyes': 1, 'Isabela Silva': 4, 'Nate Jensen': 16, 'Olivia Park': 20 };
    const hs = get("SELECT * FROM classes WHERE name='High School Performance'");
    const youth = get("SELECT * FROM classes WHERE name='Youth Speed & Agility'");
    for (let d = 1; d <= 24; d++) {
      const day = addDays(T, -d);
      const wd = new Date(day + 'T12:00:00').getDay();
      for (const c of [youth, hs]) {
        if (!c || !String(c.weekdays).split(',').map(Number).includes(wd)) continue;
        if (get('SELECT 1 FROM events WHERE class_id=? AND starts_at=?', c.id, `${day}T${c.start_time}`)) continue;
        const eid = insert('events', { class_id: c.id, type: c.type, name: c.name, starts_at: `${day}T${c.start_time}`, duration_min: c.duration_min, capacity: c.capacity, price_cents: c.price_cents, location_id: c.location_id, coach_id: c.coach_id });
        for (const [n, ago] of Object.entries(lastSeen)) {
          if (d < ago || (d - ago) % 5 !== 0) continue; // attended on their last-seen day and every so often before it
          const a = A(n);
          if (!a || !fits(a, c.id, day)) continue;
          insert('bookings', { event_id: eid, athlete_id: a.id, status: 'booked', coverage: a.group_credits > 0 ? 'credit' : 'member', source: 'staff', checked_in_at: `${day}T${c.start_time}:00.000Z` });
        }
      }
    }

    // This month's sales across locations.
    const month0 = T.slice(0, 7) + '-01';
    const daysIntoMonth = Math.round((new Date(T + 'T12:00:00') - new Date(month0 + 'T12:00:00')) / 864e5);
    const product = (name) => get('SELECT * FROM products WHERE name=?', name);
    const sale = ({ ago, kind, who, items, method, staff, discount = 0, receipt = false }) => {
      const a = who ? A(who) : null;
      const lines = items.map(([pname, qty = 1]) => { const p = product(pname); return p ? { product_id: p.id, name: p.name, kind: p.kind, credits: p.credits, qty, price_cents: p.price_cents } : null; }).filter(Boolean);
      if (!lines.length || !loc[kind]) return;
      if (discount) lines.push({ name: 'Discount 10% (Sibling)', kind: 'discount', qty: 1, price_cents: -discount });
      const total = lines.reduce((n, l) => n + l.price_cents * l.qty, 0);
      const r = billing.charge({ family_id: a?.family_id || null, athlete_id: a?.id || null, amount_cents: total, description: lines.map((l) => l.name).join(', '), method });
      if (!r.ok) return;
      if (a) for (const l of lines) billing.applyProduct(a.id, l, l.qty);
      const day = addDays(T, -Math.min(ago, daysIntoMonth));
      const created = ago === 0 ? null : `${day} 18:${String(10 + ago).padStart(2, '0')}:00`;
      const row = { location_id: loc[kind], athlete_id: a?.id || null, family_id: a?.family_id || null, items: JSON.stringify(lines), total_cents: total, discount_cents: discount, method, status: 'paid', charge_id: r.charge_id, staff_id: staff?.id || owner.id };
      if (created) row.created_at = created;
      if (receipt) row.receipt_sent_at = new Date().toISOString();
      insert('sales', row);
    };
    sale({ ago: 12, kind: 'facility', who: 'Isabela Silva', items: [['10-session group pack']], method: 'tap', staff: desk });
    sale({ ago: 9, kind: 'mobile', who: 'Chidi Okafor', items: [['5 private sessions']], method: 'card', staff: coach });
    sale({ ago: 6, kind: 'park', who: 'Olivia Park', items: [['Drop-in group session']], method: 'cash', staff: coach });
    sale({ ago: 5, kind: 'park', items: [['Speed parachute']], method: 'tap', staff: coach });
    sale({ ago: 3, kind: 'facility', who: 'Emma Jensen', items: [['DP training shirt'], ['Water bottle']], method: 'card', staff: desk });
    sale({ ago: 2, kind: 'facility', who: 'Nate Jensen', items: [['10-session group pack']], method: 'card', staff: desk, discount: 2500, receipt: true });
    sale({ ago: 1, kind: 'facility', items: [['DP training shirt']], method: 'cash', staff: desk });
    sale({ ago: 0, kind: 'facility', who: 'Daniel Reyes', items: [['Private session']], method: 'card', staff: desk });
    sale({ ago: 0, kind: 'facility', items: [['Water bottle', 2]], method: 'cash', staff: desk });

    for (const [actor, action, detail] of [
      ['Riley Tran (frontdesk)', 'Checked in', `Ava Lopez · ${first.name}`],
      ['Riley Tran (frontdesk)', 'Checked in', `Emma Jensen · ${first.name}`],
      ['Riley Tran (frontdesk)', 'Took payment', 'Walk-in · $30 · 2 × Water bottle · Provo facility · Cash'],
    ]) insert('activity', { actor, action, detail, kind: 'change' });

    // Two team athletes with birthdays this week (one today), so Today's birthday list has something to show.
    for (const [n, ahead] of [['Tyler Jacobs', 0], ['Marcus Bell', 3]]) {
      const a = A(n);
      if (a && !a.birthday) { const md = addDays(T, ahead).slice(5); update('athletes', a.id, { birthday: `${md === '02-29' ? 2008 : 2009}-${md}` }); }
    }

    // Schedule extras: a staff note on today's session, a one-off makeup session and a coach's day off.
    update('events', first.id, { staff_note: 'Sled work today. Set up the turf lane before the session starts.' });
    insert('events', { type: 'class', name: 'Makeup: Park Sprint Club', starts_at: `${addDays(T, 5)}T10:00`, duration_min: 45, capacity: 10, price_cents: 2500,
      location_id: loc.park || loc.facility, coach_id: coach?.id, staff_note: 'Makeup for the rained-out Friday session.' });
    if (coach) insert('time_off', { coach_id: coach.id, start_date: addDays(T, 9), end_date: addDays(T, 9), note: 'Coaching clinic in Salt Lake City' });
  });
}

module.exports = { seed };
