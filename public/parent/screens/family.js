// Family: what's left to finish, card on file and payments, waiver, each athlete's details, parents, sign-in.
// Each section redraws on its own after a change, so an open athlete or a half-filled form elsewhere stays as it was.
import { html, raw, mount, api, icon, toast, toastError, formData, fmtDate, money, badge, modal, confirmDialog, plural, localISO } from '/js/ui.js';
import { header, dayShort } from '../common.js';
import { cardState } from './home.js';

const sel = (v, x) => (v === x ? raw('selected') : '');
const STATUS = { active: 'Active', trial: 'Trial', past_due: 'Past due', paused: 'Paused' };
const PAYMENTS_SHOWN = 5;

// What a coach needs on file for each athlete: a birthday (class ages) and someone to call.
function missingOf(a) {
  const m = [];
  if (!a.birthday) m.push('birthday');
  if (!a.emergency_name || !a.emergency_phone) m.push('emergency contact');
  return m;
}

function todoItems(me, acct) {
  const f = me.family, out = [];
  if (!f.waiver_current) out.push({ text: f.waiver_version ? 'The waiver has changed. Read and sign the new version.' : 'Sign the waiver before the first session.', label: 'Sign waiver', act: 'goto', target: 'waiver' });
  if (!f.card_last4) out.push({ text: 'Add a card for drop-ins, packs, camps and memberships.', label: 'Add card', href: '/parent/card' });
  else if (cardState(f.card_exp) === 'expired') out.push({ text: `The ${f.card_label} expired (${f.card_exp}).`, label: 'Replace card', href: '/parent/card' });
  const due = acct?.past_due || [];
  if (due.length) {
    const total = money(due.reduce((n, i) => n + i.amount_cents, 0));
    out.push({ text: due.length === 1 ? `A ${total} membership payment was declined.` : `${due.length} membership payments (${total}) were declined.`, label: due.length === 1 ? 'See payment' : 'See payments', act: 'goto', target: 'card' });
  }
  for (const a of me.athletes) {
    const m = missingOf(a);
    if (m.includes('emergency contact')) out.push({ text: `Add an emergency contact for ${a.first_name}.`, label: 'Add contact', act: 'open-athlete', id: a.id, field: a.emergency_name ? 'emergency_phone' : 'emergency_name' });
    if (m.includes('birthday')) out.push({ text: `Add ${a.first_name}'s birthday so Book shows classes for their age.`, label: 'Add birthday', act: 'open-athlete', id: a.id, field: 'birthday' });
  }
  return out;
}

function todoSection(me, acct) {
  const items = todoItems(me, acct);
  if (!items.length) return '';
  return html`<section class="panel" id="todo" aria-labelledby="todo-h">
    <div><h2 class="panel-title" id="todo-h">To finish</h2><p class="panel-sub">${plural(items.length, 'thing')} left on your account.</p></div>
    <div class="note-rows">${items.map((t) => html`<div class="note-row warn"><span>${t.text}</span>${t.href
      ? html`<a class="btn btn-sm" href="${t.href}">${t.label}</a>`
      : html`<button type="button" class="btn btn-sm" data-act="${t.act}" data-target="${t.target || ''}" data-id="${t.id || ''}" data-field="${t.field || ''}">${t.label}</button>`}</div>`)}</div>
  </section>`;
}

