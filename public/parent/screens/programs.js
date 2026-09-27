// Programs: the athlete's membership, camps and clinics, standing weekly spots, session packs and plans.
// Payments go on the family card; a missing or declined card offers Add a card / Update card and comes back here.
// Families ask to switch plans, pause or cancel (the owners are emailed); they can't change a membership themselves.
import { html, raw, mount, api, toast, toastError, modal, money, badge, fmtDate } from '/js/ui.js';
import { header, athletePills, bindAthletePills, dayShort, dayLong, clock, clockHM, weekdays } from '../common.js';
import { cardState } from './home.js';

const STATUS = { active: 'Active', trial: 'Trial', past_due: 'Past due', paused: 'Paused' };
const REQ = { change: 'switch plans', pause: 'pause the membership', cancel: 'cancel the membership' };
const NOTE_MAX = 500;
const cardBack = () => `/parent/card?back=${encodeURIComponent('/parent/programs')}`;

function dateRange(a, b) { return a && b && a !== b ? `${dayShort(a)}–${dayShort(b)}` : a ? dayShort(a) : ''; }
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysUntil = (day) => Math.round((new Date(day + 'T12:00:00') - new Date(ymd(new Date()) + 'T12:00:00')) / 864e5);
const sessionsWord = (kind, n) => `${n} ${kind === 'private_pack' ? (n === 1 ? 'private session' : 'private sessions') : (n === 1 ? 'group session' : 'group sessions')}`;
export const planLine = (p) => `${money(p.price_cents)} a month${p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}${p.group_per_month == null ? ' · unlimited group classes' : ` · ${p.group_per_month} group classes`}${p.private_per_month ? ` · ${p.private_per_month} ${p.private_per_month === 1 ? 'private' : 'privates'}` : ''}`;

// What a pack costs a session, and what it saves against singles (a 1-session pack of the same kind, or the drop-in).
export function packValue(p, packs, dropIn) {
  const per = Math.round(p.price_cents / Math.max(1, p.credits));
  const single = p.credits > 1 ? (packs.find((x) => x.kind === p.kind && x.credits === 1)?.price_cents ?? (p.kind === 'group_pack' ? dropIn : null)) : null;
  const save = single ? single * p.credits - p.price_cents : 0;
  return { per, save: save > 0 ? save : 0 };
}

