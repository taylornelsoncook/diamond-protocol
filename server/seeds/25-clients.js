// Clients demo data: grad years and phones, staff notes (one pinned at the top of Ava's profile, one coach-only),
// and a former client in Archived so the list's Archived view has someone to restore.
'use strict';
const { get, insert, update } = require('../db');
require('../services/clients'); // phone, grad year and client notes schema

function seed() {
  const owner = get("SELECT id, name FROM staff WHERE role='owner' ORDER BY id LIMIT 1");
  const coach = get("SELECT id, name FROM staff WHERE role='coach' ORDER BY id LIMIT 1");
  const desk = get("SELECT id, name FROM staff WHERE role='frontdesk' ORDER BY id LIMIT 1");
  if (!owner || !coach || !desk) return;
  const A = (first, last) => get('SELECT * FROM athletes WHERE first_name=? AND last_name=?', first, last);

  for (const [first, last, grad] of [['Chidi', 'Okafor', 2027], ['Kevin', 'Nguyen', 2027], ['Jaylen', 'Brooks', 2028], ['Mason', 'Harper', 2028],
    ['Tyler', 'Jacobs', 2027], ['Marcus', 'Bell', 2027], ['Ava', 'Lopez', 2030], ['Emma', 'Jensen', 2029]]) {
    const a = A(first, last);
    if (a) update('athletes', a.id, { grad_year: grad });
  }
  const dan = A('Daniel', 'Reyes');
  if (dan) update('athletes', dan.id, { phone: '385-555-0288' });

  const note = (a, staff, body, extra = {}, daysAgo = 0) => a && insert('client_notes', {
    athlete_id: a.id, staff_id: staff.id, staff_name: staff.name, body, pinned: 0, coach_only: 0,
    created_at: new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 19).replace('T', ' '), ...extra,
  });
  const ava = A('Ava', 'Lopez'), kevin = A('Kevin', 'Nguyen'), mason = A('Mason', 'Harper');
  note(ava, desk, 'Maria picks Ava up at 6:30 on Tuesdays. Ava waits inside, not in the parking lot.', { pinned: 1 }, 6);
  note(ava, coach, 'Landing mechanics much better this month. Ready to add single-leg bounds next block.', { coach_only: 1 }, 2);
  note(kevin, desk, 'Called about the declined card. Dad will update it in the portal this week.', {}, 1);
  note(mason, owner, 'Paused for hockey season. Wants to restart in March.', { pinned: 1 }, 20);

  if (!get("SELECT 1 FROM athletes WHERE first_name='Ryan' AND last_name='Cho'")) {
    const fam = insert('families', { name: 'Cho family' });
    insert('parents', { family_id: fam, name: 'Grace Cho', email: 'grace.cho@example.com', phone: '801-555-0164' });
    insert('athletes', { code: 'RYACHO2026', family_id: fam, first_name: 'Ryan', last_name: 'Cho', birthday: '2010-07-02', sport: 'Baseball',
      position: 'Catcher', school: 'Timpview High', grad_year: 2028, archived: 1, workout_token: 'demo-archived-ryan', created_at: '2025-11-03 17:00:00' });
  }
}

module.exports = { seed };
