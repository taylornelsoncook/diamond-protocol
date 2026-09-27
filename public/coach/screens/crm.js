// CRM: the pipeline (board and list), a lead's page and timeline, tasks, group messages, reports, import and export,
// and settings (the website form, enquiry emails, templates, texting). Owners see everything; the front desk works
// leads and their own tasks; coaches have no CRM (the server refuses them too).
import { html, raw, mount, api, money, fmtDate, fmtDateTime, relTime, toast, toastError, modal, confirmDialog, formData, debounce, options, plural, icon, localISO } from '/js/ui.js';

const STYLE = html`<style>
.crm{display:flex;flex-direction:column;gap:var(--space-4)}
.crm .tabs a{min-height:44px}
.crm-tools{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
.crm-tools .input{flex:1 1 160px;width:auto;min-width:0}
.crm-tools input[type=search]{flex:2 1 240px}
.crm-tools .seg button{min-height:44px}
.crm-tools .field{flex:0 1 180px}.crm-tools .field .input{width:100%;flex:none}
#rp-f{align-items:flex-end}
.crm-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(236px,1fr);gap:var(--space-3);overflow-x:auto;padding-bottom:var(--space-2);scroll-snap-type:x proximity}
.crm-col{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);display:flex;flex-direction:column;min-width:0;scroll-snap-align:start}
.crm-col-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
.crm-col-h h2{font:600 15px/20px var(--font-sans);margin:0}
.crm-col-h .n{font:600 20px/1 var(--font-display);color:var(--steel-muted)}
.crm-col-b{display:flex;flex-direction:column;gap:8px;padding:10px;min-height:80px}
.crm-col-b .empty{padding:14px;font-size:13px}
.crm-card{background:var(--surface-raised);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.crm-card.stale{border-left:3px solid var(--amber)}
.crm-card a.nm{font-weight:600;color:var(--steel);text-decoration:none}.crm-card a.nm:hover{text-decoration:underline}
.crm-card .sub{font-size:13px;line-height:18px;color:var(--steel-muted)}
.crm-card .ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}
.crm-card .when{font-size:12px;color:var(--steel-muted)}
.crm-warn{color:var(--amber)}
.crm-older{font-size:13px;color:var(--steel-muted);padding:0 4px}
.crm-list td{padding:10px 14px}.crm-list .nm{font-weight:600;color:var(--steel);text-decoration:none}
.crm-list .sub{font-size:13px;color:var(--steel-muted);overflow-wrap:anywhere}
@media (max-width:760px){.crm-list .c-src,.crm-list .c-own,.crm-list .c-act{display:none}.crm-list td,.crm-list th{padding:10px 10px}}
@media (max-width:480px){.crm-list .c-age{display:none}}
.crm-tasks .list-row{align-items:flex-start}
.crm-tasks .t-title{font-weight:500}
.crm-tasks .done .t-title{text-decoration:line-through;color:var(--steel-muted)}
.crm-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:var(--space-4);align-items:start}
@media (max-width:1000px){.crm-grid{grid-template-columns:1fr}}
.crm-col2{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.crm-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 16px;margin:0;font-size:14px}
.crm-kv dt{color:var(--steel-muted)}.crm-kv dd{margin:0;overflow-wrap:anywhere}
.crm-kv a{color:var(--steel)}
.crm-acts{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.crm-stagepick{display:flex;flex-direction:column;gap:6px}
.crm-stagepick label{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer}
.crm-stagepick label:has(input:checked){border-color:var(--green-mid);background:var(--green-deep)}
.crm-stagepick input{width:18px;height:18px;accent-color:var(--green-mid)}
.crm-slots{display:flex;flex-direction:column;gap:12px;max-height:340px;overflow-y:auto}
.crm-slots .day{font-size:13px;color:var(--steel-muted);margin-bottom:6px}
.crm-slots .times{display:flex;flex-wrap:wrap;gap:6px}
.crm-slots label{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border:1px solid var(--control-border);border-radius:var(--radius-sm);cursor:pointer}
.crm-slots label:has(input:checked){border-color:var(--green-mid);background:var(--green-deep)}
.crm-ath{display:grid;grid-template-columns:minmax(0,2fr) 90px 110px 44px;gap:8px;align-items:end}
@media (max-width:520px){.crm-ath{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 44px}.crm-ath>.field:first-child{grid-column:1/-1}}
.crm-dup a{color:var(--amber);font-weight:600}
.crm-count{font-size:12px;color:var(--steel-muted);text-align:right}
.crm-count.warn{color:var(--amber)}
.crm-bars{display:flex;flex-direction:column;gap:10px}
.crm-bar{display:grid;grid-template-columns:minmax(110px,160px) minmax(0,1fr) auto;gap:12px;align-items:center;font-size:14px}
.crm-bar .bar{height:10px}
.crm-bar .v{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--steel-muted)}
@media (max-width:520px){.crm-bar{grid-template-columns:minmax(0,1fr) auto;row-gap:4px}.crm-bar .bar{grid-column:1/-1;order:3}}
.crm-snip{margin:0;background:var(--black);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;font:400 13px/20px var(--font-mono);color:var(--steel);white-space:pre-wrap;overflow-wrap:anywhere}
.crm-prev{max-height:320px;overflow-y:auto}
.crm details>summary{list-style:none;gap:8px}.crm details>summary::-webkit-details-marker{display:none}
.crm details>summary::before{content:'';flex:0 0 auto;width:0;height:0;border:5px solid transparent;border-left:7px solid currentColor;border-right:0;transition:transform .15s}.crm details[open]>summary::before{transform:rotate(90deg)}
.crm-status-new{color:var(--green-bright)}
@media (pointer:coarse){.crm .btn-sm,.modal .btn-sm{min-height:44px}}
</style>`;

const TL_STYLE = html`<style>
.crm-tl{display:flex;flex-direction:column}
.crm-tl-i{display:grid;grid-template-columns:10px minmax(0,1fr);gap:12px;padding:10px 0;border-top:1px solid var(--line-subtle)}
.crm-tl-i:first-child{border-top:0}
.crm-tl-i .dot{width:10px;height:10px;margin-top:6px;transform:rotate(45deg);background:var(--line);border:1px solid var(--control-border)}
.crm-tl-i.k-stage .dot,.crm-tl-i.k-converted .dot{background:var(--green-mid);border-color:var(--green-mid)}
.crm-tl-i.k-consent .dot{background:var(--amber-deep);border-color:var(--amber)}
.crm-tl-i .t{font-weight:600;font-size:14px}
.crm-tl-i .b{white-space:pre-line;overflow-wrap:anywhere;font-size:14px;color:var(--silver)}
.crm-tl-i .m{font-size:12px;color:var(--steel-muted)}
</style>`;

// ---------------------------------------------------------------- shared bits
let META = null;
async function meta(force = false) { if (!META || force) META = await api.get('/crm/meta'); return META; }
const L = (list, k) => (list.find((x) => x[0] === k) || [])[1] || '';
const TONE = { new: 'neutral', contacted: 'neutral', evaluation: 'neutral', trial: 'neutral', member: 'good', lost: 'muted' };
const stageBadge = (s, label) => html`<span class="badge badge-${TONE[s] || 'muted'}">${label || L(META?.stages || [], s)}</span>`;
const isOwner = (ctx) => ctx.me.role === 'owner';
const days = (n) => (n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
const fmtPhone = (e) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ''); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e || ''; };
const telHref = (p) => `tel:${String(p || '').replace(/[^\d+]/g, '')}`;
const athletesLine = (l) => l.athletes.map((a) => `${a.name}${a.age ? ` (${a.age})` : a.grad_year ? ` (${a.grad_year})` : ''}`).join(', ');
async function copy(text, what = 'Copied.') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { modal({ title: 'Copy', body: html`<textarea class="input mono" rows="4" readonly onfocus="this.select()">${text}</textarea>` }); }
}
function download(name, text, type = 'text/csv') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Same placeholders the server fills for group messages.
function fillTemplate(text, { name, athletes }, me, business) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const kids = (athletes || []).map((a) => String(a).trim().split(/\s+/)[0]).filter(Boolean);
  const athlete = kids.length ? (kids.length === 1 ? kids[0] : `${kids.slice(0, -1).join(', ')} and ${kids[kids.length - 1]}`) : 'your athlete';
  const vars = { first_name: first, athlete, business, staff: me?.name ? me.name.split(' ')[0] : business };
  return String(text || '').replace(/\{(first_name|athlete|business|staff)\}/g, (_, k) => vars[k]);
}
// Text length the way phones count it: 160 characters per text (153 when split), 70 (67) with emoji or curly quotes.
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
function segments(s) {
  let gsm = true, units = 0;
  for (const ch of String(s)) { if (GSM.includes(ch)) units++; else if ('^{}\\[~]|€'.includes(ch)) units += 2; else { gsm = false; break; } }
  if (!gsm) { const n = [...String(s)].length; return { chars: n, parts: n ? (n <= 70 ? 1 : Math.ceil(n / 67)) : 0, per: n <= 70 ? 70 : 67, unicode: true }; }
  return { chars: units, parts: units ? (units <= 160 ? 1 : Math.ceil(units / 153)) : 0, per: units <= 160 ? 160 : 153, unicode: false };
}
function bindCounter(root, ta, out, max = 6) {
  const upd = () => {
    const s = segments(ta.value);
    out.textContent = `${s.chars} characters · ${plural(s.parts, 'text')}${s.unicode ? ' (emoji or special characters make texts shorter)' : ''}`;
    out.classList.toggle('warn', s.parts > max);
  };
  ta.addEventListener('input', upd); upd();
}
const TEXT_TEST = 'Test mode: texts are saved to the outbox until a texting service is connected.';
const EMAIL_TEST = 'Test mode: emails are saved to the outbox and not sent.';

