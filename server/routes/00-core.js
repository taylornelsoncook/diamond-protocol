// Core endpoints shared by every area: first-run setup, settings, activity feed, lookups.
'use strict';
const { get, all, insert, setting, setSetting } = require('../db');
const { h, bad, HttpError, log, payments } = require('../lib');
const { requireStaff, hashPassword } = require('../auth');

const PUBLIC_SETTINGS = ['business_name', 'timezone', 'late_cancel_hours', 'results_visibility', 'business_address', 'pay_instructions', 'waiver_version'];

function routes(api) {
  // First run: no staff yet, so the sign-in page offers to create the owner.
  api.get('/setup', (_req, res) => res.json({ needs_setup: !get('SELECT 1 FROM staff LIMIT 1'), payments_mode: payments.mode(), email_mode: require('../email').mode(), sms_mode: require('../messaging').mode() }));
  api.post('/setup', h(async (req, res) => {
    if (get('SELECT 1 FROM staff LIMIT 1')) throw new HttpError(409, 'Setup is already done.');
    const { password } = req.body;
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase();
    const business_name = String(req.body.business_name || '').trim().slice(0, 80);
    if (!name) throw bad('Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    if (String(password || '').length < 10) throw bad('Use a password of at least 10 characters.');
    insert('staff', { name, email, role: 'owner', pw_hash: hashPassword(password), must_change: 0 });
    if (business_name) setSetting('business_name', business_name);
    log(req, 'Created owner account', `${name}, ${email}${business_name ? ` for ${business_name}` : ''}`);
    res.json({ ok: true });
  }));

  api.get('/settings', requireStaff(), (req, res) => {
    const out = {};
    for (const k of PUBLIC_SETTINGS) out[k] = setting(k);
    out.waiver_text = setting('waiver_text');
    out.presets = setting('presets');
    out.payments_mode = payments.mode();
    out.email_mode = require('../email').mode();
    out.sms_mode = require('../messaging').mode();
    res.json(out);
  });

  api.put('/settings', requireStaff('owner', 'coach'), h(async (req, res) => {
    const b = req.body || {};
    const ownerOnly = ['late_cancel_hours', 'results_visibility', 'business_address', 'pay_instructions', 'waiver_text', 'business_name'];
    for (const [k, v] of Object.entries(b)) {
      if (![...PUBLIC_SETTINGS, 'waiver_text'].includes(k) || k === 'waiver_version') continue;
      if (ownerOnly.includes(k) && req.staff.role !== 'owner') throw new HttpError(403, 'Only owners can change policies.');
      if (k === 'late_cancel_hours' && !(Number(v) >= 0 && Number(v) <= 72)) throw bad('Late-cancel window must be 0–72 hours.');
      if (k === 'timezone') { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { throw bad("That time zone isn't recognized. Use a name like America/Denver."); } }
      if (k === 'results_visibility' && !['shared', 'immediate'].includes(v)) throw bad('Choose when parents see results.');
      if (k === 'waiver_text' && v !== setting('waiver_text')) {
        setSetting('waiver_version', Number(setting('waiver_version', 1)) + 1); // every family is asked to sign again
        log(req, 'Changed waiver', 'Families will be asked to sign again');
      }
      setSetting(k, k === 'late_cancel_hours' ? Number(v) : v);
    }
    log(req, 'Updated settings', Object.keys(b).join(', '));
    res.json({ ok: true });
  }));

  api.get('/activity', requireStaff(), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 500);
    const owner = req.staff.role === 'owner';
    // Coaches and front desk never see money in the feed.
    const where = owner ? [] : ["action NOT LIKE '%payment%'", "action NOT LIKE '%refund%'", "action NOT LIKE '%invoice%'", "action NOT LIKE 'Ran billing%'", "action NOT LIKE 'Added product%'", "action NOT LIKE 'Voided%'", "action NOT LIKE 'Changed price%'"];
    // kind=change leaves out sign-ins and refusals (the Today feed); kind=signin|refused asks for just those.
    if (['change', 'signin', 'refused'].includes(req.query.kind)) where.push(`kind='${req.query.kind}'`);
    // Newest first by when it happened (seeded and imported rows can arrive out of id order).
    const rows = all(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, limit);
    res.json(owner ? rows : rows.map((r) => ({ ...r, action: scrubMoney(r.action), detail: scrubMoney(r.detail) })));
  });

  api.get('/lookups', requireStaff(), (req, res) => {
    const plans = all('SELECT id,name,price_cents,trial_days,group_per_month,private_per_month FROM plans WHERE active=1 ORDER BY price_cents');
    res.json({
      locations: all('SELECT * FROM locations WHERE archived=0 ORDER BY id'),
      plans: req.staff.role === 'owner' ? plans : plans.map(({ price_cents, ...p }) => p), // coaches never see money
      programs: all('SELECT id,name,weeks,level FROM programs WHERE archived=0 ORDER BY name'),
      teams: all("SELECT t.id, t.team_name, s.name AS school FROM team_contracts t JOIN schools s ON s.id=t.school_id WHERE t.status='active' ORDER BY t.team_name"),
      coaches: all("SELECT id,name,role FROM staff WHERE active=1 AND role IN ('owner','coach') ORDER BY name"),
    });
  });

  // Athlete search used by many screens (name, Athlete ID, email, family).
  api.get('/athletes/search', requireStaff(), (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    res.json(all(`SELECT a.id, a.code, a.first_name, a.last_name, a.sport, a.team_id, f.name AS family
      FROM athletes a LEFT JOIN families f ON f.id=a.family_id LEFT JOIN parents p ON p.family_id=a.family_id
      WHERE a.archived=0 AND (a.first_name || ' ' || a.last_name LIKE ? OR a.code LIKE ? OR a.email LIKE ? OR p.email LIKE ? OR f.name LIKE ?)
      GROUP BY a.id ORDER BY a.last_name, a.first_name LIMIT 20`, q, q, q, q, q));
  });
}

// Remove dollar amounts from a feed line: "Bought pack: Ava (10-pack, $250)" → "Bought pack: Ava (10-pack)".
function scrubMoney(s) {
  if (!s) return s;
  const AMT = '-?\\$\\d+(?:,\\d{3})*(?:\\.\\d+)?';
  return String(s)
    .replace(new RegExp(`\\(${AMT}(?:, )?`, 'g'), '(').replace(/\(\)/g, '')
    .replace(new RegExp(`(?: · |, )${AMT}`, 'g'), '')
    .replace(new RegExp(`${AMT}(?: · |, )?`, 'g'), '')
    .replace(/ {2,}/g, ' ').replace(/ \)/g, ')').trim();
}

module.exports = { routes, scrubMoney };
