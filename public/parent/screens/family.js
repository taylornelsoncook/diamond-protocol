// Family: card on file, waiver, each athlete's details, parents on the account, sign out.
import { html, raw, mount, api, toast, toastError, formData, fmtDate } from '/js/ui.js';
import { header } from '../common.js';

const sel = (v, x) => (v === x ? raw('selected') : '');

function athleteFields(a = {}, prefix) {
  const id = (k) => `${prefix}-${k}`;
  const f = (k, label, attrs = '') => html`<div class="field"><label class="label" for="${id(k)}">${label}</label><input class="input" id="${id(k)}" name="${k}" value="${a[k] || ''}" ${raw(attrs)}></div>`;
  return html`<div class="form-grid">
    ${prefix === 'new' ? html`${f('first_name', 'First name', 'required autocomplete="off"')}${f('last_name', 'Last name', 'required autocomplete="off"')}` : ''}
    ${f('birthday', 'Birthday', 'type="date"')}
    <div class="field"><label class="label" for="${id('sex')}">Sex</label><select class="input" id="${id('sex')}" name="sex">
      <option value="" ${sel(a.sex || '', '')}>Not set</option><option value="F" ${sel(a.sex, 'F')}>Female</option><option value="M" ${sel(a.sex, 'M')}>Male</option></select>
      <span class="hint">Used for the growth-spurt estimate.</span></div>
    ${f('sport', 'Sport')}${f('position', 'Position')}${f('school', 'School')}
    ${f('allergies', 'Allergies')}${f('injuries', 'Injuries')}
    <div class="field span-2"><label class="label" for="${id('medical_notes')}">Medical notes</label><textarea class="input" id="${id('medical_notes')}" name="medical_notes" rows="3">${a.medical_notes || ''}</textarea>
      <span class="hint">Anything the coach should know: conditions, medication, recent injuries.</span></div>
    ${f('emergency_name', 'Emergency contact', 'autocomplete="off"')}${f('emergency_phone', 'Emergency phone', 'type="tel" autocomplete="off"')}
  </div>`;
}