// Email a lead or a family (used here and on the client profile).
export async function emailDialog({ to, name, athletes, post, me, business, emailMode, onSent }) {
  const m = await meta();
  const tpls = m.templates;
  return modal({
    title: `Email ${name}`, wide: true,
    body: html`<p class="muted" style="margin:0">To ${to}. An unsubscribe link is added at the end.${emailMode === 'test' ? ` ${EMAIL_TEST}` : ''}</p>
      <div class="field"><label class="label" for="em-t">Start from a template</label><select class="input" id="em-t"><option value="">Blank email</option>${tpls.map((t) => html`<option value="${t.key}">${t.name}</option>`)}</select></div>
      <div class="field"><label class="label" for="em-s">Subject</label><input class="input" id="em-s" maxlength="150"></div>
      <div class="field"><label class="label" for="em-b">Message</label><textarea class="input" id="em-b" rows="9" maxlength="10000"></textarea></div>`,
    onMount: (body) => {
      body.querySelector('#em-t').addEventListener('change', (e) => {
        const t = tpls.find((x) => x.key === e.target.value);
        if (!t) return;
        body.querySelector('#em-s').value = fillTemplate(t.subject, { name, athletes }, me, business);
        body.querySelector('#em-b').value = fillTemplate(t.body, { name, athletes }, me, business);
      });
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Send email', kind: 'primary', onClick: async (body) => {
      const r = await api.post(post, { subject: body.querySelector('#em-s').value, body: body.querySelector('#em-b').value });
      toast(r.message || 'Email sent.'); onSent?.(); return true;
    } }],
  });
}
// Text a lead or a family.
export async function textDialog({ to, name, athletes, post, me, business, smsMode, onSent }) {
  const m = await meta();
  return modal({
    title: `Text ${name}`,
    body: html`<p class="muted" style="margin:0">To ${to}. They can reply STOP at any time.</p>
      ${smsMode === 'test' ? html`<div class="banner" role="note">${TEXT_TEST}</div>` : ''}
      <div class="field"><label class="label" for="tx-t">Start from a template</label><select class="input" id="tx-t"><option value="">Blank text</option>${m.templates.map((t) => html`<option value="${t.key}">${t.name}</option>`)}</select></div>
      <div class="field"><label class="label" for="tx-b">Message</label><textarea class="input" id="tx-b" rows="5"></textarea><div class="crm-count" id="tx-c" aria-live="polite"></div></div>`,
    onMount: (body) => {
      const ta = body.querySelector('#tx-b');
      bindCounter(body, ta, body.querySelector('#tx-c'), m.sms_max_segments);
      body.querySelector('#tx-t').addEventListener('change', (e) => {
        const t = m.templates.find((x) => x.key === e.target.value);
        if (t) { ta.value = fillTemplate(t.body, { name, athletes }, me, business); ta.dispatchEvent(new Event('input')); }
      });
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Send text', kind: 'primary', onClick: async (body) => {
      const r = await api.post(post, { body: body.querySelector('#tx-b').value });
      toast(r.message || 'Text sent.'); onSent?.(); return true;
    } }],
  });
}

function header(ctx, active, sub, primary = true) {
  const tabs = [['pipeline', 'Pipeline', '/app/crm'], ['tasks', 'Tasks', '/app/crm/tasks']];
  if (isOwner(ctx)) tabs.push(['messages', 'Group messages', '/app/crm/messages'], ['reports', 'Reports', '/app/crm/reports'], ['import', 'Import & export', '/app/crm/import'], ['settings', 'Settings', '/app/crm/settings']);
  return html`<div class="page-header"><div><h1 class="page-title">CRM</h1><p class="page-sub">${sub}</p></div>
      ${primary ? html`<button class="btn btn-primary" type="button" data-act="add-lead">${icon('plus', 18)} Add lead</button>` : ''}</div>
    <nav class="tabs" aria-label="CRM">${tabs.map(([k, label, href]) => html`<a href="${href}" ${k === active ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>`;
}

// ---------------------------------------------------------------- add / edit lead
function athleteRow(a = {}, i = 0) {
  return html`<div class="crm-ath" data-ath>
    <div class="field"><label class="label small" for="la-n${i}">Athlete</label><input class="input" id="la-n${i}" data-f="name" value="${a.name || ''}" maxlength="80" placeholder="First name is fine"></div>
    <div class="field"><label class="label small" for="la-a${i}">Age</label><input class="input" id="la-a${i}" data-f="age" type="number" inputmode="numeric" min="4" max="70" value="${a.age ?? ''}"></div>
    <div class="field"><label class="label small" for="la-g${i}">Grad year</label><input class="input" id="la-g${i}" data-f="grad_year" type="number" inputmode="numeric" value="${a.grad_year ?? ''}" placeholder="${new Date().getFullYear() + 4}"></div>
    <button class="btn btn-ghost" type="button" data-rm-ath aria-label="Remove this athlete">${icon('close', 18)}</button></div>`;
}
function leadForm(m, l = {}, me) {
  const src = l.source || 'phone';
  return html`<form class="stack" id="lf" novalidate>
    <div class="form-grid">
      <div class="field"><label class="label" for="lf-n">Parent name</label><input class="input" id="lf-n" name="parent_name" value="${l.parent_name || ''}" maxlength="120" autocomplete="off"><span class="hint">Or the athlete’s own name, for an adult.</span></div>
      <div class="field"><label class="label" for="lf-e">Email</label><input class="input" id="lf-e" name="email" type="email" inputmode="email" value="${l.email || ''}" autocomplete="off"></div>
      <div class="field"><label class="label" for="lf-p">Phone</label><input class="input" id="lf-p" name="phone" type="tel" value="${l.phone_display || ''}" autocomplete="off"></div>
    </div>
    <div class="stack-sm" id="lf-aths">${(l.athletes?.length ? l.athletes : [{}]).map((a, i) => athleteRow(a, i))}</div>
    <div><button class="btn btn-sm btn-ghost" type="button" data-add-ath>${icon('plus', 16)} Add another athlete</button></div>
    <div class="form-grid">
      <div class="field"><label class="label" for="lf-sp">Sport</label><input class="input" id="lf-sp" name="sport" value="${l.sport || ''}" list="lf-sports" maxlength="60"></div>
      <div class="field"><label class="label" for="lf-po">Position</label><input class="input" id="lf-po" name="position" value="${l.position || ''}" maxlength="60"></div>
      <div class="field"><label class="label" for="lf-i">Interested in</label><select class="input" id="lf-i" name="interest">${options(m.interests.map(([id, name]) => ({ id, name })), l.interest, { blank: 'Not sure yet' })}</select></div>
    </div>
    <datalist id="lf-sports">${['Baseball', 'Softball', 'Football', 'Soccer', 'Basketball', 'Volleyball', 'General fitness'].map((x) => html`<option value="${x}">`)}</datalist>
    <div class="form-grid">
      <div class="field"><label class="label" for="lf-s">Where they came from</label><select class="input" id="lf-s" name="source">${options(m.sources.map(([id, name]) => ({ id, name })), src)}</select></div>
      <div class="field" id="lf-sd-f"><label class="label" for="lf-sd" id="lf-sd-l">${src === 'referral' ? 'Referred by' : 'Details'}</label><input class="input" id="lf-sd" name="source_detail" value="${l.source_detail || ''}" maxlength="120"></div>
      <div class="field"><label class="label" for="lf-o">Owner</label><select class="input" id="lf-o" name="owner_id">${options(m.staff, l.id ? l.owner_id : me.id, { blank: 'Nobody yet' })}</select></div>
      <div class="field"><label class="label" for="lf-d">First got in touch</label><input class="input" id="lf-d" name="first_contact" type="date" max="${localISO()}" value="${l.first_contact || localISO()}"></div>
    </div>
    <div class="field"><label class="label" for="lf-no">Notes</label><textarea class="input" id="lf-no" name="notes" rows="3" maxlength="2000" placeholder="Goals, injuries, days that work">${l.notes || ''}</textarea></div>
    ${l.id ? '' : html`<label class="check small"><input type="checkbox" name="sms_opt_in" id="lf-sms"> <span>They said it’s OK to text them</span></label>
      <div class="field" id="lf-smsh-f" hidden><label class="label small" for="lf-smsh">How they agreed</label><input class="input" id="lf-smsh" name="sms_opt_in_source" maxlength="120" placeholder="Asked on the phone"></div>`}
    <div id="lf-dup"></div>
  </form>`;
}
function bindLeadForm(body) {
  const aths = body.querySelector('#lf-aths');
  let n = aths.children.length;
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-ath]')) { aths.insertAdjacentHTML('beforeend', String(athleteRow({}, n++))); aths.lastElementChild.querySelector('input').focus(); }
    const rm = e.target.closest('[data-rm-ath]');
    if (rm) { if (aths.children.length > 1) rm.closest('[data-ath]').remove(); else rm.closest('[data-ath]').querySelectorAll('input').forEach((i) => { i.value = ''; }); }
  });
  const src = body.querySelector('#lf-s');
  const syncSrc = () => { body.querySelector('#lf-sd-l').textContent = src.value === 'referral' ? 'Referred by' : src.value === 'team' ? 'Team or school' : src.value === 'camp' ? 'Which camp' : 'Details'; };
  src.addEventListener('change', syncSrc); syncSrc();
  const sms = body.querySelector('#lf-sms');
  sms?.addEventListener('change', () => { body.querySelector('#lf-smsh-f').hidden = !sms.checked; });
}
function readLeadForm(body) {
  const d = formData(body.querySelector('#lf'));
  d.athletes = [...body.querySelectorAll('[data-ath]')].map((r) => ({ name: r.querySelector('[data-f=name]').value.trim(), age: r.querySelector('[data-f=age]').value, grad_year: r.querySelector('[data-f=grad_year]').value }))
    .filter((a) => a.name || a.age || a.grad_year);
  if (!d.owner_id) d.owner_id = null;
  return d;
}
// Ask first (a 200 answer), so a likely duplicate is shown before anything is saved; the server checks again on save.
async function precheck(body, d, exceptId = 0) {
  if (!d.email && !d.phone) return false;
  const q = new URLSearchParams({ email: d.email || '', phone: d.phone || '', ...(exceptId ? { except: exceptId } : {}) });
  const r = await api.get(`/crm/duplicates?${q}`).catch(() => ({ duplicates: [] }));
  if (!r.duplicates.length) return false;
  mount(body.querySelector('#lf-dup'), dupBox(r.duplicates));
  body.querySelector('#lf-dup').scrollIntoView({ block: 'nearest' });
  return true;
}
function dupBox(dups) {
  return html`<div class="banner crm-dup" role="alert"><div class="stack-sm" style="flex:1 1 260px"><span>${dups.length === 1 ? 'This may already be on file:' : 'These may already be on file:'}</span>
    ${dups.map((d) => html`<a href="${d.href}" data-close>${d.name} · ${d.detail} (same ${d.match})</a>`)}</div></div>`;
}
export async function addLeadDialog(ctx, { onDone } = {}) {
  const m = await meta();
  let allowDup = false;
  const r = await modal({
    title: 'Add lead', wide: true, body: leadForm(m, {}, ctx.me), onMount: bindLeadForm,
    actions: [{ label: 'Cancel', value: null }, { label: 'Add lead', kind: 'primary', onClick: async (body) => {
      const d = readLeadForm(body);
      if (!allowDup && await precheck(body, d)) {
        allowDup = true;
        body.closest('.modal').querySelector('.modal-actions .btn-primary').textContent = 'Add lead anyway';
        return false;
      }
      try { return await api.post('/crm/leads', { ...d, allow_duplicate: allowDup }); }
      catch (e) {
        if (e.data?.duplicates) {
          mount(body.querySelector('#lf-dup'), dupBox(e.data.duplicates));
          allowDup = true;
          body.closest('.modal').querySelector('.modal-actions .btn-primary').textContent = 'Add lead anyway';
          body.querySelector('#lf-dup').scrollIntoView({ block: 'nearest' });
          return false;
        }
        throw e;
      }
    } }],
  });
  if (r?.lead) { toast(`Added ${r.lead.parent_name}.`); META = null; if (onDone) onDone(r.lead); else ctx.go(`/app/crm/leads/${r.lead.id}`); }
}

// ---------------------------------------------------------------- move stage (a menu that works by keyboard and on a phone)
export async function moveDialog(lead, onDone) {
  const m = await meta();
  const r = await modal({
    title: `Move ${lead.parent_name}`,
    body: html`<fieldset style="border:0;margin:0;padding:0"><legend class="sr-only">Stage</legend><div class="crm-stagepick">
      ${m.stages.map(([k, name]) => html`<label><input type="radio" name="stage" value="${k}" ${k === lead.stage ? raw('checked') : ''}> <span>${name}${k === lead.stage ? ' (now)' : ''}</span></label>`)}</div></fieldset>
      <div class="stack-sm" id="mv-lost" hidden>
        <div class="field"><label class="label" for="mv-r">Why was it lost?</label><select class="input" id="mv-r">${options(m.lost_reasons.map(([id, name]) => ({ id, name })), lead.lost_reason, { blank: 'Choose a reason' })}</select></div>
        <div class="field"><label class="label" for="mv-n">Note <span class="muted">(needed for Other)</span></label><input class="input" id="mv-n" maxlength="300" value="${lead.lost_note || ''}"></div></div>`,
    onMount: (body) => {
      const sync = () => { body.querySelector('#mv-lost').hidden = body.querySelector('input[name=stage]:checked')?.value !== 'lost'; };
      body.addEventListener('change', sync); sync();
      body.querySelector('input[name=stage]:checked')?.focus();
    },
    actions: [{ label: 'Cancel', value: null }, { label: 'Move lead', kind: 'primary', onClick: async (body) => {
      const stage = body.querySelector('input[name=stage]:checked')?.value;
      if (!stage) { toast('Choose a stage.', 'warn'); return false; }
      if (stage === lead.stage && stage !== 'lost') return null;
      return api.post(`/crm/leads/${lead.id}/stage`, { stage, lost_reason: body.querySelector('#mv-r').value || null, lost_note: body.querySelector('#mv-n').value });
    } }],
  });
  if (r?.lead) { toast(`${r.lead.parent_name} moved to ${r.lead.stage_label}.`); META = null; onDone?.(r.lead); }
}

// ---------------------------------------------------------------- tasks
function taskRow(t, { showLead = true } = {}) {
  return html`<div class="list-row ${t.done ? 'done' : ''}">
    <button class="btn btn-sm ${t.done ? 'btn-ghost' : 'btn-outline'}" type="button" data-task="${t.done ? 'undo' : 'done'}" data-id="${t.id}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${t.title}">${t.done ? 'Undo' : icon('check', 18)}</button>
    <div class="grow"><div class="t-title">${t.title}</div>
      <div class="small ${t.overdue ? 'crm-warn' : 'muted'}">${t.done ? `Done ${relTime(t.done_at)}${t.done_by ? ` by ${t.done_by}` : ''}` : t.overdue ? `Overdue: due ${fmtDate(t.due_date, { year: false, weekday: true })}` : t.due_today ? 'Due today' : `Due ${fmtDate(t.due_date, { year: false, weekday: true })}`}
      ${showLead && (t.lead || t.family) ? html` · <a href="${t.href}">${t.lead ? t.lead.name : t.family.name}</a>` : ''}${t.assignee_name ? ` · ${t.assignee_name}` : ''}</div></div></div>`;
}
async function taskAction(btn, after) {
  btn.disabled = true;
  try { const r = await api.post(`/crm/tasks/${btn.dataset.id}/${btn.dataset.task}`); toast(r.message || 'Task reopened.'); await after(); }
  catch (e) { toastError(e); btn.disabled = false; }
}
export async function taskDialog(ctx, { leadId = null, familyId = null, about = '', onDone } = {}) {
  const m = await meta();
  const tomorrow = new Date(Date.now() + 864e5);
  const r = await modal({
    title: about ? `Add a task: ${about}` : 'Add a task',
    body: html`<form class="stack" id="tf" novalidate>
      <div class="field"><label class="label" for="tf-t">What needs doing</label><input class="input" id="tf-t" name="title" maxlength="160" placeholder="Call back about evaluation times"></div>
      <div class="form-grid"><div class="field"><label class="label" for="tf-d">Due</label><input class="input" id="tf-d" name="due_date" type="date" value="${localISO(tomorrow)}"></div>
      <div class="field"><label class="label" for="tf-a">For</label><select class="input" id="tf-a" name="assignee_id">${options(m.staff, ctx.me.id)}</select></div></div></form>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Add task', kind: 'primary', onClick: (body) => api.post('/crm/tasks', { ...formData(body.querySelector('#tf')), lead_id: leadId, family_id: familyId }) }],
  });
  if (r?.task) { toast('Task added.'); onDone?.(r.task); }
}

