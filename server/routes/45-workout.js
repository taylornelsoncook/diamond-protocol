// Athlete workout app, continued (/api/w/:token): logging sets, reopening a finished workout, and past workout detail.
// The core routes (state, log, finish) live with programs in 40-programs.js. No sign-in: the private token is the key.
'use strict';
const { get } = require('../db');
const { h, notFound } = require('../lib');
const workout = require('../services/ops-workout');

function byToken(token) {
  if (!/^[\w-]{8,64}$/.test(String(token || ''))) throw notFound('That workout link');
  const a = get('SELECT * FROM athletes WHERE workout_token=? AND archived=0', token);
  if (!a) throw notFound('That workout link');
  return a;
}
const noStore = (res) => res.set('Cache-Control', 'no-store');

function routes(api) {
  api.post('/w/:token/set', h(async (req, res) => {
    noStore(res);
    res.json(workout.logSet(byToken(req.params.token), req.body || {}));
  }));
  api.post('/w/:token/reopen', h(async (req, res) => {
    noStore(res);
    res.json({ ok: true, state: workout.reopen(byToken(req.params.token), req.body || {}, req.ip) });
  }));
  api.get('/w/:token/history/:id', h(async (req, res) => {
    noStore(res);
    res.json(workout.historyDetail(byToken(req.params.token), req.params.id));
  }));
}

module.exports = { routes };