export async function render(ctx) {
  const { me } = ctx;
  const fam = me.family;
  mount(ctx.el, html`${header('Family', ctx.familyName)}
    <section class="panel" id="card">
      <div><h2 class="panel-title">Card on file</h2><p class="panel-sub">Used for memberships, packs, camps and drop-ins for everyone in your family.</p></div>
      ${fam.card_last4 ? html`<p style="margin:0">${fam.card_label}${fam.card_exp ? html` <span class="muted">· expires ${fam.card_exp}</span>` : ''}</p>` : html`<p class="warn-text" style="margin:0">No card on file.</p>`}
      <div><a class="btn ${fam.card_last4 ? '' : 'btn-primary'}" href="/parent/card">${fam.card_last4 ? 'Replace card' : 'Add a card'}</a></div>
      <p class="small muted" style="margin:0">Cards are stored by Stripe. ${me.settings.business_name} never sees your full card number.</p>
    </section>

    <section class="panel" id="waiver">
      <div><h2 class="panel-title">Waiver</h2>
        <p class="panel-sub">${fam.waiver_current ? `Signed by ${fam.waiver_signed_by} on ${fmtDate(fam.waiver_signed_at)}` : fam.waiver_version ? 'The waiver has changed since you signed. Read and sign the new version.' : 'Not signed yet. Read it and sign below.'}</p></div>
      <div class="waiver-box" tabindex="0" aria-label="Waiver text">${me.settings.waiver_text || 'No waiver text yet.'}</div>
      ${fam.waiver_current ? '' : html`<form class="stack" id="waiver-form" novalidate>
        <label class="check"><input type="checkbox" name="agree"><span>I've read the waiver and agree to it for everyone in my family.</span></label>
        <div class="field"><label class="label" for="sig">Type your full name to sign</label><input class="input" id="sig" name="name" autocomplete="name" value="" placeholder="${me.parent.name}"></div>
        <div class="error" role="alert" id="waiver-err"></div>
        <div><button class="btn btn-primary">Sign waiver</button></div>
      </form>`}
    </section>

    <h2 class="sec-label">Athletes</h2>
    ${me.athletes.map((a) => html`<details class="panel panel-tight">
      <summary>${a.first_name} ${a.last_name}<span class="muted small" style="font-weight:400;margin-left:auto">${a.code}</span></summary>
      <form class="stack" data-athlete-form="${a.id}" novalidate>
        ${athleteFields(a, `a${a.id}`)}
        <div class="btn-row"><button class="btn btn-primary">Save ${a.first_name}'s details</button></div>
      </form></details>`)}
    <details class="panel panel-tight" id="add-athlete">
      <summary>Add another athlete</summary>
      <form class="stack" id="new-athlete" novalidate>
        ${athleteFields({}, 'new')}
        <p class="small muted" style="margin:0">They get their own Athlete ID and workouts. Sessions and packs are per athlete; the card pays for everyone.</p>
        <div class="btn-row"><button class="btn btn-primary">Add athlete</button></div>
      </form>
    </details>

    <section class="panel" id="parents">
      <h2 class="panel-title">Parents</h2>
      <div class="list">${me.parents.map((p) => html`<div class="list-row"><div class="grow"><div>${p.name}${p.id === me.parent.id ? html` <span class="muted small">(you)</span>` : ''}</div><div class="small muted">${p.email}${p.phone ? ` · ${p.phone}` : ''}</div></div></div>`)}</div>
      <details><summary class="btn btn-sm" style="list-style:none;display:inline-flex">Add a parent</summary>
        <form class="stack" id="new-parent" style="margin-top:12px" novalidate>
          <div class="form-grid">
            <div class="field"><label class="label" for="np-name">Name</label><input class="input" id="np-name" name="name" autocomplete="off"></div>
            <div class="field"><label class="label" for="np-email">Email</label><input class="input" id="np-email" name="email" type="email" autocapitalize="off" autocomplete="off"></div>
            <div class="field"><label class="label" for="np-phone">Phone</label><input class="input" id="np-phone" name="phone" type="tel" autocomplete="off"></div>
          </div>
          <p class="small muted" style="margin:0">They sign in at this portal with their own email and can book, pay and see progress.</p>
          <div><button class="btn btn-primary">Add parent</button></div>
        </form></details>
    </section>

    <button class="btn btn-ghost btn-lg" id="signout">Sign out</button>`);

  const busy = async (form, fn) => { const b = form.querySelector('button:not([type=button])'); b.disabled = true; try { await fn(); } catch (e) { toastError(e); } finally { b.disabled = false; } };

  const wf = document.getElementById('waiver-form');
  if (wf) wf.onsubmit = (e) => { e.preventDefault(); busy(wf, async () => {
    const d = formData(wf);
    const err = document.getElementById('waiver-err');
    if (!d.agree) { err.textContent = 'Tick the box to agree to the waiver.'; return; }
    if (!/\S+\s+\S+/.test(d.name || '')) { err.textContent = 'Type your full name to sign.'; return; }
    await api.post('/parent/waiver', d);
    toast('Waiver signed. Thank you.');
    ctx.reload();
  }); };

  ctx.el.querySelectorAll('[data-athlete-form]').forEach((form) => { form.onsubmit = (e) => { e.preventDefault(); busy(form, async () => {
    const a = await api.put(`/parent/athletes/${form.dataset.athleteForm}`, formData(form));
    toast(`${a.first_name}'s details saved.`);
    ctx.reload();
  }); }; });

  const na = document.getElementById('new-athlete');
  na.onsubmit = (e) => { e.preventDefault(); busy(na, async () => {
    const a = await api.post('/parent/athletes', formData(na));
    ctx.setAthlete(a.id);
    toast(`${a.first_name} added. Athlete ID ${a.code}.`);
    ctx.reload();
  }); };

  const np = document.getElementById('new-parent');
  np.onsubmit = (e) => { e.preventDefault(); busy(np, async () => {
    const p = await api.post('/parent/parents', formData(np));
    toast(`${p.name} added. They can sign in with ${p.email}.`);
    ctx.reload();
  }); };

  document.getElementById('signout').onclick = () => ctx.signOut();
}