function cardSection(me, acct) {
  const f = me.family;
  const cs = f.card_last4 ? cardState(f.card_exp) : null;
  const due = acct?.past_due || [];
  const canRetry = f.card_last4 && cs !== 'expired';
  return html`<section class="panel" id="card" aria-labelledby="card-h">
    <div><h2 class="panel-title" id="card-h">Card on file</h2><p class="panel-sub">Pays for memberships, packs, camps and drop-ins for everyone in your family.</p></div>
    ${f.card_last4
      ? html`<div class="fm-card"><span class="fm-card-ic">${icon('card', 22)}</span><div class="grow"><div class="strong">${f.card_label}</div>
          <div class="small ${cs ? 'warn-text' : 'muted'}">${cs === 'expired' ? `Expired ${f.card_exp}. Replace it so payments keep working.` : cs === 'soon' ? `Expires at the end of ${f.card_exp}. Replace it before then.` : f.card_exp ? `Expires ${f.card_exp}` : ''}</div></div></div>`
      : html`<p class="warn-text" style="margin:0">No card on file.</p>`}
    ${due.map((i) => html`<div class="fm-due"><div class="grow"><div class="strong">${money(i.amount_cents)} past due</div>
        <div class="small">${i.description || 'Membership'}${i.athlete ? ` for ${i.athlete}` : ''}. Declined ${fmtDate(i.issued_at)}.</div></div>
        ${canRetry ? html`<button type="button" class="btn btn-warn btn-sm" data-act="retry" data-id="${i.id}">Try again</button>` : ''}</div>`)}
    ${due.length ? html`<p class="small muted" style="margin:0">${canRetry ? `Try again charges the ${f.card_label}. ` : ''}Saving a new card tries ${due.length === 1 ? 'it' : 'them'} again right away.</p>` : ''}
    <div class="btn-row"><a class="btn ${f.card_last4 || !f.waiver_current ? '' : 'btn-primary'}" href="/parent/card">${f.card_last4 ? 'Replace card' : 'Add a card'}</a>
      ${f.card_last4 && me.settings.payments_mode !== 'live' ? html`<button type="button" class="btn btn-ghost" data-act="remove-card">Remove card</button>` : ''}</div>
    <p class="small muted" style="margin:0">Cards are stored by Stripe. ${me.settings.business_name} never sees your full card number.</p>
  </section>`;
}

function paymentRow(p) {
  const year = p.date && p.date.slice(0, 4) !== String(new Date().getFullYear()) ? p.date.slice(0, 4) : '';
  return html`<li class="fm-pay-row">
    <div class="fm-pay-date">${p.date ? dayShort(p.date) : ''}${year ? html`<span>${year}</span>` : ''}</div>
    <div class="grow"><div class="fm-pay-desc">${p.description || (p.refund ? 'Refund' : 'Charge')}</div><div class="small muted">${p.athlete ? `${p.athlete} · ` : ''}${p.number}</div></div>
    <div class="fm-pay-amt"><div class="${p.refund ? 'good-text' : p.status === 'failed' ? 'warn-text' : ''}">${p.refund ? `${money(-p.amount_cents)} back` : money(p.amount_cents)}</div>
      ${p.status === 'failed' ? badge('failed', 'Declined') : p.status === 'open' ? badge('open', 'Due') : p.receipt
        ? html`<a class="fm-receipt" href="/invoice/${p.receipt}" target="_blank" rel="noopener" aria-label="Receipt for ${p.description || p.number}, opens in a new tab">Receipt</a>` : ''}</div>
  </li>`;
}