export async function render(ctx) {
  const a = ctx.athlete;
  if (!a) { mount(ctx.el, html`${header('Programs', ctx.familyName)}<div class="empty">Add an athlete on the Family tab first.</div>`); return; }
  const d = await api.get(`/parent/shop?athlete_id=${a.id}`);
  if (!ctx.isCurrent()) return;
  const ath = d.athlete;
  const m = d.membership;
  const cs = d.card_label ? cardState(d.card_exp) : null;
  const capped = m && m.group_per_month != null;

  const cardLine = !d.card_label
    ? html`<div class="banner"><span>Add a card to register, buy packs or start a membership. It pays for every athlete in the family.</span><a class="btn btn-warn btn-sm" href="${cardBack()}">Add a card</a></div>`
    : cs === 'expired' ? html`<div class="banner"><span>The ${d.card_label} has expired. Update it before you buy anything.</span><a class="btn btn-warn btn-sm" href="${cardBack()}">Update card</a></div>`
    : html`<p class="pg-card small muted">Payments go on the ${d.card_label}${cs === 'soon' ? html`, which <span class="warn-text">expires ${d.card_exp}</span>` : ''}. <a href="${cardBack()}">Change card</a></p>`;

  const memberPanel = m ? html`<section class="panel" id="membership" aria-labelledby="pg-m-h">
      <div class="spread pg-m-head"><div><h2 class="panel-title" id="pg-m-h">${ath.first_name}'s membership</h2><p class="panel-sub">${m.plan_name}</p></div>${badge(m.status, STATUS[m.status])}</div>
      ${m.status === 'past_due' ? html`<div class="banner"><span>The last payment didn't go through, so membership classes are on hold. Update the card and the payment is tried again.</span><a class="btn btn-warn btn-sm" href="${cardBack()}">Update card</a></div>` : ''}
      <dl class="s-detail">
        ${m.status === 'trial' && m.next_charge ? html`<dt>Trial ends</dt><dd>${dayLong(m.next_charge)}. Then ${money(m.price_cents)} a month on the card on file.</dd>`
          : m.status === 'active' && m.next_charge ? html`<dt>Next charge</dt><dd>${money(m.price_cents)} on ${dayLong(m.next_charge)}</dd>` : ''}
        <dt>Group classes</dt><dd>${m.group_per_month == null ? 'Unlimited' : ['active', 'trial'].includes(m.status) ? `${m.member_left} of ${m.group_per_month} left this month` : `${m.group_per_month} a month`}</dd>
        ${m.private_per_month ? html`<dt>Privates</dt><dd>${m.private_per_month} a month, added when it renews</dd>` : ''}
      </dl>
      ${d.request ? html`<p class="pg-req small" role="status">You asked to ${d.request.kind === 'change' && d.request.plan_name ? `switch to ${d.request.plan_name}` : REQ[d.request.kind]} on ${fmtDate(d.request.created_at, { year: false })}. The front desk will reply by email.</p>` : ''}
      <div><button type="button" class="btn" id="pg-ask">${m.status === 'paused' ? 'Ask to switch or cancel' : 'Ask to change, pause or cancel'}</button></div>
    </section>` : '';

  mount(ctx.el, html`${header('Programs', ctx.familyName)}
    ${athletePills(ctx)}
    ${cardLine}
    ${memberPanel}

    <section class="panel" id="camps" aria-labelledby="pg-c-h">
      <div><h2 class="panel-title" id="pg-c-h">Camps & clinics</h2><p class="panel-sub">One registration covers every day.</p></div>
      ${d.camps.length ? html`<div>${d.camps.map((c) => {
        const soon = !c.registered && c.reg_deadline ? daysUntil(c.reg_deadline) : null;
        const full = c.spots_left === 0 && !c.registered;
        return html`<div class="offer stackable" id="camp-${c.id}">
        <div class="grow"><div class="offer-name">${c.name}</div>
          <div class="offer-meta">${[dateRange(c.start_date, c.end_date), weekdays(c.weekdays), clockHM(c.start_time), `${c.duration_min} min`, c.ages, c.location].filter(Boolean).join(' · ')}</div>
          <div class="offer-meta">${c.days} ${c.days === 1 ? 'day' : 'days'}${c.reg_deadline && !c.registered ? html` · <span class="${soon != null && soon <= 3 ? 'warn-text' : ''}">${soon === 0 ? 'Registration closes today' : `Register by ${dayShort(c.reg_deadline)}`}</span>` : ''}${c.spots_left != null && !c.registered && !full ? html` · <span class="${c.spots_left <= 3 ? 'warn-text' : ''}">${c.spots_left} ${c.spots_left === 1 ? 'spot' : 'spots'} left</span>` : ''}</div>
          ${c.siblings?.length ? html`<div class="offer-meta">${c.siblings.join(' and ')} ${c.siblings.length === 1 ? 'is' : 'are'} registered.</div>` : ''}</div>
        ${c.registered ? html`<span class="pg-state">${badge('registered')}<a class="small" href="/parent">See the days on Home</a></span>`
          : !c.eligible ? html`<span class="muted small">Not for ${ath.first_name}'s age</span>`
          : full ? html`<span class="muted small pg-note">Full. Ask the front desk about a spot.</span>`
          : c.days ? html`<button class="btn btn-primary" data-camp="${c.id}">Register · ${money(c.reg_price_cents)}</button>` : html`<span class="muted small">Full schedule not out yet</span>`}
      </div>`;
      })}</div>` : html`<p class="muted" style="margin:0">No camps or clinics open for registration right now. New ones show here first.</p>`}
    </section>

    <section class="panel" id="standing" aria-labelledby="pg-s-h">
      <div><h2 class="panel-title" id="pg-s-h">Weekly group classes</h2><p class="panel-sub">Hold a standing spot and ${ath.first_name} is booked every week.</p></div>
      ${!d.is_member ? html`<p class="small muted" style="margin:0">Standing spots are for members.${m ? '' : ' Start a membership below to hold one.'}</p>` : ''}
      ${d.classes.length ? html`<div>${d.classes.map((c) => html`<div class="offer">
        <div class="grow"><div class="offer-name">${c.name}</div>
          <div class="offer-meta">${[weekdays(c.weekdays), clockHM(c.start_time), `${c.duration_min} min`, c.location, c.ages].filter(Boolean).join(' · ')}</div>
          ${c.standing_id ? html`<div class="offer-meta"><span class="good-text">Spot held.</span> ${c.my_next_at ? `Next ${dayShort(c.my_next_at)}, ${clock(c.my_next_at)}. ${c.my_upcoming} upcoming ${c.my_upcoming === 1 ? 'session' : 'sessions'} booked.` : 'No upcoming sessions booked yet.'}</div>`
            : c.next_at ? html`<div class="offer-meta">Next ${dayShort(c.next_at)}, ${clock(c.next_at)}</div>` : ''}</div>
        ${c.standing_id ? html`<button class="btn btn-ghost" data-leave="${c.standing_id}" data-name="${c.name}">Leave</button>`
          : html`<button class="btn" data-hold="${c.id}">Hold a spot</button>`}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No weekly classes for ${ath.first_name}'s age.</p>`}
    </section>

    <section class="panel" id="packs" aria-labelledby="pg-p-h">
      <div><h2 class="panel-title" id="pg-p-h">${m ? 'Packs and plans' : 'Memberships and packs'}</h2><p class="panel-sub">For ${ath.first_name}, who has ${ath.group_credits} group and ${ath.private_credits} private ${ath.private_credits === 1 ? 'session' : 'sessions'} left.</p></div>
      <div>
        ${d.plans.map((p) => html`<div class="offer">
          <div class="grow"><div class="offer-name">${p.name}</div><div class="offer-meta">${planLine(p)}</div></div>
          ${m ? (m.plan_id === p.id ? badge('active', 'Current') : html`<button class="btn btn-ghost" data-switch="${p.id}">Ask to switch</button>`) : html`<button class="btn" data-plan="${p.id}">${p.trial_days ? 'Start free trial' : `Start · ${money(p.price_cents)}`}</button>`}
        </div>`)}
        ${d.packs.map((p) => {
          const v = packValue(p, d.packs, d.drop_in_cents);
          return html`<div class="offer">
          <div class="grow"><div class="offer-name">${p.name}</div><div class="offer-meta">${sessionsWord(p.kind, p.credits)}${p.credits > 1 ? ` · ${money(v.per)} a session` : ''}${v.save ? html` · <span class="good-text">saves ${money(v.save)}</span>` : ''}</div></div>
          <button class="btn" data-pack="${p.id}">Buy · ${money(p.price_cents)}</button>
        </div>`;
        })}
      </div>
      <p class="small muted" style="margin:0">Pack sessions don't expire. Group pack sessions are used only after the membership's classes run out.</p>
    </section>`);
  bindAthletePills(ctx);

  // Redraw after a change, back at the section that changed.
  const back = (section) => ctx.go(`/parent/programs#${section}`, { replace: true });
  const noCard = async () => {
    const r = await modal({ title: 'Add a card first', body: html`<p style="margin:0">Payments go on the card on file. It takes a minute, and you come straight back here.</p>`, actions: [{ label: 'Not now', value: null }, { label: 'Add a card', value: true, kind: 'primary' }] });
    if (r) ctx.go(cardBack());
  };
  // A missing or declined card, with a way to fix it; anything else is a toast.
  async function paymentError(err, what) {
    if (err?.data?.needs_card) return noCard();
    if (err?.status === 400 && /declined/i.test(err.message || '')) {
      const msg = err.message.replace(/\s*(Try another card|Update it) on the Family tab\.?$/, '');
      const r = await modal({ title: 'The card didn’t go through', body: html`<p style="margin:0">${msg}${what ? ` ${what}` : ''}</p>`, actions: [{ label: 'Close', value: null }, { label: 'Update card', value: true, kind: 'primary' }] });
      if (r) ctx.go(cardBack());
      return;
    }
    toastError(err);
  }
  const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toastError(e); } finally { btn.disabled = false; } };
  const needsCard = () => { if (!d.card_label) { noCard(); return true; } return false; };

  ctx.el.querySelectorAll('[data-camp]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const c = d.camps.find((x) => x.id === +btn.dataset.camp);
    if (needsCard()) return;
    const ok = await modal({ title: `Register for ${c.name}`, body: html`<p style="margin:0">${ath.first_name} is booked into all ${c.days} ${c.days === 1 ? 'day' : 'days'}: ${dateRange(c.start_date, c.end_date)}, ${weekdays(c.weekdays)} at ${clockHM(c.start_time)}${c.location ? `, ${c.location}` : ''}.</p>
      <p class="muted" style="margin:0">${money(c.reg_price_cents)} is charged to the ${d.card_label} now.</p>`, actions: [{ label: 'Cancel', value: false }, { label: `Pay ${money(c.reg_price_cents)}`, value: true, kind: 'primary' }] });
    if (!ok) return;
    try {
      const r = await api.post(`/parent/camps/${c.id}/register`, { athlete_id: a.id });
      toast(`${ath.first_name} is registered. ${r.days} ${r.days === 1 ? 'day' : 'days'} booked.`);
      back('camps');
    } catch (e) {
      if (e?.data?.full) { toastError(e); back('camps'); return; }
      await paymentError(e, 'Nothing was booked or charged.');
    }
  }); });

  ctx.el.querySelectorAll('[data-hold]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const c = d.classes.find((x) => x.id === +btn.dataset.hold);
    if (!d.is_member) {
      const pastDue = m?.status === 'past_due';
      const r = await modal({ title: 'Standing spots are for members', body: html`<p style="margin:0">${m ? `${ath.first_name}'s membership is ${(STATUS[m.status] || m.status).toLowerCase()}, so a weekly spot can't be held right now. ${pastDue ? 'Update the card and try again.' : 'Ask the front desk to start it again.'}` : `A membership books ${ath.first_name} into ${c.name} every week, with no sessions to buy one at a time. Or book single classes on the Book tab.`}</p>`,
        actions: [{ label: 'Close', value: null }, ...(!m ? [{ label: 'See memberships', value: 'plans', kind: 'primary' }] : pastDue ? [{ label: 'Update card', value: 'card', kind: 'primary' }] : [])] });
      if (r === 'card') ctx.go(cardBack());
      if (r === 'plans') document.getElementById('packs')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (c.eligible === false) { toast(`${c.name} isn't for ${ath.first_name}'s age.`, 'warn'); return; }
    const ok = await modal({ title: `Hold a spot in ${c.name}`, body: html`<p style="margin:0">${ath.first_name} is booked into every ${c.name} session (${weekdays(c.weekdays)}, ${clockHM(c.start_time)}) while the membership lasts.</p>
      <p class="muted" style="margin:0">${capped ? `Each session uses one of the ${m.group_per_month} group classes in its month; once they're used, the rest of that month is skipped. Pack sessions are never used.` : 'Covered by the membership. Full sessions are skipped.'} Cancel a single session on Home, or leave the spot any time.</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Hold spot', value: true, kind: 'primary' }] });
    if (!ok) return;
    const r = await api.post('/parent/standing', { athlete_id: a.id, class_id: c.id });
    toast(`Spot held in ${c.name}. ${r.booked} upcoming ${r.booked === 1 ? 'session' : 'sessions'} booked${r.skipped ? `; ${r.skipped} skipped (full, or no classes left that month)` : ''}.`);
    back('standing');
  }); });

  ctx.el.querySelectorAll('[data-leave]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const ok = await modal({ title: 'Leave standing spot', body: html`<p style="margin:0">Give up ${ath.first_name}'s weekly spot in ${btn.dataset.name}? Upcoming sessions are cancelled, except any inside the late-cancel window.</p>`,
      actions: [{ label: 'Keep it', value: false }, { label: 'Leave', value: true, kind: 'primary' }] });
    if (!ok) return;
    const r = await api.del(`/parent/standing/${btn.dataset.leave}`);
    toast(`Spot released. ${r.cancelled} ${r.cancelled === 1 ? 'session' : 'sessions'} cancelled${r.kept ? `, ${r.kept} kept` : ''}.`);
    back('standing');
  }); });

  ctx.el.querySelectorAll('[data-pack]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const p = d.packs.find((x) => x.id === +btn.dataset.pack);
    if (needsCard()) return;
    const ok = await modal({ title: 'Buy a pack', body: html`<p style="margin:0">${p.name} for ${ath.first_name}: ${sessionsWord(p.kind, p.credits)}.</p><p class="muted" style="margin:0">${money(p.price_cents)} is charged to the ${d.card_label} now.</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: `Pay ${money(p.price_cents)}`, value: true, kind: 'primary' }] });
    if (!ok) return;
    try {
      await api.post('/parent/packs', { athlete_id: a.id, product_id: p.id });
      toast(`${p.name} added. ${ath.first_name} can book now.`);
      back('packs');
    } catch (e) { await paymentError(e, 'Nothing was added or charged.'); }
  }); });

  ctx.el.querySelectorAll('[data-plan]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const p = d.plans.find((x) => x.id === +btn.dataset.plan);
    if (needsCard()) return;
    const ok = await modal({ title: 'Start membership', body: html`<p style="margin:0">${p.name} for ${ath.first_name}: ${planLine(p)}.</p>
      <p class="muted" style="margin:0">${p.trial_days ? `Nothing is charged today. After ${p.trial_days} days, ${money(p.price_cents)} is charged to the ${d.card_label} every month.` : `${money(p.price_cents)} is charged to the ${d.card_label} today and every month.`} To pause or cancel, ask here any time.</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: p.trial_days ? 'Start free trial' : `Pay ${money(p.price_cents)}`, value: true, kind: 'primary' }] });
    if (!ok) return;
    try {
      const r = await api.post('/parent/membership', { athlete_id: a.id, plan_id: p.id });
      toast(r.trial ? `Trial started. ${ath.first_name} can book group classes now.` : `Membership started. ${ath.first_name} can book group classes now.`);
      back('membership');
    } catch (e) {
      // A declined first payment leaves the membership on hold (past due), so redraw to show it.
      if (e?.data?.membership_id) back('membership');
      await paymentError(e, '');
    }
  }); });

  // Ask to switch plans, pause or cancel.
  const ask = async (preset = {}) => {
    const others = d.plans.filter((p) => p.id !== m.plan_id);
    const paused = m.status === 'paused'; // already paused: switch or cancel
    const first = preset.kind || (others.length ? 'change' : paused ? 'cancel' : 'pause');
    const r = await modal({
      title: 'Ask to change the membership',
      body: html`<form class="stack" id="rq" novalidate>
        <p style="margin:0">The front desk makes the change and replies by email. Nothing changes until they do.</p>
        <fieldset class="pg-kinds"><legend class="label">What would you like?</legend>
          ${others.length ? html`<label class="check"><input type="radio" name="kind" value="change" ${first === 'change' ? raw('checked') : ''}> Switch to another plan</label>` : ''}
          ${paused ? '' : html`<label class="check"><input type="radio" name="kind" value="pause" ${first === 'pause' ? raw('checked') : ''}> Pause for a while</label>`}
          <label class="check"><input type="radio" name="kind" value="cancel" ${first === 'cancel' ? raw('checked') : ''}> Cancel the membership</label>
        </fieldset>
        ${others.length ? html`<div class="field" id="rq-plan-f"><label class="label" for="rq-plan">New plan</label><select class="input" id="rq-plan" name="plan_id">${others.map((p) => html`<option value="${p.id}" ${p.id === preset.plan_id ? raw('selected') : ''}>${p.name}, ${money(p.price_cents)} a month</option>`)}</select></div>` : ''}
        <div class="field"><label class="label" for="rq-note">Note <span class="muted">(optional)</span></label>
          <textarea class="input" id="rq-note" name="note" maxlength="${NOTE_MAX}" rows="3" placeholder="Like: pausing for the school play, back in January"></textarea>
          <p class="hint" style="margin:0" id="rq-left" aria-live="polite"></p></div>
      </form>`,
      onMount: (body) => {
        const f = body.querySelector('#rq');
        const sync = () => { const pf = body.querySelector('#rq-plan-f'); if (pf) pf.hidden = f.kind.value !== 'change'; };
        f.addEventListener('change', sync); sync();
        const left = body.querySelector('#rq-left');
        f.note.addEventListener('input', () => { const n = NOTE_MAX - f.note.value.length; left.textContent = n < 100 ? `${n} characters left` : ''; });
        f.addEventListener('submit', (e) => e.preventDefault());
      },
      actions: [{ label: 'Not now', value: null }, { label: 'Send request', kind: 'primary', onClick: async (body) => {
        const f = body.querySelector('#rq');
        const kind = f.kind.value;
        return api.post('/parent/membership/request', { athlete_id: a.id, kind, plan_id: kind === 'change' ? Number(f.plan_id?.value) : null, note: f.note.value });
      } }],
    });
    if (r) { toast('Request sent. The front desk will reply by email.'); back('membership'); }
  };
  const askBtn = ctx.el.querySelector('#pg-ask');
  if (askBtn) askBtn.onclick = () => ask();
  ctx.el.querySelectorAll('[data-switch]').forEach((btn) => { btn.onclick = () => ask({ kind: 'change', plan_id: +btn.dataset.switch }); });
}
