// Fixes from the pre-iOS audit (November 2026): staff at the counter can read a plan's quote, front desk can read the
// game-week rules, a locked-out family can still read, change or withdraw the photo and video release, and a team
// calendar brought in for the game-week helper reads its times in the business's own time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../src/services/security.js';
import { OPEN_WHILE_LOCKED } from '../src/services/lockout.js';
import { createApp } from '../src/server.js';
import { createClient } from '../src/services/clients.js';
import { previewSchedule } from '../src/services/gameweek.js';

test('coaches and front desk can read what starting a plan today charges, and nothing else under plans', () => {
  for (const role of ['coach', 'front_desk']) {
    assert.equal(can(role, 'GET', '/v1/plans/:id/quote'), true, role);
    assert.equal(can(role, 'GET', '/v1/plans'), true, role);
    assert.equal(can(role, 'PATCH', '/v1/plans/:id'), false, role);
    assert.equal(can(role, 'POST', '/v1/plans'), false, role);
  }
});

test('front desk reads the game-week rules but never changes them', () => {
  assert.equal(can('front_desk', 'GET', '/v1/game-rules'), true);
  assert.equal(can('front_desk', 'PATCH', '/v1/game-rules'), false);
  assert.equal(can('coach', 'PATCH', '/v1/game-rules'), false);
});

test('the photo and video release stays open while a family is locked out', () => {
  for (const r of ['GET /portal/api/media-release', 'POST /portal/api/athletes/:id/media-release', 'DELETE /portal/api/athletes/:id/media-release']) assert.ok(OPEN_WHILE_LOCKED.has(r), r);
});

test('a team calendar is read in the business time zone setting', async () => {
  const app = createApp({ testMode: true, jobs: false });
  try {
    const ctx = app.ctx;
    ctx.now = () => '2026-11-20T18:00:00.000Z';
    const c = await createClient(ctx, { name: 'Zone Tester', birth_date: '2010-01-01', parent: { name: 'Zone Parent', email: 'zone.parent@example.com' }, send_welcome: false });
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:z1', 'DTSTART:20261201T063000Z', 'SUMMARY:Game vs Late', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    ctx.db.run(`INSERT INTO settings (key, value) VALUES ('timezone', 'America/Chicago') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    assert.equal(previewSchedule(ctx, c.id, { text: ics }).items[0].date, '2026-12-01');   // 12:30 am in Chicago
    ctx.db.run(`UPDATE settings SET value = 'America/Denver' WHERE key = 'timezone'`);
    assert.equal(previewSchedule(ctx, c.id, { text: ics }).items[0].date, '2026-11-30');   // 11:30 pm in Denver
  } finally { app.close?.(); }
});
