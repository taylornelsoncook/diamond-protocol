// Diamond Protocol server: API, background jobs and the web apps.
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
require('./db');
const auth = require('./auth');
const { HttpError } = require('./lib');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));
app.use(cookieParser());
app.use(auth.loadUser);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});

const api = express.Router();
api.use('/auth', auth.router);

// Each file in server/routes exports { routes(api), jobs?: [{ name, everyMin, run }] }.
const jobs = [];
const routeDir = path.join(__dirname, 'routes');
for (const f of fs.readdirSync(routeDir).filter((f) => f.endsWith('.js')).sort()) {
  try {
    const mod = require(path.join(routeDir, f));
    mod.routes(api);
    if (mod.jobs) jobs.push(...mod.jobs);
  } catch (e) {
    if (process.env.NODE_ENV === 'production') throw e;
    console.error(`[routes] skipped ${f}:`, e.message);
  }
}
api.use((_req, _res, next) => next(new HttpError(404, 'No such API endpoint.')));
app.use('/api', api);

// ---- web apps ----
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
const page = (file) => (_req, res) => res.sendFile(path.join(pub, file));
app.get(['/parent', '/parent/*splat'], page('parent/index.html'));
app.get('/w/:token', page('workout/index.html'));
app.get('/report/:code', page('shared/report.html'));
app.get('/invoice/:token', page('shared/invoice.html'));
app.get('/docs/api', page('shared/api-docs.html'));
app.get(['/', '/app', '/app/*splat'], page('coach/index.html'));

// ---- errors ----
app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request body isn\'t valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

// ---- background jobs ----
function runJob(j) {
  try { j.run(); } catch (e) { console.error(`[job ${j.name}]`, e); }
}
function startJobs() {
  for (const j of jobs) {
    runJob(j);
    setInterval(() => runJob(j), j.everyMin * 6e4).unref();
  }
}

if (require.main === module) {
  // Base data always; demo data only when asked (DP_DEMO=1) on an empty database.
  require('./seed').seed({ withDemo: process.env.DP_DEMO === '1' });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Diamond Protocol running at http://localhost:${port}`);
    startJobs();
  });
}

module.exports = { app, jobs, startJobs };