// ---------------------------------------------------------------- pipeline
async function renderPipeline(ctx) {
  const m = await meta(true);
  if (!ctx.isCurrent()) return;
  const q = ctx.query;
  let view = q.view === 'list' ? 'list' : 'board';
  const f = { q: q.q || '', stage: q.stage || '', source: q.source || '', owner: q.owner || '', interest: q.interest || '', sort: q.sort || 'newest', stale: q.stale === '1' };
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  const open = ['new', 'contacted', 'evaluation', 'trial'].reduce((n, k) => n + m.counts[k], 0);
  mount(ctx.el, html`${STYLE}<div class="crm" id="crm">
    ${header(ctx, 'pipeline', `${plural(open, 'open lead')} of ${total}. Move each one toward membership.`)}
    <div id="crm-mytasks"></div>
    <div class="panel">
      <div class="crm-tools">
        <label class="sr-only" for="f-q">Search leads</label><input class="input" type="search" id="f-q" placeholder="Name, email, phone or athlete" value="${f.q}" autocomplete="off">
        <div class="seg" role="group" aria-label="View"><button type="button" data-view="board" aria-pressed="${view === 'board'}">Board</button><button type="button" data-view="list" aria-pressed="${view === 'list'}">List</button></div>
      </div>
      <div class="crm-tools">
        <label class="sr-only" for="f-stage">Stage</label><select class="input" id="f-stage" ${view === 'board' ? raw('hidden') : ''}>${options([{ id: 'open', name: 'Open leads' }, ...m.stages.map(([id, name]) => ({ id, name }))], f.stage, { blank: 'Every stage' })}</select>
        <label class="sr-only" for="f-source">Source</label><select class="input" id="f-source">${options(m.sources.map(([id, name]) => ({ id, name })), f.source, { blank: 'Every source' })}</select>
        <label class="sr-only" for="f-owner">Owner</label><select class="input" id="f-owner">${options([{ id: 'me', name: 'My leads' }, { id: 'none', name: 'No owner' }, ...m.staff], f.owner, { blank: 'Every owner' })}</select>
        <label class="sr-only" for="f-interest">Interest</label><select class="input" id="f-interest">${options(m.interests.map(([id, name]) => ({ id, name })), f.interest, { blank: 'Every interest' })}</select>
        <label class="sr-only" for="f-sort">Sort</label><select class="input" id="f-sort" ${view === 'board' ? raw('hidden') : ''}>${options([{ id: 'newest', name: 'Newest first' }, { id: 'oldest', name: 'Oldest first' }, { id: 'stale', name: 'Longest without contact' }, { id: 'stage_age', name: 'Longest in stage' }, { id: 'next_task', name: 'Next task due' }, { id: 'name', name: 'Name, A to Z' }], f.sort)}</select>
        <label class="check small" style="align-items:center;min-height:44px"><input type="checkbox" id="f-stale" ${f.stale ? raw('checked') : ''}> No contact in ${m.stale_days}+ days</label>
      </div>
    </div>
    <div id="crm-view" aria-live="polite"><p class="muted">Loading leads…</p></div>
    <details class="panel" id="crm-re"><summary class="panel-title" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Trials that ended without joining</summary><div id="crm-re-b"><p class="muted">Loading…</p></div></details>
  </div>`);
  const root = ctx.el.querySelector('#crm');
  let seq = 0, data = null;

  async function loadTasks() {
    const t = await api.get('/crm/tasks').catch(() => ({ tasks: [] }));
    if (!ctx.isCurrent()) return;
    const due = t.tasks.filter((x) => x.overdue || x.due_today), later = t.tasks.filter((x) => !x.overdue && !x.due_today);
    mount(root.querySelector('#crm-mytasks'), html`<section class="panel crm-tasks" aria-labelledby="mt-h">
      <div class="panel-head"><h2 class="panel-title" id="mt-h">My tasks</h2><div class="btn-row"><button class="btn btn-sm" type="button" data-act="add-task">Add task</button><a class="btn btn-sm btn-ghost" href="/app/crm/tasks">All tasks</a></div></div>
      ${t.tasks.length ? html`<div class="list">${[...due, ...later].slice(0, 6).map((x) => taskRow(x))}</div>
        ${t.tasks.length > 6 ? html`<p class="hint" style="margin:0">${t.tasks.length - 6} more in <a href="/app/crm/tasks">Tasks</a>.</p>` : ''}`
        : html`<p class="panel-sub">Nothing on your list. Add a task from a lead to be reminded here and on Today.</p>`}</section>`);
  }
  async function loadReengage() {
    const list = await api.get('/crm/reengage').catch(() => []);
    if (!ctx.isCurrent()) return;
    root.querySelector('#crm-re summary').textContent = `Trials that ended without joining (${list.length})`;
    mount(root.querySelector('#crm-re-b'), list.length ? html`<p class="panel-sub">Families whose free trial ended and who have no membership now. Put one back in the pipeline to follow up.</p>
      <div class="list">${list.map((r) => html`<div class="list-row"><div class="grow"><div class="strong">${r.athlete_id ? html`<a href="/app/clients/${r.athlete_id}">${r.family}</a>` : r.family}</div><div class="small muted">${r.kids}${r.ended ? ` · trial ended ${fmtDate(r.ended)}` : ''}</div></div>
        ${r.open_lead ? html`<a class="btn btn-sm btn-ghost" href="/app/crm/leads/${r.open_lead}">Open lead</a>` : html`<button class="btn btn-sm" type="button" data-reengage="${r.family_id}">Put back in pipeline</button>`}</div>`)}</div>`
      : html`<p class="panel-sub">None right now.</p>`);
  }
  function card(l) {
    return html`<article class="crm-card ${l.stale ? 'stale' : ''}" aria-label="${l.parent_name}">
      <a class="nm" href="/app/crm/leads/${l.id}">${l.parent_name}</a>
      ${l.athletes.length ? html`<div class="sub">${athletesLine(l)}${l.sport ? ` · ${l.sport}` : ''}</div>` : l.sport ? html`<div class="sub">${l.sport}</div>` : ''}
      <div class="sub">${l.source_label}${l.interest_label ? ` · ${l.interest_label}` : ''}${l.stage === 'lost' && l.lost_reason_label ? ` · ${l.lost_reason_label}` : ''}</div>
      ${l.stale ? html`<div class="sub crm-warn">${icon('warn', 14)} No contact in ${days(l.days_since_activity)}</div>` : ''}
      ${l.open_tasks ? html`<div class="sub ${l.overdue_task ? 'crm-warn' : ''}">${l.overdue_task ? 'Task overdue' : `Task due ${fmtDate(l.next_task_due, { year: false })}`}</div>` : ''}
      <div class="ft"><span class="when">In stage ${days(l.days_in_stage)}${l.owner_name ? ` · ${l.owner_name.split(' ')[0]}` : ''}</span>
        <button class="btn btn-sm btn-ghost" type="button" data-move="${l.id}" aria-label="Move ${l.parent_name} to another stage">Move</button></div>
    </article>`;
  }
  function draw() {
    const box = root.querySelector('#crm-view');
    if (view === 'board') {
      const cols = data.columns;
      mount(box, html`<div class="crm-board" role="list" aria-label="Pipeline">${cols.map((c) => html`<section class="crm-col" role="listitem" aria-labelledby="col-${c.stage}">
        <div class="crm-col-h"><h2 id="col-${c.stage}">${c.label}</h2><span class="n" aria-label="${plural(c.total, 'lead')}">${c.total}</span></div>
        <div class="crm-col-b">${c.leads.length ? c.leads.map(card) : html`<div class="empty">${c.older ? '' : 'No leads here'}</div>`}
          ${c.older ? html`<div class="crm-older">${c.older} older than 30 days. <a href="/app/crm?view=list&stage=${c.stage}">See all</a></div>` : ''}</div></section>`)}</div>`);
      return;
    }
    const rows = data.leads;
    mount(box, rows.length ? html`<div class="table-wrap"><table class="table crm-list"><thead><tr><th>Lead</th><th>Stage</th><th class="c-src">Source</th><th class="c-own">Owner</th><th class="c-age">In stage</th><th class="c-act">Last contact</th><th><span class="sr-only">Move</span></th></tr></thead>
      <tbody>${rows.map((l) => html`<tr><td><a class="nm" href="/app/crm/leads/${l.id}">${l.parent_name}</a><div class="sub">${[athletesLine(l), l.email || l.phone_display].filter(Boolean).join(' · ')}</div></td>
        <td>${stageBadge(l.stage, l.stage_label)}${l.stage === 'lost' && l.lost_reason_label ? html`<div class="sub">${l.lost_reason_label}</div>` : ''}</td>
        <td class="c-src">${l.source_label}${l.source_detail ? html`<div class="sub">${l.source_detail}</div>` : ''}</td><td class="c-own">${l.owner_name || html`<span class="muted">Nobody</span>`}</td>
        <td class="c-age">${days(l.days_in_stage)}</td><td class="c-act ${l.stale ? 'crm-warn' : ''}">${l.stale ? html`${icon('warn', 14)} ` : ''}${relTime(l.last_activity_at)}</td>
        <td><button class="btn btn-sm btn-ghost" type="button" data-move="${l.id}" aria-label="Move ${l.parent_name}">Move</button></td></tr>`)}</tbody></table></div>
      <p class="hint">${plural(rows.length, 'lead')}.</p>`
      : html`<div class="empty">No leads match. ${f.q || f.stage || f.source || f.owner || f.interest || f.stale ? 'Clear a filter to see more.' : html`<button class="btn btn-sm" type="button" data-act="add-lead">Add your first lead</button>`}</div>`);
  }
  async function load() {
    const my = ++seq;
    const p = new URLSearchParams();
    if (view === 'list') p.set('view', 'list');
    for (const k of ['q', 'source', 'owner', 'interest']) if (f[k]) p.set(k, f[k]);
    if (view === 'list') { if (f.stage) p.set('stage', f.stage); if (f.sort !== 'newest') p.set('sort', f.sort); }
    if (f.stale) p.set('stale', '1');
    history.replaceState({}, '', '/app/crm' + (p.toString() ? '?' + p : ''));
    try {
      const d = await api.get(view === 'board' ? `/crm/board?${p}` : `/crm/leads?${p}`);
      if (my !== seq || !ctx.isCurrent()) return;
      if (view === 'board' && f.stale) d.columns.forEach((c) => { c.leads = c.leads.filter((l) => l.stale); c.total = c.leads.length; c.older = 0; });
      data = d; draw();
    } catch (e) { if (my === seq) mount(root.querySelector('#crm-view'), html`<div class="empty">Leads didn't load: ${e.message}</div>`); }
  }
  root.querySelector('#f-q').addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); load(); }, 200));
  for (const k of ['stage', 'source', 'owner', 'interest', 'sort']) root.querySelector(`#f-${k}`).addEventListener('change', (e) => { f[k] = e.target.value; load(); });
  root.querySelector('#f-stale').addEventListener('change', (e) => { f.stale = e.target.checked; load(); });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.view) { view = t.dataset.view; root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view))); root.querySelector('#f-stage').hidden = root.querySelector('#f-sort').hidden = view === 'board'; load(); return; }
    if (t.dataset.act === 'add-lead') return addLeadDialog(ctx);
    if (t.dataset.act === 'add-task') return taskDialog(ctx, { onDone: loadTasks });
    if (t.dataset.task) return taskAction(t, loadTasks);
    if (t.dataset.move) {
      const lead = view === 'board' ? data.columns.flatMap((c) => c.leads).find((l) => l.id === +t.dataset.move) : data.leads.find((l) => l.id === +t.dataset.move);
      return moveDialog(lead, () => { load(); t.isConnected && t.focus(); });
    }
    if (t.dataset.reengage) {
      t.disabled = true;
      try { const r = await api.post('/crm/reengage', { family_id: +t.dataset.reengage }); toast(`${r.lead.parent_name} is back in the pipeline, in Contacted.`); ctx.go(`/app/crm/leads/${r.lead.id}`); }
      catch (err) { toastError(err); t.disabled = false; }
    }
  });
  loadTasks(); loadReengage();
  await load();
}

