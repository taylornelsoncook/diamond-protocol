// Demo data for Staff & security: a front desk hire who hasn't signed in yet, a coach who left (turned off),
// sign-ins on a few devices, and some failed sign-ins so the security summary has something to show.
'use strict';
const crypto = require('crypto');
const { get, run, insert, tx } = require('../db');
const { sha256 } = require('../lib');
const { hashPassword, tempPassword } = require('../auth');
require('../services/ops-staff'); // sign-in and device columns on older databases

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0',
};
const ago = (h) => new Date(Date.now() - h * 36e5);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function seed() {
  const coach = get("SELECT * FROM staff WHERE email='coach@demo.test'");
  const desk = get("SELECT * FROM staff WHERE email='desk@demo.test'");
  const owner = get("SELECT * FROM staff WHERE email='owner@demo.test'");
  if (!coach || !desk || !owner) return;
  tx(() => {
    insert('staff', { name: 'Sam Ortiz', email: 'sam.ortiz@demo.test', role: 'frontdesk', pw_hash: hashPassword(tempPassword()), must_change: 1, active: 1, created_at: sqlTime(ago(50)) });
    const drew = insert('staff', { name: 'Drew Kim', email: 'drew.kim@demo.test', role: 'coach', pw_hash: hashPassword(tempPassword()), must_change: 0, active: 0, created_at: sqlTime(ago(24 * 200)), last_signin_at: ago(24 * 40).toISOString(), last_signin_ip: '172.58.12.40' });
    // Turned off before hand-overs existed: still holds a block of Saturday private hours (not offered to parents),
    // so the list flags the account with "Hand over their sessions".
    const loc = get("SELECT id FROM locations WHERE archived=0 ORDER BY id LIMIT 1");
    insert('availability', { kind: 'private', weekday: 6, start_time: '09:00', end_time: '11:00', slot_min: 60, location_id: loc?.id ?? null, coach_id: drew });

    // Other people's devices (the owner's own session appears when they sign in).
    const device = (s, ua, ip, signedInH, seenH) => insert('auth_sessions', {
      token_hash: sha256(crypto.randomBytes(24).toString('hex')), kind: 'staff', user_id: s.id, ip, user_agent: ua,
      created_at: sqlTime(ago(signedInH)), last_seen: ago(seenH).toISOString(), expires_at: new Date(Date.now() + 10 * 864e5).toISOString(),
    });
    device(coach, UA.iphone, '172.58.20.11', 30, 1);
    device(coach, UA.ipad, '67.166.4.21', 72, 20);
    device(desk, UA.windows, '67.166.4.21', 5, 0.2);
    run('UPDATE staff SET last_signin_at=?, last_signin_ip=? WHERE id=?', ago(30).toISOString(), '172.58.20.11', coach.id);
    run('UPDATE staff SET last_signin_at=?, last_signin_ip=? WHERE id=?', ago(5).toISOString(), '67.166.4.21', desk.id);

    const act = (actor, action, detail, kind, h, ip) => insert('activity', { actor, action, detail, kind, ip, created_at: sqlTime(ago(h)) });
    act(`${coach.name} (coach)`, 'Signed in', null, 'signin', 72, '67.166.4.21');
    act(`${coach.name} (coach)`, 'Signed in', null, 'signin', 30, '172.58.20.11');
    act('System', 'Sign-in failed', desk.email, 'signin', 5.2, '67.166.4.21');
    act(`${desk.name} (frontdesk)`, 'Signed in', null, 'signin', 5, '67.166.4.21');
    for (const h of [3.1, 3.05, 3]) act('System', 'Sign-in failed', 'admin@demo.test', 'signin', h, '185.220.101.7');
    act(`${desk.name} (frontdesk)`, 'Refused', 'POST /api/programs', 'refused', 4, '67.166.4.21');
    act(`${owner.name} (owner)`, 'Added staff member', 'Sam Ortiz (Front desk), sam.ortiz@demo.test', 'change', 50, '67.166.4.20');
    act(`${owner.name} (owner)`, 'Turned off account', 'Drew Kim: signed out everywhere', 'change', 24 * 21, '67.166.4.20');
  });
}

module.exports = { seed };