function paymentsSection(acct, showAll) {
  if (!acct) {
    return html`<section class="panel" id="payments"><h2 class="panel-title">Payments</h2>
      <p class="warn-text" style="margin:0">Payments didn't load.</p><div><button type="button" class="btn btn-sm" data-act="reload-account">Try again</button></div></section>`;
  }
  const list = showAll ? acct.payments : acct.payments.slice(0, PAYMENTS_SHOWN);
  return html`<section class="panel" id="payments" aria-labelledby="pay-h">
    <div><h2 class="panel-title" id="pay-h">Payments</h2>
      <p class="panel-sub">${acct.payments.length ? `Paid this year: ${money(acct.paid_this_year_cents)}. Open a receipt to print or save it.` : 'Every charge shows here with a receipt.'}</p></div>
    ${acct.payments.length
      ? html`<ul class="fm-pay">${list.map(paymentRow)}</ul>`
      : html`<p class="muted" style="margin:0">No payments yet. Memberships, packs, camps and drop-ins show here once they're paid.</p>`}
    ${!showAll && acct.payments.length > PAYMENTS_SHOWN ? html`<button type="button" class="btn btn-ghost" data-act="all-payments">Show all ${acct.payments.length}${acct.more_payments ? '+' : ''} payments</button>` : ''}
  </section>`;
}

const names = (list) => {
  const n = list.map((a) => a.first_name);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

function waiverSection(me) {
  const f = me.family, s = me.settings;
  const text = html`<div class="waiver-box" tabindex="0" aria-label="Waiver text">${s.waiver_text || 'No waiver text yet.'}</div>`;
  if (f.waiver_current) {
    return html`<section class="panel" id="waiver" aria-labelledby="waiver-h">
      <div class="spread"><h2 class="panel-title" id="waiver-h">Waiver</h2>${badge('signed')}</div>
      <p class="panel-sub" style="margin:0">Signed by ${f.waiver_signed_by} on ${fmtDate(f.waiver_signed_at)}. It covers everyone in your family.</p>
      <details class="fm-read"><summary>Read the waiver</summary>${text}</details>
      <div><button type="button" class="btn btn-sm" data-act="waiver-copy">Email me a copy</button></div>
    </section>`;
  }
  const who = me.athletes.length ? names(me.athletes) : 'everyone in my family';
  return html`<section class="panel" id="waiver" aria-labelledby="waiver-h">
    <div><h2 class="panel-title" id="waiver-h">Waiver</h2>
      <p class="panel-sub">${f.waiver_version ? 'The waiver has changed since you signed. Read and sign the new version.' : 'Not signed yet. Read it and sign below.'}</p></div>
    ${text}
    <form class="stack" id="waiver-form" novalidate>
      <label class="check"><input type="checkbox" name="agree"><span>I've read the waiver and agree to it for ${who}.</span></label>
      <div class="field"><label class="label" for="sig">Type your full name to sign</label><input class="input" id="sig" name="name" autocomplete="name" maxlength="80" value="" placeholder="${me.parent.name}"></div>
      <div class="error" role="alert" id="waiver-err"></div>
      <div><button class="btn btn-primary">Sign waiver</button></div>
    </form>
  </section>`;
}

function athleteFields(a, prefix, siblings = []) {
  const id = (k) => `${prefix}-${k}`;
  const f = (k, label, attrs = '') => html`<div class="field"><label class="label" for="${id(k)}">${label}</label><input class="input" id="${id(k)}" name="${k}" value="${a[k] || ''}" maxlength="500" ${raw(attrs)}></div>`;
  // A brother or sister with a different emergency contact on file: offer to copy it.
  const src = siblings.find((s) => s.id !== a.id && s.emergency_name && s.emergency_phone && (s.emergency_name !== a.emergency_name || s.emergency_phone !== a.emergency_phone));
  return html`
    ${prefix === 'new' ? html`<div class="form-grid">${f('first_name', 'First name', 'required autocomplete="off" maxlength="80"')}${f('last_name', 'Last name', 'required autocomplete="off" maxlength="80"')}</div>` : ''}
    <fieldset class="fm-group"><legend>About</legend><div class="form-grid">
      ${f('birthday', 'Birthday', `type="date" max="${localISO()}" min="1920-01-01"`)}
      <div class="field"><label class="label" for="${id('sex')}">Sex</label><select class="input" id="${id('sex')}" name="sex">
        <option value="" ${sel(a.sex || '', '')}>Not set</option><option value="F" ${sel(a.sex, 'F')}>Female</option><option value="M" ${sel(a.sex, 'M')}>Male</option></select>
        <span class="hint">Used for the growth-spurt estimate.</span></div>
      ${f('sport', 'Sport', 'autocomplete="off"')}${f('position', 'Position', 'autocomplete="off"')}${f('school', 'School', 'autocomplete="off"')}
    </div></fieldset>
    <fieldset class="fm-group"><legend>Health</legend><div class="form-grid">
      ${f('allergies', 'Allergies', 'autocomplete="off"')}${f('injuries', 'Injuries', 'autocomplete="off"')}
      <div class="field span-2"><label class="label" for="${id('medical_notes')}">Medical notes</label><textarea class="input" id="${id('medical_notes')}" name="medical_notes" rows="3" maxlength="500">${a.medical_notes || ''}</textarea>
        <span class="hint">Anything the coach should know: conditions, medication, recent injuries.</span></div>
    </div></fieldset>
    <fieldset class="fm-group"><legend>Emergency contact</legend><div class="form-grid">
      ${f('emergency_name', 'Name', 'autocomplete="off"')}${f('emergency_phone', 'Phone', 'type="tel" autocomplete="off" inputmode="tel"')}
    </div>${src ? html`<div><button type="button" class="btn btn-ghost btn-sm" data-act="copy-contact" data-name="${src.emergency_name}" data-phone="${src.emergency_phone}">Use ${src.first_name}'s contact: ${src.emergency_name}</button></div>` : ''}</fieldset>`;
}

function membershipLine(a) {
  const m = a.membership;
  const programs = `/parent/programs?athlete=${a.id}`;
  if (!m) return html`<div class="fm-mem"><span class="muted">No membership.</span> <a href="${programs}">See plans</a></div>`;
  const when = m.next_charge ? (m.status === 'trial' ? `Trial ends ${dayShort(m.next_charge)}` : m.status === 'active' ? `Renews ${dayShort(m.next_charge)}` : '') : '';
  return html`<div class="fm-mem"><span>${m.plan_name}</span> ${badge(m.status, STATUS[m.status])}${when ? html`<span class="muted small">${when}</span>` : ''} <a href="${programs}#membership">Manage</a></div>`;
}

function athleteMeta(a) {
  const bits = [];
  if (a.age != null) bits.push(`Age ${a.age}`);
  const sp = [a.sport, a.position].filter(Boolean).join(', ');
  if (sp) bits.push(sp);
  if (a.membership) bits.push(a.membership.plan_name);
  return bits.join(' · ');
}

function athleteDetails(a, me, open = false) {
  const miss = missingOf(a);
  return html`<details class="panel panel-tight fm-ath" data-ath="${a.id}" ${open ? raw('open') : ''}>
    <summary><span class="fm-ath-h"><span class="fm-ath-name">${a.first_name} ${a.last_name}</span><span class="fm-ath-meta">${athleteMeta(a) || 'Add their details'}</span></span>
      ${miss.length ? html`<span class="fm-ath-flag">${badge('warn', `Needs ${miss.join(' and ')}`)}</span>` : ''}</summary>
    <div class="fm-ath-top">
      <div class="fm-id"><span class="muted small">Athlete ID</span> <span class="mono">${a.code}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-act="copy-id" data-code="${a.code}" aria-label="Copy ${a.first_name}'s Athlete ID">Copy</button></div>
      ${membershipLine(a)}
    </div>
    <form class="stack" data-athlete-form="${a.id}" novalidate>
      ${athleteFields(a, `a${a.id}`, me.athletes)}
      <div class="error" role="alert" data-err></div>
      <div class="btn-row fm-save"><button class="btn btn-primary" disabled>Save ${a.first_name}'s details</button><span class="small muted" data-dirty hidden>Unsaved changes</span></div>
    </form></details>`;
}

function athletesSection(me, openIds) {
  return html`<h2 class="sec-label">Athletes</h2>
    ${me.athletes.length ? me.athletes.map((a) => athleteDetails(a, me, openIds.has(a.id))) : html`<p class="muted" style="margin:0">No athletes on the account yet. Add one below.</p>`}
    <details class="panel panel-tight" id="add-athlete" ${me.athletes.length ? '' : raw('open')}>
      <summary>Add another athlete</summary>
      <form class="stack" id="new-athlete" novalidate>
        ${athleteFields({}, 'new', me.athletes)}
        <p class="small muted" style="margin:0">They get their own Athlete ID and workouts. Sessions and packs are per athlete; the card pays for everyone.</p>
        <div class="error" role="alert" data-err></div>
        <div class="btn-row"><button class="btn btn-primary">Add athlete</button></div>
      </form>
    </details>`;
}

function parentsSection(me, editMe) {
  const full = me.parents.length >= 6;
  return html`<section class="panel" id="parents" aria-labelledby="parents-h">
    <h2 class="panel-title" id="parents-h">Parents</h2>
    <div class="list">${me.parents.map((p) => {
      const mine = p.id === me.parent.id;
      if (mine && editMe) {
        return html`<form class="list-row fm-me" id="me-form" novalidate><div class="grow stack">
          <div class="form-grid">
            <div class="field"><label class="label" for="me-name">Your name</label><input class="input" id="me-name" name="name" value="${p.name}" autocomplete="name" maxlength="80"></div>
            <div class="field"><label class="label" for="me-phone">Phone</label><input class="input" id="me-phone" name="phone" type="tel" inputmode="tel" value="${p.phone || ''}" autocomplete="tel"></div>
          </div>
          <p class="small muted" style="margin:0">You sign in with ${p.email}. To change it, ask the front desk.</p>
          <div class="error" role="alert" data-err></div>
          <div class="btn-row"><button class="btn btn-primary">Save my details</button><button type="button" class="btn btn-ghost" data-act="edit-me-cancel">Cancel</button></div>
        </div></form>`;
      }
      return html`<div class="list-row"><div class="grow"><div>${p.name}${mine ? html` <span class="muted small">(you)</span>` : ''}</div>
        <div class="small muted fm-contact">${p.email}${p.phone ? ` · ${p.phone}` : ''}</div></div>
        ${mine ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="edit-me" aria-label="Edit your name and phone">Edit</button>` : ''}</div>`;
    })}</div>
    ${full ? html`<p class="small muted" style="margin:0">To add another parent, ask the front desk.</p>` : html`<details class="fm-add-parent"><summary class="btn btn-sm">Add a parent</summary>
      <form class="stack" id="new-parent" style="margin-top:12px" novalidate>
        <div class="form-grid">
          <div class="field"><label class="label" for="np-name">Name</label><input class="input" id="np-name" name="name" autocomplete="off" maxlength="80"></div>
          <div class="field"><label class="label" for="np-email">Email</label><input class="input" id="np-email" name="email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" autocomplete="off"></div>
          <div class="field"><label class="label" for="np-phone">Phone</label><input class="input" id="np-phone" name="phone" type="tel" inputmode="tel" autocomplete="off"></div>
        </div>
        <p class="small muted" style="margin:0">They sign in at this portal with their own email and can book, pay with the card on file and see progress. We email them how to sign in, and let the other parents know.</p>
        <div class="error" role="alert" data-err></div>
        <div><button class="btn btn-primary">Add parent</button></div>
      </form></details>`}
  </section>`;
}

function signinSection(me, acct) {
  const others = acct?.other_sessions || 0;
  return html`<section class="panel" id="signin" aria-labelledby="signin-h">
    <div><h2 class="panel-title" id="signin-h">Signed in</h2>
      <p class="panel-sub">As <span class="p-email">${me.parent.email}</span> on this device.${others ? ` Also signed in on ${plural(others, 'other phone or browser', 'other phones or browsers')}.` : ''}</p></div>
    <div class="btn-row">${others ? html`<button type="button" class="btn" data-act="end-others">Sign out everywhere else</button>` : ''}
      <button type="button" class="btn btn-ghost" id="signout" data-act="signout">Sign out</button></div>
  </section>`;
}

export async function render(ctx) {
  const state = { me: ctx.me, acct: await api.get('/parent/account').catch(() => null), open: new Set(), allPayments: false, editMe: false };
  if (!ctx.isCurrent()) return;
  const S = (name, content) => html`<div class="fm-sec" id="fm-${name}">${content}</div>`;
  mount(ctx.el, html`${header('Family', ctx.familyName)}
    ${S('todo', todoSection(state.me, state.acct))}
    ${S('card', cardSection(state.me, state.acct))}
    ${S('payments', paymentsSection(state.acct, false))}
    ${S('waiver', waiverSection(state.me))}
    ${S('athletes', athletesSection(state.me, state.open))}
    ${S('parents', parentsSection(state.me, false))}
    ${S('signin', signinSection(state.me, state.acct))}`);

  const $ = (s) => ctx.el.querySelector(s);
  const SECTIONS = {
    todo: () => todoSection(state.me, state.acct),
    card: () => cardSection(state.me, state.acct),
    payments: () => paymentsSection(state.acct, state.allPayments),
    waiver: () => waiverSection(state.me),
    athletes: () => athletesSection(state.me, state.open),
    parents: () => parentsSection(state.me, state.editMe),
    signin: () => signinSection(state.me, state.acct),
  };
  const draw = (...names) => { for (const n of names) { const box = $(`#fm-${n}`); if (box) mount(box, SECTIONS[n]()); } bindForms(); };
  const refreshMe = async () => { state.me = await api.get('/parent/me'); };
  const refreshAccount = async () => { state.acct = await api.get('/parent/account').catch(() => state.acct); };
  const focusTitle = (sel) => { const el = $(sel); if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } };

  // One athlete's details, redrawn in place (keeps the others, and whatever is typed in them).
  const drawAthlete = (id, open = true) => {
    const old = ctx.el.querySelector(`[data-ath="${id}"]`);
    const a = state.me.athletes.find((x) => x.id === id);
    if (!old || !a) return;
    const tpl = document.createElement('template');
    mount(tpl, athleteDetails(a, state.me, open));
    old.replaceWith(tpl.content);
    bindForms();
  };

  const busy = async (form, fn) => {
    const b = form.querySelector('button:not([type=button])');
    const err = form.querySelector('[data-err], .error');
    if (err) err.textContent = '';
    b.disabled = true;
    try { await fn(); }
    catch (e) { if (err && e.status === 400) err.textContent = e.message; else toastError(e); }
    finally { if (b.isConnected) b.disabled = false; form.markDirty?.(); }
  };

  // ---- athlete forms: Save turns on once something changed ----
  const snap = (form) => JSON.stringify(formData(form));
  function watchDirty(form) {
    if (form.dataset.bound) return;
    form.dataset.bound = '1';
    form.dataset.initial = snap(form);
    const btn = form.querySelector('.fm-save button');
    const flag = form.querySelector('[data-dirty]');
    form.markDirty = () => { const d = snap(form) !== form.dataset.initial; btn.disabled = !d; flag.hidden = !d; };
    form.addEventListener('input', form.markDirty);
    form.addEventListener('change', form.markDirty);
  }

  function bindForms() {
    ctx.el.querySelectorAll('[data-athlete-form]').forEach((form) => {
      watchDirty(form);
      form.onsubmit = (e) => { e.preventDefault(); busy(form, async () => {
        const id = +form.dataset.athleteForm;
        const a = await api.put(`/parent/athletes/${id}`, formData(form));
        const i = state.me.athletes.findIndex((x) => x.id === id);
        if (i >= 0) state.me.athletes[i] = { ...state.me.athletes[i], ...a };
        toast(`${a.first_name}'s details saved.`);
        drawAthlete(id, true);
        draw('todo');
        ctx.el.querySelector(`[data-ath="${id}"] > summary`)?.focus({ preventScroll: true });
      }); };
    });

    const wf = $('#waiver-form');
    if (wf) wf.onsubmit = (e) => { e.preventDefault(); busy(wf, async () => {
      const d = formData(wf);
      const err = $('#waiver-err');
      if (!d.agree) { err.textContent = 'Tick the box to agree to the waiver.'; wf.elements.agree.focus(); return; }
      if (!/\S+\s+\S+/.test(d.name || '')) { err.textContent = 'Type your full name to sign.'; wf.elements.name.focus(); return; }
      await api.post('/parent/waiver', d);
      await refreshMe();
      toast('Waiver signed. Thank you.');
      draw('waiver', 'card', 'todo');
      focusTitle('#waiver-h');
    }); };

    const na = $('#new-athlete');
    if (na) na.onsubmit = (e) => { e.preventDefault(); busy(na, async () => {
      const d = formData(na);
      const err = na.querySelector('[data-err]');
      if (!String(d.first_name || '').trim() || !String(d.last_name || '').trim()) {
        err.textContent = 'Enter a first and last name.';
        na.elements[String(d.first_name || '').trim() ? 'last_name' : 'first_name'].focus();
        return;
      }
      const a = await api.post('/parent/athletes', d);
      await refreshMe();
      ctx.setAthlete(a.id);
      toast(`${a.first_name} added. Athlete ID ${a.code}.`);
      // Keep any athlete that's open (and anything typed in it); only add the new one above the form.
      const add = $('#add-athlete');
      const full = state.me.athletes.find((x) => x.id === a.id) || a;
      if (add && ctx.el.querySelector('[data-ath]')) {
        const tpl = document.createElement('template');
        mount(tpl, athleteDetails(full, state.me, false));
        add.before(tpl.content);
        na.reset(); add.open = false;
        bindForms();
      } else draw('athletes');
      draw('todo');
      ctx.el.querySelector(`[data-ath="${a.id}"] > summary`)?.focus();
    }); };

    const np = $('#new-parent');
    if (np) np.onsubmit = (e) => { e.preventDefault(); busy(np, async () => {
      const d = formData(np);
      const err = np.querySelector('[data-err]');
      if (!String(d.name || '').trim()) { err.textContent = 'Enter their name.'; np.elements.name.focus(); return; }
      if (!/^\S+@\S+\.\S+$/.test(String(d.email || '').trim())) { err.textContent = 'Enter their email address.'; np.elements.email.focus(); return; }
      const p = await api.post('/parent/parents', d);
      await refreshMe();
      toast(`${p.name} added. They can sign in with ${p.email}.`);
      draw('parents');
    }); };

    const mf = $('#me-form');
    if (mf) mf.onsubmit = (e) => { e.preventDefault(); busy(mf, async () => {
      await api.put('/parent/parents/me', formData(mf));
      await refreshMe();
      state.editMe = false;
      toast('Your details are saved.');
      draw('parents');
      $('[data-act="edit-me"]')?.focus();
    }); };
  }
  bindForms();

  // ---- buttons, handled in one place so redrawn sections keep working ----
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !ctx.el.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'goto') { focusTitle(`#${b.dataset.target}-h`); return; }
    if (act === 'open-athlete') {
      const d = ctx.el.querySelector(`[data-ath="${b.dataset.id}"]`);
      if (!d) return;
      d.open = true;
      d.scrollIntoView({ block: 'start', behavior: 'smooth' });
      d.querySelector(`[name="${b.dataset.field}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (act === 'copy-id') {
      const code = b.dataset.code;
      try { await navigator.clipboard.writeText(code); toast(`Athlete ID ${code} copied.`); }
      catch { toast(`Athlete ID: ${code}`); }
      return;
    }
    if (act === 'copy-contact') {
      const form = b.closest('form');
      form.elements.emergency_name.value = b.dataset.name;
      form.elements.emergency_phone.value = b.dataset.phone;
      form.markDirty?.();
      form.elements.emergency_phone.focus();
      return;
    }
    if (act === 'all-payments') { state.allPayments = true; draw('payments'); ctx.el.querySelectorAll('.fm-pay-row')[PAYMENTS_SHOWN]?.scrollIntoView({ block: 'nearest' }); return; }
    if (act === 'reload-account') { b.disabled = true; await refreshAccount(); draw('payments', 'card', 'todo', 'signin'); return; }
    if (act === 'edit-me') { state.editMe = true; draw('parents'); $('#me-name')?.focus(); return; }
    if (act === 'edit-me-cancel') { state.editMe = false; draw('parents'); $('[data-act="edit-me"]')?.focus(); return; }
    if (act === 'signout') { ctx.signOut(); return; }

    b.disabled = true;
    try {
      if (act === 'retry') {
        const r = await api.post(`/parent/payments/${b.dataset.id}/retry`, {});
        await Promise.all([refreshMe(), refreshAccount()]);
        if (r.paid) toast(`${money(r.amount_cents)} paid with the ${r.card_label}. Thank you.`);
        else toast(`The ${r.card_label} was declined again. Replace the card to pay it.`, 'warn');
        draw('card', 'payments', 'todo');
      } else if (act === 'remove-card') {
        const f = state.me.family;
        if (state.acct?.card_remove_block) {
          const v = await modal({ title: "The card can't be removed yet", body: html`<p style="margin:0">${state.acct.card_remove_block}</p>`, actions: [{ label: 'Close', value: null }, { label: 'Replace card', value: 'replace', kind: 'primary' }] });
          if (v === 'replace') ctx.go('/parent/card');
          return;
        }
        if (!(await confirmDialog('Remove the card?', `The ${f.card_label} comes off your account. Drop-ins, packs and camps need a card before they can be paid in the app.`, 'Remove card', 'warn'))) return;
        await api.del('/parent/card');
        await Promise.all([refreshMe(), refreshAccount()]);
        toast(`The ${f.card_label} was removed.`);
        draw('card', 'todo');
        focusTitle('#card-h');
      } else if (act === 'waiver-copy') {
        const r = await api.post('/parent/waiver/copy', {});
        toast(`A copy is on its way to ${r.email}.`);
      } else if (act === 'end-others') {
        const n = state.acct?.other_sessions || 0;
        if (!(await confirmDialog('Sign out everywhere else?', `You stay signed in here. ${plural(n, 'other phone or browser', 'other phones or browsers')} will need a new sign-in code.`, 'Sign out others'))) return;
        const r = await api.post('/parent/sessions/others/end', {});
        await refreshAccount();
        toast(r.ended ? `Signed out of ${plural(r.ended, 'other device')}.` : 'No other devices were signed in.');
        draw('signin');
      }
    } catch (x) { toastError(x); }
    finally { if (b.isConnected) b.disabled = false; }
  });

  // Remember which athletes are open, so redrawing the list keeps them open.
  ctx.el.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('[data-ath]')) return;
    const id = +d.dataset.ath;
    if (d.open) state.open.add(id); else state.open.delete(id);
  }, true);
}