// ---------------------------------------------------------------- lead page
function timelineItem(x) {
  const when = x.when ? x.when : x.day ? fmtDate(x.day) : relTime(x.at);
  return html`<div class="crm-tl-i k-${x.kind}"><span class="dot" aria-hidden="true"></span><div>
    <div class="t">${x.title}</div>${x.body ? html`<div class="b">${['email', 'text'].includes(x.kind) && x.body.length > 280 ? x.body.slice(0, 280).trimEnd() + '…' : x.body}</div>` : ''}
    <div class="m">${[x.by, when, x.status === 'logged' ? 'saved to the outbox (test mode)' : x.status === 'failed' ? 'not delivered' : null].filter(Boolean).join(' · ')}</div></div></div>`;
}
export function timelineList(items, empty = 'Nothing yet.') {
  return items.length ? html`${TL_STYLE}<div class="crm-tl">${items.map(timelineItem)}</div>` : html`<p class="panel-sub">${empty}</p>`;
}

async function renderLead(ctx) {
  const id = ctx.params.id;
  const m = await meta();
  const business = ctx.settings?.business_name || 'Diamond Protocol';
  async function draw() {
    const d = await api.get(`/crm/leads/${id}`);
    if (!ctx.isCurrent()) return;
    const l = d.lead, owner = isOwner(ctx);
    document.title = `${l.parent_name} · Diamond Protocol`;
    const client = d.family?.athletes?.[0];
    const sub = [athletesLine(l), l.sport, `${l.source_label}${l.source_detail ? ` (${l.source_detail})` : ''}`, `first contact ${fmtDate(l.first_contact)}`].filter(Boolean).join(' · ');
    const textWhy = { 'no mobile number': 'No mobile number on file.', 'replied STOP': 'They replied STOP. Only they can turn texts back on, by replying START.', 'no OK to text on file': 'No OK to text on file yet.' }[d.text_block];
    mount(ctx.el, html`${STYLE}<div class="crm" id="crm">
      <div class="page-header"><div>
        <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap"><h1 class="page-title">${l.parent_name}</h1>${stageBadge(l.stage, l.stage_label)}${l.reengaged ? html`<span class="badge badge-neutral">Re-engaged</span>` : ''}</div>
        <p class="page-sub">${sub}</p>
        <p class="page-sub">${l.stage === 'lost' ? `Lost: ${l.lost_reason_label}${l.lost_note ? ` (${l.lost_note})` : ''}. ` : ''}${l.days_in_stage === 0 ? `${l.stage_label} since today` : `In ${l.stage_label} for ${days(l.days_in_stage)}`}. Last contact ${relTime(l.last_activity_at)}.</p></div>
        <div class="btn-row"><a class="btn" href="/app/crm">All leads</a>
          ${l.family_id ? (client ? html`<a class="btn btn-primary" href="/app/clients/${client.id}">Open client</a>` : '') : html`<button class="btn btn-primary" type="button" data-act="convert">Convert to client</button>`}</div></div>
      ${l.stale ? html`<div class="banner" role="note">${icon('warn')}<span>No contact in ${days(l.days_since_activity)}. Log a call, or send an email or text, to keep it moving.</span></div>` : ''}
      <div class="crm-acts" role="group" aria-label="Actions">
        ${l.phone ? html`<a class="btn" href="${telHref(l.phone)}">Call ${l.phone_display}</a>` : ''}
        <button class="btn" type="button" data-act="call">Log call</button>
        <button class="btn" type="button" data-act="note">Add note</button>
        <button class="btn" type="button" data-act="email" ${l.email && !l.email_opt_out ? '' : raw('disabled')} title="${!l.email ? 'No email on file' : l.email_opt_out ? 'Unsubscribed from emails' : ''}">Email</button>
        <button class="btn" type="button" data-act="text" ${d.can_text ? '' : raw('disabled')} title="${textWhy || ''}">Text</button>
        <button class="btn" type="button" data-act="evaluation">Book evaluation</button>
        <button class="btn" type="button" data-act="move">Move stage</button>
        <button class="btn btn-ghost" type="button" data-act="task">Add task</button>
      </div>
      <div class="crm-grid">
        <div class="crm-col2">
          <section class="panel" aria-labelledby="dt-h"><div class="panel-head"><h2 class="panel-title" id="dt-h">Details</h2><button class="btn btn-sm btn-ghost" type="button" data-act="edit">Edit</button></div>
            <dl class="crm-kv">
              <dt>Email</dt><dd>${l.email ? html`<a href="mailto:${l.email}">${l.email}</a>` : html`<span class="muted">None</span>`}</dd>
              <dt>Phone</dt><dd>${l.phone ? html`<a href="${telHref(l.phone)}">${l.phone_display}</a>` : html`<span class="muted">None</span>`}</dd>
              <dt>Athletes</dt><dd>${l.athletes.length ? l.athletes.map((a, i) => html`${i ? html`<br>` : ''}${a.name}${a.age ? `, age ${a.age}` : ''}${a.grad_year ? `, class of ${a.grad_year}` : ''}`) : html`<span class="muted">Not given</span>`}</dd>
              <dt>Sport</dt><dd>${[l.sport, l.position].filter(Boolean).join(', ') || html`<span class="muted">Not given</span>`}</dd>
              <dt>Interested in</dt><dd>${l.interest_label || html`<span class="muted">Not sure yet</span>`}</dd>
              <dt>Source</dt><dd>${l.source_label}${l.source_detail ? ` · ${l.source_detail}` : ''}</dd>
              <dt>Owner</dt><dd>${l.owner_name || html`<span class="muted">Nobody yet</span>`}</dd>
              <dt>Added</dt><dd>${fmtDate(l.created_at)}${l.created_by ? ` by ${l.created_by}` : ''}</dd>
              ${l.family_id && d.family ? html`<dt>Client</dt><dd>${d.family.athletes.map((a, i) => html`${i ? ', ' : ''}<a href="/app/clients/${a.id}">${a.first_name} ${a.last_name}</a>`)}</dd>` : ''}
            </dl>
            ${l.notes ? html`<div><div class="label">Notes</div><p style="margin:4px 0 0;white-space:pre-line">${l.notes}</p></div>` : ''}
          </section>
          <section class="panel" aria-labelledby="cp-h"><h2 class="panel-title" id="cp-h">Contact preferences</h2>
            <dl class="crm-kv">
              <dt>Email</dt><dd>${l.email_opt_out ? html`<span class="crm-warn">Unsubscribed ${fmtDate(l.email_opt_out_at)}</span>` : 'Subscribed'}</dd>
              <dt>Texts</dt><dd>${l.sms_opt_out ? html`<span class="crm-warn">Replied STOP ${fmtDate(l.sms_opt_out_at)}</span>` : l.sms_opt_in ? html`OK to text<div class="small muted">${l.sms_opt_in_source}, ${fmtDate(l.sms_opt_in_at)}</div>` : html`<span class="muted">No OK to text on file</span>`}</dd>
            </dl>
            <div class="btn-row">
              ${!l.sms_opt_in && !l.sms_opt_out && l.phone ? html`<button class="btn btn-sm" type="button" data-act="consent-sms">Record OK to text</button>` : ''}
              ${l.sms_opt_in && !l.sms_opt_out ? html`<button class="btn btn-sm btn-ghost" type="button" data-act="consent-sms-off">No longer OK to text</button>` : ''}
              ${l.email && !l.email_opt_out ? html`<button class="btn btn-sm btn-ghost" type="button" data-act="unsub">Mark unsubscribed</button>` : ''}
              ${l.email_opt_out && owner ? html`<button class="btn btn-sm btn-ghost" type="button" data-act="resub">Subscribe again (they asked)</button>` : ''}
            </div>
            ${d.sms_mode === 'test' ? html`<p class="hint" style="margin:0">${TEXT_TEST}</p>` : ''}
          </section>
          <section class="panel" aria-labelledby="ev-h"><h2 class="panel-title" id="ev-h">Evaluations</h2>
            ${d.evaluations.length ? html`<div class="list">${d.evaluations.map((e) => html`<div class="list-row"><div class="grow"><div>${fmtDateTime(e.starts_at)}</div>
              <div class="small muted">${[e.name, e.coach, e.location, e.booked ? null : 'athlete booked in when they become a client', owner && e.price_cents ? `${money(e.price_cents)}, collected at the session` : null].filter(Boolean).join(' · ')}</div></div>
              <button class="btn btn-sm btn-ghost" type="button" data-cancel-ev="${e.id}" data-when="${fmtDateTime(e.starts_at)}">Cancel</button></div>`)}</div>`
              : html`<p class="panel-sub">None booked. Book one from the evaluation hours in Hours & settings.</p>`}
          </section>
          <section class="panel crm-tasks" aria-labelledby="tk-h"><div class="panel-head"><h2 class="panel-title" id="tk-h">Tasks</h2><button class="btn btn-sm" type="button" data-act="task">Add task</button></div>
            ${d.tasks.length ? html`<div class="list">${d.tasks.map((t) => taskRow(t, { showLead: false }))}</div>` : html`<p class="panel-sub">No tasks${ctx.me.role === 'frontdesk' ? ' for you' : ''}.</p>`}
          </section>
          ${owner ? html`<div class="btn-row"><button class="btn btn-ghost" type="button" data-act="delete">Delete lead</button></div>` : ''}
        </div>
        <section class="panel" aria-labelledby="tl-h"><h2 class="panel-title" id="tl-h">Timeline</h2>
          <p class="panel-sub">Calls, notes, emails, texts, stage changes, bookings${l.family_id ? ', memberships' : ''}${owner && l.family_id ? ' and payments' : ''}, newest first.</p>
          ${timelineList(d.timeline)}</section>
      </div></div>`);
    bind(d);
  }

  function bind(d) {
    const l = d.lead;
    const root = ctx.el.querySelector('#crm');
    const redraw = () => draw().catch(toastError);
    root.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.task) return taskAction(t, redraw);
      if (t.dataset.cancelEv) {
        if (!(await confirmDialog('Cancel this evaluation?', `The ${t.dataset.when} evaluation is cancelled and the time opens up again.`, 'Cancel evaluation', 'warn'))) return;
        try { await api.post(`/crm/evaluations/${t.dataset.cancelEv}/cancel`); toast('Evaluation cancelled.'); redraw(); } catch (err) { toastError(err); }
        return;
      }
      const act = t.dataset.act;
      if (act === 'call') {
        const r = await modal({ title: `Log a call with ${l.parent_name}`,
          body: html`<fieldset style="border:0;margin:0;padding:0"><legend class="label">How did it go?</legend><div class="crm-stagepick">${m.outcomes.map(([k, name], i) => html`<label><input type="radio" name="oc" value="${k}" ${i === 0 ? raw('checked') : ''}> ${name}</label>`)}</div></fieldset>
            <div class="field"><label class="label" for="cl-b">Notes <span class="muted">(optional)</span></label><textarea class="input" id="cl-b" rows="3" maxlength="2000"></textarea></div>`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Log call', kind: 'primary', onClick: (b) => api.post(`/crm/leads/${l.id}/calls`, { outcome: b.querySelector('input[name=oc]:checked').value, body: b.querySelector('#cl-b').value }) }] });
        if (r) { toast(l.stage === 'new' && r.lead.stage === 'contacted' ? 'Call logged. Moved to Contacted.' : 'Call logged.'); redraw(); }
      } else if (act === 'note') {
        const r = await modal({ title: 'Add a note', body: html`<label class="sr-only" for="nt-b">Note</label><textarea class="input" id="nt-b" rows="4" maxlength="2000" placeholder="Anything the next person should know"></textarea>`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Add note', kind: 'primary', onClick: (b) => api.post(`/crm/leads/${l.id}/notes`, { body: b.querySelector('#nt-b').value }) }] });
        if (r) { toast('Note added.'); redraw(); }
      } else if (act === 'email') {
        await emailDialog({ to: l.email, name: l.parent_name, athletes: l.athletes.map((a) => a.name), post: `/crm/leads/${l.id}/email`, me: ctx.me, business, emailMode: d.email_mode, onSent: redraw });
      } else if (act === 'text') {
        await textDialog({ to: l.phone_display, name: l.parent_name, athletes: l.athletes.map((a) => a.name), post: `/crm/leads/${l.id}/text`, me: ctx.me, business, smsMode: d.sms_mode, onSent: redraw });
      } else if (act === 'evaluation') {
        await evaluationDialog(ctx, d, redraw);
      } else if (act === 'move') {
        await moveDialog(l, redraw);
      } else if (act === 'task') {
        await taskDialog(ctx, { leadId: l.id, about: l.parent_name, onDone: redraw });
      } else if (act === 'edit') {
        let allowDup = false;
        const r = await modal({ title: `Edit ${l.parent_name}`, wide: true, body: leadForm(m, l, ctx.me), onMount: bindLeadForm,
          actions: [{ label: 'Cancel', value: null }, { label: 'Save changes', kind: 'primary', onClick: async (body) => {
            const { sms_opt_in, sms_opt_in_source, ...data } = readLeadForm(body);
            const changed = (data.email || '') !== (l.email || '') || (data.phone || '') !== (l.phone_display || '');
            if (!allowDup && changed && await precheck(body, data, l.id)) { allowDup = true; body.closest('.modal').querySelector('.modal-actions .btn-primary').textContent = 'Save anyway'; return false; }
            try { return await api.put(`/crm/leads/${l.id}`, { ...data, allow_duplicate: allowDup }); }
            catch (err) { if (err.data?.duplicates) { mount(body.querySelector('#lf-dup'), dupBox(err.data.duplicates)); allowDup = true; body.closest('.modal').querySelector('.modal-actions .btn-primary').textContent = 'Save anyway'; return false; } throw err; }
          } }] });
        if (r) { toast('Saved.'); redraw(); }
      } else if (act === 'consent-sms') {
        const r = await modal({ title: 'Record OK to text', body: html`<p style="margin:0">Only record this when ${l.parent_name.split(' ')[0]} said it’s OK to text ${l.phone_display}.</p>
            <div class="field"><label class="label" for="cs-h">How they agreed</label><input class="input" id="cs-h" maxlength="120" placeholder="Asked on the phone"></div>`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Record OK to text', kind: 'primary', onClick: (b) => api.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: true, source: b.querySelector('#cs-h').value }) }] });
        if (r) { toast('Recorded.'); redraw(); }
      } else if (act === 'consent-sms-off') {
        try { await api.post(`/crm/leads/${l.id}/consent`, { sms_opt_in: false }); toast('Texts turned off for this lead.'); redraw(); } catch (err) { toastError(err); }
      } else if (act === 'unsub' || act === 'resub') {
        if (act === 'unsub' && !(await confirmDialog('Mark unsubscribed?', `${l.parent_name} won't get CRM emails, one-to-one or group.`, 'Mark unsubscribed'))) return;
        try { await api.post(`/crm/leads/${l.id}/consent`, { email_opt_out: act === 'unsub' }); toast(act === 'unsub' ? 'Unsubscribed from emails.' : 'Subscribed again.'); redraw(); } catch (err) { toastError(err); }
      } else if (act === 'convert') {
        await convertDialog(ctx, d);
      } else if (act === 'delete') {
        if (!(await confirmDialog('Delete this lead?', `${l.parent_name} and their timeline and tasks are deleted. This can't be undone. To keep the history, move them to Lost instead.`, 'Delete lead', 'warn'))) return;
        try { await api.del(`/crm/leads/${l.id}`); toast('Lead deleted.'); META = null; ctx.go('/app/crm'); } catch (err) { toastError(err); }
      }
    });
  }
  await draw();
}

async function evaluationDialog(ctx, d, after) {
  const l = d.lead;
  const slots = await api.get('/crm/eval-slots');
  if (!slots.length) { toast('No evaluation times are open in the next 3 weeks. Add evaluation hours in Hours & settings.', 'warn'); return; }
  const byDay = {};
  for (const s of slots) (byDay[s.starts_at.slice(0, 10)] ||= []).push(s);
  const athletes = d.family?.athletes || [];
  const r = await modal({
    title: `Book an evaluation for ${l.athletes.map((a) => a.name.split(' ')[0]).join(' & ') || l.parent_name}`, wide: true,
    body: html`${athletes.length ? html`<div class="field"><label class="label" for="ev-a">Athlete</label><select class="input" id="ev-a">${athletes.map((a) => html`<option value="${a.id}">${a.first_name} ${a.last_name}</option>`)}</select></div>`
      : html`<p class="muted" style="margin:0">The time is held for this lead. When they become a client, the athlete is booked in.</p>`}
      <fieldset style="border:0;margin:0;padding:0"><legend class="label">Time</legend><div class="crm-slots">${Object.entries(byDay).map(([day, list]) => html`<div><div class="day">${fmtDate(day, { weekday: true })}</div>
        <div class="times">${list.map((s) => html`<label><input type="radio" name="slot" value="${s.starts_at}" data-coach="${s.coach_id ?? ''}"> ${fmtDateTime(s.starts_at).split(', ').pop()}${s.coach ? html` <span class="muted small">${s.coach.split(' ')[0]}</span>` : ''}</label>`)}</div></div>`)}</div></fieldset>
      ${isOwner(ctx) && slots[0].price_cents ? html`<p class="hint" style="margin:0">Evaluations are ${money(slots[0].price_cents)}, collected at the session. Nothing is charged now.</p>` : html`<p class="hint" style="margin:0">Nothing is charged now.</p>`}`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Book evaluation', kind: 'primary', onClick: (b) => {
      const s = b.querySelector('input[name=slot]:checked');
      if (!s) { toast('Choose a time.', 'warn'); return false; }
      return api.post(`/crm/leads/${l.id}/evaluation`, { starts_at: s.value, coach_id: s.dataset.coach || null, athlete_id: b.querySelector('#ev-a')?.value || null });
    } }],
  });
  if (r) { toast(`Evaluation booked for ${fmtDateTime(r.starts_at)}.`); after(); }
}

async function convertDialog(ctx, d) {
  const l = d.lead;
  const lookups = await api.get('/lookups');
  const owner = isOwner(ctx);
  const plans = owner ? lookups.plans : lookups.plans.filter((p) => p.trial_days > 0);
  const last = l.parent_name.trim().split(/\s+/).slice(-1)[0];
  const kids = l.athletes.length ? l.athletes : [{ name: l.parent_name, self: true }];
  let allowDup = false;
  const r = await modal({
    title: `Convert ${l.parent_name} to a client`, wide: true,
    body: html`<p class="muted" style="margin:0">Creates the family, the parent’s portal login and ${kids.length === 1 ? 'the athlete' : `${kids.length} athletes`} from this lead. Notes carry over to the client profile${d.evaluations.length ? ', and the evaluation gets the athlete booked in' : ''}. The parent gets the welcome email.</p>
      <div class="form-grid">
        <div class="field"><label class="label" for="cv-pn">Parent name</label><input class="input" id="cv-pn" value="${l.parent_name}"></div>
        <div class="field"><label class="label" for="cv-pe">Parent email</label><input class="input" id="cv-pe" type="email" value="${l.email || ''}"><span class="hint">They sign in to the parent portal with this.</span></div>
        <div class="field"><label class="label" for="cv-pp">Parent phone</label><input class="input" id="cv-pp" type="tel" value="${l.phone_display || ''}"></div>
      </div>
      <div class="stack-sm">${kids.map((a, i) => html`<div class="form-grid" data-kid>
        <div class="field"><label class="label small" for="cv-n${i}">Athlete ${kids.length > 1 ? i + 1 : ''} full name</label><input class="input" id="cv-n${i}" data-f="name" value="${a.self ? a.name : a.name.split(/\s+/).length > 1 ? a.name : `${a.name} ${last}`}"></div>
        <div class="field"><label class="label small" for="cv-b${i}">Birthday <span class="muted">(optional)</span></label><input class="input" id="cv-b${i}" data-f="birthday" type="date" max="${localISO()}"></div>
        <div class="field"><label class="label small" for="cv-g${i}">Grad year</label><input class="input" id="cv-g${i}" data-f="grad_year" type="number" inputmode="numeric" value="${a.grad_year || ''}"></div></div>`)}</div>
      <div class="form-grid">
        <div class="field"><label class="label" for="cv-plan">Plan</label><select class="input" id="cv-plan">${options(plans, '', { blank: 'No plan yet', label: (p) => [p.name, owner && p.price_cents != null ? `${money(p.price_cents)}/mo` : null, p.trial_days ? `${p.trial_days}-day free trial` : null].filter(Boolean).join(' · ') })}</select>
          <span class="hint">${owner ? 'Without a trial, the card on file is charged when the parent adds one.' : 'The front desk can start a free trial. An owner starts paid plans.'}</span></div>
        ${owner ? html`<div class="field"><label class="label" for="cv-prog">Starting program</label><select class="input" id="cv-prog">${options(lookups.programs, '', { blank: 'Assign later' })}</select></div>` : ''}
      </div>
      <div id="cv-dup"></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Create client account', kind: 'primary', onClick: async (b) => {
      const athletes = [...b.querySelectorAll('[data-kid]')].map((k) => ({ name: k.querySelector('[data-f=name]').value.trim(), birthday: k.querySelector('[data-f=birthday]').value || null, grad_year: k.querySelector('[data-f=grad_year]').value || null }));
      const self = kids.length === 1 && kids[0].self;
      try {
        return await api.post(`/crm/leads/${l.id}/convert`, { parent_name: b.querySelector('#cv-pn').value, parent_email: b.querySelector('#cv-pe').value, parent_phone: b.querySelector('#cv-pp').value,
          athletes, with_parent: !self, plan_id: b.querySelector('#cv-plan').value || null, program_id: b.querySelector('#cv-prog')?.value || null, allow_duplicate: allowDup });
      } catch (e) {
        const box = b.querySelector('#cv-dup');
        if (e.data?.duplicates) { mount(box, html`<div class="banner crm-dup" role="alert"><div class="stack-sm" style="flex:1 1 260px"><span>${e.message}</span>${e.data.duplicates.map((x) => html`<a href="/app/clients/${x.id}" data-close>${x.name} (${x.code})</a>`)}</div></div>`); allowDup = true; b.closest('.modal').querySelector('.modal-actions .btn-primary').textContent = 'Create anyway'; return false; }
        if (e.data?.existing) { mount(box, html`<div class="banner crm-dup" role="alert"><span>${e.message.replace(/ Open .*$/, '')} <a href="/app/clients/${e.data.existing.athlete_id}?add=sibling" data-close>Open ${e.data.existing.name} to add a sibling</a></span></div>`); return false; }
        throw e;
      }
    } }],
  });
  if (r) {
    if (r.membership && !r.membership.ok) toast(`Client created (${r.code}). The first charge didn't go through; the membership is past due until a card is added.`, 'warn');
    else toast(`Client created. Athlete ID ${r.code}. The welcome email is on its way.`);
    META = null;
    ctx.go(`/app/clients/${r.athlete_id}`);
  }
}

// ---------------------------------------------------------------- tasks page
async function renderTasks(ctx) {
  await meta();
  const owner = isOwner(ctx);
  let scope = owner && ctx.query.scope === 'all' ? 'all' : 'mine', status = ctx.query.status === 'done' ? 'done' : 'open';
  mount(ctx.el, html`${STYLE}<div class="crm" id="crm">${header(ctx, 'tasks', 'Follow-ups with a due date. Overdue and today’s also show on Today.', false)}
    <div class="crm-tools">${owner ? html`<div class="seg" role="group" aria-label="Whose"><button type="button" data-scope="mine">Mine</button><button type="button" data-scope="all">Everyone’s</button></div>` : ''}
      <div class="seg" role="group" aria-label="Show"><button type="button" data-status="open">To do</button><button type="button" data-status="done">Done</button></div>
      <button class="btn btn-primary" type="button" data-act="add-task" style="margin-left:auto">Add task</button></div>
    <section class="panel crm-tasks" id="tk" aria-live="polite"><p class="muted">Loading…</p></section></div>`);
  const root = ctx.el.querySelector('#crm');
  async function load() {
    root.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)));
    root.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === status)));
    history.replaceState({}, '', `/app/crm/tasks?${new URLSearchParams({ ...(scope === 'all' ? { scope } : {}), ...(status === 'done' ? { status } : {}) })}`.replace(/\?$/, ''));
    const r = await api.get(`/crm/tasks?scope=${scope}&status=${status}`);
    if (!ctx.isCurrent()) return;
    const groups = status === 'done' ? [['Done', r.tasks]] : [['Overdue', r.tasks.filter((t) => t.overdue)], ['Today', r.tasks.filter((t) => t.due_today)], ['Coming up', r.tasks.filter((t) => !t.overdue && !t.due_today)]];
    mount(root.querySelector('#tk'), r.tasks.length ? html`${groups.filter(([, l]) => l.length).map(([name, list]) => html`<div><h2 class="panel-title ${name === 'Overdue' ? 'crm-warn' : ''}" style="font-size:15px">${name} (${list.length})</h2><div class="list">${list.map((t) => taskRow(t))}</div></div>`)}`
      : html`<p class="panel-sub">${status === 'done' ? 'Nothing done yet.' : 'Nothing to do. Add a task from a lead, or here.'}</p>`);
  }
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.scope) { scope = t.dataset.scope; load(); }
    if (t.dataset.status) { status = t.dataset.status; load(); }
    if (t.dataset.task) taskAction(t, load);
    if (t.dataset.act === 'add-task') taskDialog(ctx, { onDone: load });
  });
  await load();
}

// ---------------------------------------------------------------- group messages (owners)
async function renderMessages(ctx) {
  const m = await meta(true);
  const business = ctx.settings?.business_name || 'Diamond Protocol';
  mount(ctx.el, html`${STYLE}<div class="crm" id="crm">${header(ctx, 'messages', 'Email or text a group: lost leads, trials that ended, leads by interest. See exactly who gets it first.', false)}
    <section class="panel" aria-labelledby="g1"><h2 class="panel-title" id="g1">1. Who it’s for</h2>
      <div class="crm-stagepick" role="radiogroup" aria-label="Audience">
        <label><input type="radio" name="aud" value="leads" checked> Leads</label>
        <label><input type="radio" name="aud" value="trials_ended"> Families whose trial ended without joining</label></div>
      <div class="form-grid" id="g-lead">
        <div class="field"><label class="label" for="g-stage">Stage</label><select class="input" id="g-stage">${options([{ id: 'open', name: 'Open leads' }, ...m.stages.map(([id, name]) => ({ id, name }))], 'lost', { blank: 'Every stage' })}</select></div>
        <div class="field" id="g-lr-f"><label class="label" for="g-lr">Lost because of</label><select class="input" id="g-lr">${options(m.lost_reasons.map(([id, name]) => ({ id, name })), 'schedule', { blank: 'Any reason' })}</select></div>
        <div class="field"><label class="label" for="g-int">Interested in</label><select class="input" id="g-int">${options(m.interests.map(([id, name]) => ({ id, name })), '', { blank: 'Anything' })}</select></div>
        <div class="field"><label class="label" for="g-src">Source</label><select class="input" id="g-src">${options(m.sources.map(([id, name]) => ({ id, name })), '', { blank: 'Every source' })}</select></div>
      </div>
      <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap"><span class="label">Send as</span><div class="seg" role="group" aria-label="Channel"><button type="button" data-ch="email" aria-pressed="true">Email</button><button type="button" data-ch="text" aria-pressed="false">Text</button></div>
        <button class="btn" type="button" data-act="preview">Show who gets it</button></div>
      <div id="g-prev" aria-live="polite"></div></section>
    <section class="panel" aria-labelledby="g2"><h2 class="panel-title" id="g2">2. The message</h2>
      <div class="field"><label class="label" for="g-t">Start from a template</label><select class="input" id="g-t"><option value="">Blank</option>${m.templates.map((t) => html`<option value="${t.key}">${t.name}</option>`)}</select></div>
      <div class="field" id="g-s-f"><label class="label" for="g-s">Subject</label><input class="input" id="g-s" maxlength="150"></div>
      <div class="field"><label class="label" for="g-b">Message</label><textarea class="input" id="g-b" rows="8"></textarea>
        <span class="hint">{first_name}, {athlete}, {business} and {staff} fill in for each person.</span><div class="crm-count" id="g-c" hidden></div></div>
      <div id="g-mode"></div>
      <div><button class="btn btn-primary" type="button" data-act="send" disabled>Show who gets it first</button></div></section></div>`);
  const root = ctx.el.querySelector('#crm');
  let channel = 'email', preview = null;
  const spec = () => ({ audience: root.querySelector('input[name=aud]:checked').value, stage: root.querySelector('#g-stage').value, lost_reason: root.querySelector('#g-stage').value === 'lost' ? root.querySelector('#g-lr').value : '', interest: root.querySelector('#g-int').value, source: root.querySelector('#g-src').value });
  const send = root.querySelector('[data-act=send]');
  const ta = root.querySelector('#g-b');
  bindCounter(root, ta, root.querySelector('#g-c'), m.sms_max_segments);
  function sync() {
    const s = spec();
    root.querySelector('#g-lead').hidden = s.audience !== 'leads';
    root.querySelector('#g-lr-f').hidden = s.stage !== 'lost';
    root.querySelector('#g-s-f').hidden = channel === 'text';
    root.querySelector('#g-c').hidden = channel !== 'text';
    mount(root.querySelector('#g-mode'), channel === 'text' ? html`<p class="hint" style="margin:0">Only people who said it’s OK to text, and never anyone who replied STOP. “Reply STOP to opt out” is worth adding the first time you text someone.${m.sms_mode === 'test' ? ` ${TEXT_TEST}` : ''}</p>`
      : html`<p class="hint" style="margin:0">Each email ends with an unsubscribe link; people who unsubscribed are left out.${m.email_mode === 'test' ? ` ${EMAIL_TEST}` : ''}</p>`);
    preview = null; send.disabled = true; send.textContent = 'Show who gets it first';
    mount(root.querySelector('#g-prev'), '');
  }
  root.addEventListener('change', (e) => {
    if (e.target.id === 'g-t') {
      const t = m.templates.find((x) => x.key === e.target.value);
      if (t) { root.querySelector('#g-s').value = t.subject; ta.value = t.body; ta.dispatchEvent(new Event('input')); }
      return;
    }
    if (['g-s', 'g-b'].includes(e.target.id)) return;
    sync();
  });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.ch) { channel = t.dataset.ch; root.querySelectorAll('[data-ch]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ch === channel))); sync(); return; }
    if (t.dataset.act === 'preview') {
      t.disabled = true;
      try {
        preview = await api.post('/crm/group/preview', { segment: spec(), channel });
        const row = (r) => html`<div class="list-row small"><div class="grow">${r.href ? html`<a href="${r.href}">${r.name}</a>` : r.name}<div class="muted">${channel === 'email' ? r.email || 'No email' : r.phone || 'No mobile'} · ${r.detail}</div></div>${r.reason ? html`<span class="crm-warn">${r.reason}</span>` : ''}</div>`;
        mount(root.querySelector('#g-prev'), html`<div class="banner info" role="status"><span><b>${plural(preview.count, 'person', 'people')}</b> will get this ${channel}: ${preview.description.toLowerCase()}.${preview.excluded_count ? ` ${preview.excluded_count} left out.` : ''}</span></div>
          ${preview.count ? html`<details><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center">See the ${plural(preview.count, 'recipient')}</summary><div class="list crm-prev">${preview.recipients.map(row)}</div></details>` : ''}
          ${preview.excluded_count ? html`<details><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center">Left out (${preview.excluded_count})</summary><div class="list crm-prev">${preview.excluded.map(row)}</div></details>` : ''}`);
        send.disabled = !preview.count;
        send.textContent = preview.count ? `Send to ${plural(preview.count, 'person', 'people')}` : 'Nobody to send to';
      } catch (err) { toastError(err); } finally { t.disabled = false; }
      return;
    }
    if (t.dataset.act === 'send' && preview) {
      const sample = preview.recipients[0];
      const example = sample ? fillTemplate(ta.value, { name: sample.name, athletes: [] }, ctx.me, business) : '';
      if (!(await confirmDialog(`Send to ${plural(preview.count, 'person', 'people')}?`, `This ${channel} goes to ${preview.description.toLowerCase()} now. For ${sample?.name || 'the first person'} it starts: “${example.slice(0, 120)}${example.length > 120 ? '…' : ''}”`, `Send ${channel}`))) return;
      t.disabled = true;
      try {
        const r = await api.post('/crm/group/send', { segment: spec(), channel, subject: root.querySelector('#g-s').value, body: ta.value, expected_count: preview.count });
        toast(`Sent to ${plural(r.sent, 'person', 'people')}${r.failed.length ? `; ${r.failed.length} not sent (${r.failed[0].error})` : ''}.`, r.failed.length ? 'warn' : 'good');
        sync();
      } catch (err) { toastError(err); if (err.status === 409) sync(); else t.disabled = false; }
    }
  });
  sync();
}

// ---------------------------------------------------------------- reports (owners)
async function renderReports(ctx) {
  await meta();
  const today = localISO();
  const ago = (n) => localISO(new Date(Date.now() - n * 864e5));
  let from = ctx.query.from || ago(89), to = ctx.query.to || today;
  mount(ctx.el, html`${STYLE}<div class="crm" id="crm">${header(ctx, 'reports', 'Where leads come from, how many join, how long it takes and why the rest don’t.', false)}
    <form class="crm-tools" id="rp-f" novalidate>
      <div class="field"><label class="label small" for="rp-from">From</label><input class="input" type="date" id="rp-from" value="${from}" max="${today}"></div>
      <div class="field"><label class="label small" for="rp-to">To</label><input class="input" type="date" id="rp-to" value="${to}" max="${today}"></div>
      <div class="seg" role="group" aria-label="Period" style="align-self:flex-end">${[[30, '30 days'], [90, '90 days'], [365, '12 months']].map(([n, l]) => html`<button type="button" data-days="${n}">${l}</button>`)}</div>
    </form>
    <div id="rp" aria-live="polite"><p class="muted">Loading…</p></div></div>`);
  const root = ctx.el.querySelector('#crm');
  const bars = (rows, val, max, labelOf, note) => html`<div class="crm-bars">${rows.map((r) => html`<div class="crm-bar"><span>${labelOf(r)}</span><div class="bar" role="img" aria-label="${labelOf(r)}: ${note(r)}"><span style="width:${max ? Math.round((val(r) / max) * 100) : 0}%"></span></div><span class="v">${note(r)}</span></div>`)}</div>`;
  async function load() {
    history.replaceState({}, '', `/app/crm/reports?from=${from}&to=${to}`);
    let r;
    try { r = await api.get(`/crm/reports?from=${from}&to=${to}`); } catch (e) { mount(root.querySelector('#rp'), html`<div class="banner">${e.message}</div>`); return; }
    if (!ctx.isCurrent()) return;
    const maxSrc = Math.max(1, ...r.by_source.map((s) => s.leads));
    mount(root.querySelector('#rp'), html`<div class="stack">
      <div class="metrics">
        <div class="metric"><span class="metric-label">New leads</span><span class="metric-value">${r.leads}</span><span class="metric-note">${fmtDate(r.from)} to ${fmtDate(r.to)}</span></div>
        <div class="metric"><span class="metric-label">Became members</span><span class="metric-value good">${r.members}</span><span class="metric-note">${r.open} still open</span></div>
        <div class="metric"><span class="metric-label">Conversion rate</span><span class="metric-value">${r.conversion_rate == null ? '—' : `${r.conversion_rate}%`}</span><span class="metric-note">Leads that became members</span></div>
        <div class="metric"><span class="metric-label">First contact to member</span><span class="metric-value">${r.time_to_member.average_days == null ? '—' : r.time_to_member.average_days}</span><span class="metric-note">${r.time_to_member.count ? `Days on average; median ${r.time_to_member.median_days}` : 'No members yet in this period'}</span></div>
      </div>
      ${r.leads ? html`<div class="grid-2">
        <section class="panel"><h2 class="panel-title">Leads by source</h2><p class="panel-sub">Bar: leads. Right: members and conversion rate.</p>
          ${bars(r.by_source, (s) => s.leads, maxSrc, (s) => s.label, (s) => `${s.leads} · ${s.members} joined (${s.rate}%)`)}</section>
        <section class="panel"><h2 class="panel-title">Where they are now</h2><p class="panel-sub">Leads from this period, by stage today.</p>
          ${bars(r.stages, (s) => s.count, Math.max(1, ...r.stages.map((s) => s.count)), (s) => s.label, (s) => String(s.count))}</section>
        <section class="panel"><h2 class="panel-title">Why leads were lost</h2>
          ${r.lost_reasons.length ? bars(r.lost_reasons, (s) => s.count, Math.max(1, ...r.lost_reasons.map((s) => s.count)), (s) => s.label, (s) => String(s.count)) : html`<p class="panel-sub">No lost leads in this period.</p>`}</section>
        <section class="panel"><h2 class="panel-title">Conversion by source</h2>
          <div class="table-wrap"><table class="table"><thead><tr><th>Source</th><th class="num">Leads</th><th class="num">Members</th><th class="num">Rate</th></tr></thead>
          <tbody>${r.by_source.map((s) => html`<tr><td>${s.label}</td><td class="num">${s.leads}</td><td class="num">${s.members}</td><td class="num">${s.rate}%</td></tr>`)}
            <tr><td class="strong">All sources</td><td class="num strong">${r.leads}</td><td class="num strong">${r.members}</td><td class="num strong">${r.conversion_rate}%</td></tr></tbody></table></div></section>
      </div>` : html`<div class="empty">No leads first got in touch in this period.</div>`}</div>`);
  }
  root.querySelector('#rp-f').addEventListener('change', () => { from = root.querySelector('#rp-from').value; to = root.querySelector('#rp-to').value; if (from && to) load(); });
  root.addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (!b) return; from = ago(+b.dataset.days - 1); to = today; root.querySelector('#rp-from').value = from; root.querySelector('#rp-to').value = to; load(); });
  await load();
}

// ---------------------------------------------------------------- import & export (owners)
const SAMPLE = 'Parent name,Email,Phone,Athlete,Age,Grad year,Sport,Source,Referred by,Interest,Notes\nSarah Miller,sarah@example.com,801-555-0188,Jake,13,2031,Baseball,Website form,,Evaluation,Wants velocity work\n';
async function renderImport(ctx) {
  const m = await meta();
  mount(ctx.el, html`${STYLE}<div class="crm" id="crm">${header(ctx, 'import', 'Bring in leads from a spreadsheet, or take them out.', false)}
    <section class="panel" aria-labelledby="im-h"><h2 class="panel-title" id="im-h">Import leads</h2>
      <p class="panel-sub">A CSV with a header row. Columns: Parent name, and Email or Phone, are needed. Optional: Athlete (several split by ;), Age, Grad year, Sport, Position, Source, Referred by, Interest, Stage, Owner, Notes, Created. You see every row before anything is saved.</p>
      <div class="btn-row"><label class="btn" for="im-file">${icon('upload', 18)} Choose CSV file</label><input type="file" id="im-file" accept=".csv,text/csv,text/plain" class="sr-only">
        <button class="btn btn-ghost" type="button" data-act="sample">${icon('download', 18)} Download a sample</button></div>
      <div class="field"><label class="label" for="im-text">Or paste rows from your spreadsheet</label><textarea class="input mono" id="im-text" rows="6" placeholder="${SAMPLE.split('\n')[0]}"></textarea></div>
      <div><button class="btn" type="button" data-act="check">Check rows</button></div>
      <div id="im-prev" aria-live="polite"></div></section>
    <section class="panel" aria-labelledby="ex-h"><h2 class="panel-title" id="ex-h">Export leads</h2>
      <p class="panel-sub">A CSV of leads with contact details, stage, source, owner, days in stage and contact preferences.</p>
      <div class="crm-tools"><label class="sr-only" for="ex-stage">Stage</label><select class="input" id="ex-stage" style="max-width:260px">${options([{ id: 'open', name: 'Open leads' }, ...m.stages.map(([id, name]) => ({ id, name }))], '', { blank: 'Every lead' })}</select>
        <a class="btn" id="ex-go" href="/api/crm/export.csv" download>${icon('download', 18)} Export CSV</a></div></section></div>`);
  const root = ctx.el.querySelector('#crm');
  const text = root.querySelector('#im-text');
  root.querySelector('#ex-stage').addEventListener('change', (e) => { root.querySelector('#ex-go').href = `/api/crm/export.csv${e.target.value ? `?stage=${e.target.value}` : ''}`; });
  root.querySelector('#im-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 1e6) { toast('That file is too big. Import up to 1,000 leads at a time.', 'warn'); return; } text.value = await f.text(); check(); });
  let rows = null;
  async function check() {
    const box = root.querySelector('#im-prev');
    try {
      const r = await api.post('/crm/import', { text: text.value, preview: true });
      rows = r;
      const st = { new: html`<span class="crm-status-new">New</span>`, duplicate: html`<span class="muted">Already on file</span>`, error: html`<span class="crm-warn">Problem</span>` };
      mount(box, html`<div class="banner ${r.counts.error ? '' : 'info'}" role="status"><span>${plural(r.counts.new, 'new lead')} ready. ${r.counts.duplicate ? `${plural(r.counts.duplicate, 'row')} already on file. ` : ''}${r.counts.error ? `${plural(r.counts.error, 'row')} with problems: fix them in the file and check again, or skip them.` : ''}</span></div>
        <div class="table-wrap crm-prev"><table class="table"><thead><tr><th>Row</th><th>Name</th><th>Contact</th><th>Result</th></tr></thead><tbody>
          ${r.rows.map((x) => html`<tr><td>${x.line}</td><td>${x.name || html`<span class="muted">—</span>`}</td><td class="small">${[x.email, fmtPhone(x.phone)].filter(Boolean).join(' · ')}</td><td>${st[x.status]}${x.error || x.reason ? html`<div class="small ${x.error ? 'crm-warn' : 'muted'}">${x.error || x.reason}</div>` : ''}</td></tr>`)}</tbody></table></div>
        ${r.counts.duplicate ? html`<label class="check small"><input type="checkbox" id="im-dup"> Add the ${plural(r.counts.duplicate, 'row')} already on file as new leads too</label>` : ''}
        <div class="btn-row">${r.counts.new || r.counts.duplicate ? html`<button class="btn btn-primary" type="button" data-act="save">${r.counts.error ? `Save ${plural(r.counts.new, 'lead')}, skip ${r.counts.error} with problems` : `Save ${plural(r.counts.new, 'lead')}`}</button>` : ''}</div>`);
    } catch (e) { rows = null; mount(box, html`<div class="banner" role="alert">${e.message}</div>`); }
  }
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'sample') download('leads-sample.csv', SAMPLE);
    if (t.dataset.act === 'check') check();
    if (t.dataset.act === 'save' && rows) {
      t.disabled = true;
      try {
        const r = await api.post('/crm/import', { text: text.value, skip_errors: true, include_duplicates: !!root.querySelector('#im-dup')?.checked });
        toast(`Imported ${plural(r.created, 'lead')}${r.skipped ? `, skipped ${r.skipped}` : ''}.`);
        META = null; ctx.go('/app/crm?view=list&sort=newest');
      } catch (err) { toastError(err); t.disabled = false; }
    }
  });
}

// ---------------------------------------------------------------- settings (owners)
async function renderSettings(ctx) {
  const [s, tpls] = await Promise.all([api.get('/crm/settings'), api.get('/crm/templates')]);
  if (!ctx.isCurrent()) return;
  mount(ctx.el, html`${STYLE}<div class="crm" id="crm">${header(ctx, 'settings', 'The website form, who hears about enquiries, email templates and texting.', false)}
    <section class="panel" aria-labelledby="wf-h"><h2 class="panel-title" id="wf-h">Website enquiry form</h2>
      <p class="panel-sub">Enquiries from the form arrive as New leads with source Website form, and the people below get an email. Bots are kept out by a hidden field and a limit of 5 enquiries per 10 minutes from one address.</p>
      <div class="btn-row"><a class="btn" href="${s.form_url}" target="_blank" rel="noopener">Open the form</a><button class="btn btn-ghost" type="button" data-copy="${s.form_url}">Copy link</button></div>
      <div><div class="label">Embed it on your website</div><p class="hint" style="margin:2px 0 8px">Paste this where the form should appear.</p><pre class="crm-snip">${s.embed}</pre>
        <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" type="button" data-copy="${s.embed}">Copy embed code</button></div></div>
      <p class="hint" style="margin:0">Building your own form? POST JSON to <span class="mono">${s.form_json}</span> with parent_name, email, phone, athlete_name, athlete_age, grad_year, sport, interest, message and sms_opt_in. The API reference also has <span class="mono">POST /api/v1/leads</span> with an API key.</p>
    </section>
    <form class="panel" id="nf" aria-labelledby="nf-h" novalidate><h2 class="panel-title" id="nf-h">Enquiry emails</h2>
      <div class="field"><label class="label" for="nf-e">Email new enquiries to</label><input class="input" id="nf-e" name="notify_email" value="${s.notify_email}" placeholder="${s.notify_default.join(', ')}" style="max-width:480px">
        <span class="hint">Up to 5 addresses, separated by commas. Leave blank to email the owners.</span></div>
      <div><button class="btn" type="submit">Save</button></div></form>
    <section class="panel" aria-labelledby="tp-h"><div class="panel-head"><h2 class="panel-title" id="tp-h">Templates</h2><button class="btn btn-sm btn-ghost" type="button" data-act="reset">Reset to the originals</button></div>
      <p class="panel-sub">Used for emails and texts to one lead and for group messages. {first_name}, {athlete}, {business} and {staff} fill in for each person. Texts use the message only.</p>
      <form class="stack" id="tp" novalidate>${tpls.map((t) => html`<details class="stack-sm" data-key="${t.key}"><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600">${t.name}</summary>
        <div class="field"><label class="label small" for="tp-n-${t.key}">Name</label><input class="input" id="tp-n-${t.key}" data-f="name" value="${t.name}" maxlength="60"></div>
        <div class="field"><label class="label small" for="tp-s-${t.key}">Subject</label><input class="input" id="tp-s-${t.key}" data-f="subject" value="${t.subject}" maxlength="150"></div>
        <div class="field"><label class="label small" for="tp-b-${t.key}">Message</label><textarea class="input" id="tp-b-${t.key}" data-f="body" rows="8">${t.body}</textarea></div></details>`)}
        <div><button class="btn btn-primary" type="submit">Save templates</button></div></form></section>
    <section class="panel" aria-labelledby="sm-h"><h2 class="panel-title" id="sm-h">Texting</h2>
      ${s.sms_mode === 'test' ? html`<div class="banner" role="note">No texting service is connected. Texts are saved to the outbox until one is. Set DP_SMS_PROVIDER=twilio with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM on the server.</div>`
        : html`<div class="banner info" role="note">Texts are sent${s.sms_mode === 'restricted' ? ', but only to the numbers in DP_SMS_ONLY_TO' : ''}.</div>`}
      <p class="panel-sub">Point your texting service's incoming messages at <span class="mono">${s.sms_inbound_url}</span>. STOP, START and HELP are handled for you, and replies show on the lead’s timeline. Every text is in <a href="/app/integrations?tab=sms">API & integrations, Text outbox</a>.</p></section></div>`);
  const root = ctx.el.querySelector('#crm');
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.copy) copy(t.dataset.copy, 'Copied.');
    if (t.dataset.act === 'reset') {
      if (!(await confirmDialog('Reset the templates?', 'Your changes to all four templates are replaced by the originals.', 'Reset templates', 'warn'))) return;
      try { await api.put('/crm/templates', { reset: true }); META = null; toast('Templates reset.'); ctx.reload(); } catch (err) { toastError(err); }
    }
  });
  root.querySelector('#nf').addEventListener('submit', async (e) => { e.preventDefault(); try { await api.put('/crm/settings', formData(e.target)); toast('Saved.'); } catch (err) { toastError(err); } });
  root.querySelector('#tp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const templates = [...e.target.querySelectorAll('[data-key]')].map((d) => ({ key: d.dataset.key, name: d.querySelector('[data-f=name]').value, subject: d.querySelector('[data-f=subject]').value, body: d.querySelector('[data-f=body]').value }));
    try { await api.put('/crm/templates', { templates }); META = null; toast('Templates saved.'); } catch (err) { toastError(err); }
  });
}

const CRM_ROLES = ['owner', 'frontdesk'];
export const routes = [
  { path: '/crm', nav: 'crm', title: 'CRM', roles: CRM_ROLES, render: renderPipeline },
  { path: '/crm/leads/:id', nav: 'crm', title: 'Lead', roles: CRM_ROLES, render: renderLead },
  { path: '/crm/tasks', nav: 'crm', title: 'Tasks', roles: CRM_ROLES, render: renderTasks },
  { path: '/crm/messages', nav: 'crm', title: 'Group messages', roles: ['owner'], render: renderMessages },
  { path: '/crm/reports', nav: 'crm', title: 'CRM reports', roles: ['owner'], render: renderReports },
  { path: '/crm/import', nav: 'crm', title: 'Import & export', roles: ['owner'], render: renderImport },
  { path: '/crm/settings', nav: 'crm', title: 'CRM settings', roles: ['owner'], render: renderSettings },
];
