// Book: classes three weeks ahead, or an open time for a private or an evaluation.
// Switching athlete, kind, class or coach redraws in place; after a booking or cancel the list refreshes where you are.
import { html, raw, mount, api, toast, toastError, modal, money, badge, plural } from '/js/ui.js';
import { header, athletePills, groupByDay, dayLong, dayShort, weekday, clock } from '../common.js';

const KINDS = [['classes', 'Classes'], ['private', 'Private'], ['evaluation', 'Evaluation']];
const FILTER_KEY = 'dp_book_class';
const DAYS_SHOWN = 6; // days of open times shown before "Show later dates"
const NOTE_MAX = 500;
const svg = (d, size = 18) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true"><path d="${d}"/></svg>`);
const CAL_ADD = 'M3 4h14v13H3zM3 8h14M7 2v4M13 2v4M10 10v5M7.5 12.5h5';

// ---- small helpers ----
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function dayTitle(day) {
  const t = new Date(); const tm = new Date(); tm.setDate(tm.getDate() + 1);
  return day === ymd(t) ? `Today · ${dayLong(day)}` : day === ymd(tm) ? `Tomorrow · ${dayLong(day)}` : dayLong(day);
}
function endClock(s, min) { const d = new Date(s + ':00'); d.setMinutes(d.getMinutes() + (min || 60)); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
function dayWord(s) {
  const t = new Date(); const tm = new Date(); tm.setDate(tm.getDate() + 1);
  const d = s.slice(0, 10);
  return d === ymd(t) ? 'Today' : d === ymd(tm) ? 'Tomorrow' : `${weekday(s)} ${dayShort(s)}`;
}
const timeRange = (s, min) => `${clock(s)} to ${endClock(s, min)}`;
const when = (s) => `${dayLong(s)} at ${clock(s)}`;
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const clashWhat = (c) => `${c.status === 'waitlist' ? 'on the waitlist' : 'booked'} for ${c.name}`;
const cardBack = (path) => `/parent/card?back=${encodeURIComponent(path)}`;
function mapLink(location, address) {
  const q = encodeURIComponent([location, address].filter(Boolean).join(', '));
  if (!q) return null;
  return /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent) ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}
function readFilter() { try { return sessionStorage.getItem(FILTER_KEY) || ''; } catch { return ''; } }
function saveFilter(v) { try { if (v) sessionStorage.setItem(FILTER_KEY, v); else sessionStorage.removeItem(FILTER_KEY); } catch { /* storage blocked */ } }
function paidText(coverage, paidCents) {
  switch (coverage) {
    case 'member': return 'Covered by the membership.';
    case 'credit': return 'Uses a session from a pack.';
    case 'paid': return paidCents ? `${money(paidCents)} paid with the card on file.` : 'Drop-in.';
    case 'registered': return 'Part of the camp registration.';
    case 'team': return 'Covered by the team.';
    case 'unpaid': return 'Not paid yet. Pay at the front desk.';
    default: return '';
  }
}

export async function render(ctx) {
  const list = ctx.me.athletes;
  if (!ctx.athlete) { mount(ctx.el, html`${header('Book', ctx.familyName)}<div class="empty">No athletes on this account yet. <a href="/parent/family#add-athlete">Add an athlete</a></div>`); return; }
  let athlete = ctx.athlete;
  let kind = KINDS.some(([k]) => k === ctx.query.kind) ? ctx.query.kind : 'classes';
  let coach = ''; // private/evaluation coach filter, '' = any
  let seq = 0;

  mount(ctx.el, html`${header('Book', ctx.familyName)}
    ${athletePills(ctx)}
    <div class="pills" role="group" aria-label="What to book">${KINDS.map(([k, label]) => html`<button type="button" class="pill" data-kind="${k}" aria-pressed="${String(k === kind)}">${label}</button>`)}</div>
    <div class="stack bk-body" id="bk-body"></div>`);
  const body = ctx.el.querySelector('#bk-body');
  const here = () => `/parent/book${kind === 'classes' ? '' : '?kind=' + kind}`;
  const live = () => ctx.isCurrent() && body.isConnected;

  // A missing or declined card, with a way to fix it and come straight back; anything else is left to the caller.
  async function paymentError(err) {
    if (err?.data?.needs_card) {
      const r = await modal({ title: 'Add a card first', body: html`<p style="margin:0">${err.message}</p>`, actions: [{ label: 'Not now', value: null }, { label: 'Add a card', value: true, kind: 'primary' }] });
      if (r) ctx.go(cardBack(here()));
      return true;
    }
    if (err?.status === 400 && /declined/i.test(err.message || '')) {
      const r = await modal({ title: 'The card didn’t go through', body: html`<p style="margin:0">${err.message.replace(/\s*Try another card on the Family tab\.?$/, '')} Nothing was booked or charged. Update the card, then book again.</p>`, actions: [{ label: 'Close', value: null }, { label: 'Update card', value: true, kind: 'primary' }] });
      if (r) ctx.go(cardBack(here()));
      return true;
    }
    return false;
  }

  function press(attr, val) { ctx.el.querySelectorAll(`[${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === String(val)))); }
  ctx.el.querySelectorAll('[data-athlete]').forEach((b) => { b.onclick = () => {
    const a = list.find((x) => x.id === +b.dataset.athlete);
    if (!a || a.id === athlete.id) return;
    athlete = a; ctx.setAthlete(a.id); press('data-athlete', a.id);
    history.replaceState({}, '', here());
    load({ fresh: true });
  }; });
  ctx.el.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => {
    if (b.dataset.kind === kind) return;
    kind = b.dataset.kind; coach = ''; press('data-kind', kind);
    history.replaceState({}, '', here());
    load({ fresh: true });
  }; });

  // fresh: show a loading line (switching); otherwise keep what's on screen until the new data is in (after an action).
  async function load({ fresh = false } = {}) {
    const my = ++seq;
    if (fresh) mount(body, html`<div class="muted" aria-busy="true" style="padding:12px 0">Loading…</div>`);
    let data;
    try {
      data = kind === 'classes' ? await api.get(`/parent/classes?athlete_id=${athlete.id}`) : await api.get(`/parent/slots?kind=${kind}&athlete_id=${athlete.id}`);
    } catch (e) {
      if (my !== seq || !live() || e.status === 401) return;
      mount(body, html`<div class="banner"><span>${e.message || 'Could not load times.'}</span><button type="button" class="btn btn-warn btn-sm" id="bk-retry">Try again</button></div>`);
      body.querySelector('#bk-retry').onclick = () => load({ fresh: true });
      return;
    }
    if (my !== seq || !live()) return;
    if (kind === 'classes') paintClasses(data); else paintSlots(data);
  }
  const refresh = () => load();

  // ---------------- classes ----------------
  function coverageLine(a) {
    if (a.member_left === 'unlimited') return `${a.first_name}'s membership covers every group class.`;
    const n = (Number(a.member_left) || 0) + (a.group_credits || 0);
    if (n > 0) return `${a.first_name} has ${n} group ${n === 1 ? 'session' : 'sessions'} left${a.member_left > 0 && !a.group_credits ? ' this month' : ''}.`;
    return null;
  }
  function payLine(ath, e, cardLabel) {
    if (e.my_status === 'booked') return paidText(e.my_coverage, e.my_paid_cents);
    if (e.my_status === 'waitlist') return 'Nothing is charged unless a spot opens.';
    if (e.needs_registration) return `One registration covers every day: ${money(e.reg_price_cents)}${e.reg_days ? ` for ${plural(e.reg_days, 'day')}` : ''}.`;
    if (!e.price_cents) return 'Free.';
    if (ath.member_left === 'unlimited') return 'Covered by the membership.';
    if (e.covered) return Number(ath.member_left) > 0 ? 'Covered by the membership.' : `Uses 1 of ${ath.first_name}'s ${ath.group_credits} pack ${ath.group_credits === 1 ? 'session' : 'sessions'}.`;
    return cardLabel ? `Drop-in ${money(e.price_cents)}, charged to the ${cardLabel}.` : `Drop-in ${money(e.price_cents)}. Add a card to pay it.`;
  }

  function paintClasses(data) {
    const ath = data.athlete;
    const names = [...new Set(data.events.map((e) => e.name))].sort();
    let filter = readFilter();
    if (filter && !names.includes(filter)) filter = '';
    // A camp you haven't registered for shows once (its first day) with Register, not once a day.
    const seenCamp = new Set();
    const shown = data.events.filter((e) => {
      if (filter && e.name !== filter) return false;
      if (e.needs_registration) { if (seenCamp.has(e.class_id)) return false; seenCamp.add(e.class_id); }
      return true;
    });
    const days = groupByDay(shown);
    const line = coverageLine(ath);
    mount(body, html`
      ${data.waiver_current ? '' : html`<div class="banner"><span>Sign the waiver before ${ath.first_name}'s first session.</span><a class="btn btn-warn btn-sm" href="/parent/family#waiver">Sign waiver</a></div>`}
      ${line ? html`<p class="muted" style="margin:0">${line}</p>` : html`<div class="banner"><span>${ath.first_name} has no group sessions left. Pay the drop-in price with the card on file, or buy a pack.</span><a class="btn btn-warn btn-sm" href="/parent/programs?athlete=${ath.id}#packs">Buy a pack</a></div>`}
      ${names.length > 1 ? html`<div class="bk-filter"><label class="label" for="bk-class">Show</label>
        <select class="input" id="bk-class"><option value="">All classes and camps</option>${names.map((n) => html`<option value="${n}" ${n === filter ? raw('selected') : ''}>${n}</option>`)}</select>
        <span class="muted bk-count" aria-live="polite">${plural(shown.length, 'session')}</span></div>` : ''}
      ${days.length ? html`<section class="panel panel-tight" style="gap:0" aria-label="Classes">${days.map((d) => html`
        <h2 class="day-h">${dayTitle(d.day)}</h2>
        ${d.items.map((e) => classRow(e, ath))}`)}</section>`
        : html`<div class="empty">${filter ? html`No ${filter} sessions in the next three weeks. <button type="button" class="btn btn-ghost btn-sm" id="bk-all">Show all classes</button>` : `No classes for ${ath.first_name}'s age in the next three weeks. Ask your coach about privates or camps.`}</div>`}`);

    const sel = body.querySelector('#bk-class');
    if (sel) sel.onchange = () => { saveFilter(sel.value); paintClasses(data); body.querySelector('#bk-class')?.focus(); };
    const all = body.querySelector('#bk-all');
    if (all) all.onclick = () => { saveFilter(''); paintClasses(data); };
    const byId = (id) => data.events.find((x) => x.id === +id);
    body.querySelectorAll('[data-book]').forEach((b) => { b.onclick = () => bookClass(byId(b.dataset.book), data, b); });
    body.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => cancelClass(byId(b.dataset.cancel), data); });
    body.querySelectorAll('[data-register]').forEach((b) => { b.onclick = () => registerCamp(byId(b.dataset.register), data); });
    body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => classDetails(byId(b.dataset.open), data); });
  }

  function classRow(e, ath) {
    const spots = e.full ? `Full${e.waitlisted ? `, ${e.waitlisted} waiting` : ''}` : e.spots_left != null ? `${e.spots_left} ${e.spots_left === 1 ? 'spot' : 'spots'} left` : null;
    const meta = e.needs_registration
      ? [e.reg_days ? `${plural(e.reg_days, 'day')} from ${dayShort(e.starts_at)}` : null, money(e.reg_price_cents), e.location].filter(Boolean).join(' · ')
      : [e.location, e.coach, e.my_status ? null : spots, !e.covered && !e.my_status && e.price_cents ? `Drop-in ${money(e.price_cents)}` : null].filter(Boolean).join(' · ');
    const tags = [
      e.my_status === 'booked' ? badge('active', e.my_coverage === 'registered' ? 'Registered' : 'Booked') : '',
      e.my_status === 'waitlist' ? html`<span class="badge badge-neutral">Waitlist${e.waitlist_pos ? ` · ${ordinal(e.waitlist_pos)} in line` : ''}</span>` : '',
      e.clash ? html`<span class="s-late">${ath.first_name} is ${clashWhat(e.clash)} then</span>` : '',
      e.reg_closed ? html`<span class="s-late">Registration closed</span>` : '',
    ].filter(Boolean);
    return html`<div class="s-row">
      <div class="s-when">${clock(e.starts_at)}</div>
      <div class="s-main"><button type="button" class="s-open" data-open="${e.id}" aria-label="${e.name}, ${when(e.starts_at)}. Details">
        <span class="s-name">${e.name}</span><span class="s-meta">${meta}</span></button>
        ${tags.length ? html`<div class="s-tags">${tags}</div>` : ''}</div>
      <div class="s-act">${classAction(e)}</div>
    </div>`;
  }

  function classAction(e) {
    const on = `${e.name} on ${dayShort(e.starts_at)} at ${clock(e.starts_at)}`;
    if (e.my_status === 'booked') return e.my_coverage === 'registered' ? '' : html`<button type="button" class="btn btn-ghost btn-sm" data-cancel="${e.id}" aria-label="Cancel ${on}">Cancel</button>`;
    if (e.my_status === 'waitlist') return html`<button type="button" class="btn btn-ghost btn-sm" data-cancel="${e.id}" aria-label="Leave the waitlist for ${on}">Leave</button>`;
    if (e.needs_registration) return e.reg_closed ? '' : html`<button type="button" class="btn btn-outline btn-sm" data-register="${e.id}" aria-label="Register for ${e.name}">Register</button>`;
    if (e.clash) return '';
    if (e.full) return html`<button type="button" class="btn btn-sm" data-book="${e.id}" aria-label="Join the waitlist for ${on}">Waitlist</button>`;
    return html`<button type="button" class="btn btn-primary btn-sm" data-book="${e.id}" aria-label="Book ${on}">Book</button>`;
  }

  async function classDetails(e, data) {
    const ath = data.athlete;
    const map = mapLink(e.location, e.address);
    const lateH = data.late_cancel_hours;
    const spots = e.capacity ? (e.full ? `Full${e.waitlisted ? `, ${e.waitlisted} on the waitlist` : ''}` : `${e.spots_left} of ${e.capacity} left`) : null;
    const primary = e.my_status || e.clash || e.reg_closed ? null
      : e.needs_registration ? { label: `Register for ${money(e.reg_price_cents)}`, value: 'register', kind: 'primary' }
      : { label: e.full ? 'Join waitlist' : 'Book', value: 'book', kind: 'primary' };
    const cancelAct = e.my_status === 'waitlist' ? { label: 'Leave waitlist', value: 'cancel', kind: 'ghost' }
      : e.my_status === 'booked' && e.my_coverage !== 'registered' ? { label: 'Cancel booking', value: 'cancel', kind: 'ghost' } : null;
    const act = await modal({
      title: e.name,
      body: html`<dl class="s-detail">
          <dt>Athlete</dt><dd>${ath.first_name} ${ath.last_name}</dd>
          <dt>When</dt><dd>${dayLong(e.starts_at)}<br>${timeRange(e.starts_at, e.duration_min)}</dd>
          ${e.location ? html`<dt>Where</dt><dd>${e.location}${e.address ? html`<br><span class="muted">${e.address}</span>` : ''}</dd>` : ''}
          ${e.coach ? html`<dt>Coach</dt><dd>${e.coach}</dd>` : ''}
          ${e.ages ? html`<dt>Ages</dt><dd>${e.ages}</dd>` : ''}
          ${spots && !e.needs_registration ? html`<dt>Spots</dt><dd>${spots}</dd>` : ''}
          ${e.my_status === 'waitlist' ? html`<dt>Status</dt><dd>On the waitlist${e.waitlist_pos ? `, ${ordinal(e.waitlist_pos)} in line` : ''}. If a spot opens, ${ath.first_name} is booked automatically and you get an email.</dd>` : ''}
          <dt>Payment</dt><dd>${payLine(ath, e, data.card_label)}</dd>
        </dl>
        ${e.full && !e.my_status && !e.clash ? html`<p class="hint" style="margin:0">Join the waitlist and ${ath.first_name} moves up automatically when a spot opens. We email you when that happens.</p>` : ''}
        ${e.clash ? html`<div class="banner" style="display:block">${ath.first_name} is already ${clashWhat(e.clash)} at ${clock(e.clash.starts_at)}. ${e.clash.status === 'waitlist' ? 'Leave that waitlist' : 'Cancel that'} first to book this one.</div>` : ''}
        ${e.reg_closed ? html`<div class="banner" style="display:block">Registration for ${e.name} has closed. Ask at the front desk.</div>` : ''}
        ${e.my_coverage === 'registered' ? html`<p class="hint" style="margin:0">Can't make a camp day? Tell the front desk.</p>` : ''}
        ${e.late && e.my_status === 'booked' && e.my_coverage !== 'registered' ? html`<p class="hint" style="margin:0">It starts within ${lateH} hours, so cancelling now still counts as used.</p>`
          : e.late && !e.my_status && !e.needs_registration ? html`<p class="hint" style="margin:0">It starts within ${lateH} hours. Once booked, cancelling still counts as used.</p>` : ''}
        ${e.my_status === 'booked' || map ? html`<div class="btn-row">
          ${e.my_status === 'booked' ? html`<a class="btn btn-sm" href="/api/parent/bookings/${e.my_booking_id}/ics" download="session.ics">${svg(CAL_ADD)} Add to calendar</a>` : ''}
          ${map ? html`<a class="btn btn-sm btn-ghost" href="${map}" target="_blank" rel="noopener">Directions</a>` : ''}</div>` : ''}`,
      // Close comes first so the focus a dialog opens with never lands on Cancel.
      actions: [{ label: 'Close', value: null }, cancelAct, primary].filter(Boolean),
    });
    if (act === 'book') bookClass(e, data);
    else if (act === 'register') registerCamp(e, data);
    else if (act === 'cancel') cancelClass(e, data);
  }

  async function bookClass(e, data, btn) {
    const ath = data.athlete;
    const post = (pay) => api.post('/parent/bookings', { athlete_id: ath.id, event_id: e.id, ...(pay ? { pay: 'card' } : {}) });
    const paid = () => toast(`${ath.first_name} is booked for ${e.name}. ${money(e.price_cents)} paid.`);
    if (btn) btn.disabled = true;
    try {
      if (!e.full && !e.covered) {
        if (!(await dropInPrompt(ath, e, data.card_label))) return;
        await post(true);
        paid();
      } else {
        const b = await post(false);
        toast(b.status === 'waitlist' ? `${ath.first_name} is on the waitlist. We'll email you if a spot opens.` : `${ath.first_name} is booked for ${e.name}, ${dayShort(e.starts_at)} at ${clock(e.starts_at)}.`);
      }
      refresh();
    } catch (err) {
      if (err.data?.needs_payment) {
        if (await dropInPrompt(ath, e, data.card_label)) {
          try { await post(true); paid(); refresh(); }
          catch (x) { if (!(await paymentError(x))) toastError(x); }
        }
      } else if (err.data?.needs_registration) { registerCamp(e, data); }
      else if (!(await paymentError(err))) { toastError(err); refresh(); }
    } finally { if (btn?.isConnected) btn.disabled = false; }
  }

  // No sessions left: pay the drop-in with the card on file, or go buy a pack. Resolves true to pay.
  async function dropInPrompt(a, e, cardLabel) {
    const r = await modal({
      title: 'No sessions left',
      body: html`<p style="margin:0">${a.first_name} has no group sessions left. ${cardLabel
        ? html`Pay the ${money(e.price_cents)} drop-in for ${e.name} on ${when(e.starts_at)} with the ${cardLabel}, or buy a pack.`
        : html`Add a card to pay the ${money(e.price_cents)} drop-in, or buy a pack.`}</p>
        ${cardLabel ? html`<p class="hint" style="margin:0">Cancel more than ${ctx.me.settings.late_cancel_hours} hours before and the drop-in is refunded.</p>` : ''}`,
      actions: [{ label: 'Buy a pack', value: 'pack' }, cardLabel ? { label: `Pay ${money(e.price_cents)}`, value: 'pay', kind: 'primary' } : { label: 'Add a card', value: 'card', kind: 'primary' }],
    });
    if (r === 'pack') ctx.go(`/parent/programs?athlete=${a.id}#packs`);
    if (r === 'card') ctx.go(cardBack(here()));
    return r === 'pay';
  }

  async function registerCamp(e, data) {
    const ath = data.athlete;
    if (!data.card_label) {
      const r = await modal({ title: `Register for ${e.name}`, body: html`<p style="margin:0">Registration is ${money(e.reg_price_cents)}, charged to the card on file. Add a card first.</p>`, actions: [{ label: 'Not now', value: null }, { label: 'Add a card', value: true, kind: 'primary' }] });
      if (r) ctx.go(cardBack(here()));
      return;
    }
    const ok = await modal({
      title: `Register for ${e.name}`,
      body: html`<p style="margin:0">${ath.first_name}, ${e.reg_days ? plural(e.reg_days, 'day') : 'every day'} from ${dayLong(e.starts_at)}, ${timeRange(e.starts_at, e.duration_min)}${e.location ? `, ${e.location}` : ''}.</p>
        <p class="muted" style="margin:0">${money(e.reg_price_cents)} is charged to the ${data.card_label}, once. Every day is booked for ${ath.first_name}.</p>`,
      actions: [{ label: 'Cancel', value: false }, {
        label: `Register and pay ${money(e.reg_price_cents)}`, value: true, kind: 'primary',
        onClick: async () => {
          try { const r = await api.post(`/parent/camps/${e.class_id}/register`, { athlete_id: ath.id }); toast(`${ath.first_name} is registered for ${e.name}. ${plural(r.days, 'day')} booked.`); return true; }
          catch (err) { if (await paymentError(err)) return null; throw err; }
        },
      }],
    });
    if (ok) refresh();
  }

  async function cancelClass(e, data) {
    const ath = data.athlete;
    const lateH = data.late_cancel_hours;
    let text, label = 'Cancel booking', tone = 'primary';
    if (e.my_status === 'waitlist') { text = html`<p style="margin:0">Take ${ath.first_name} off the waitlist for ${e.name} on ${when(e.starts_at)}?</p>`; label = 'Leave waitlist'; }
    else if (e.late) {
      text = html`<div class="banner" style="display:block">This session starts within ${lateH} hours, so it still counts as used.</div>
        <p style="margin:0">Cancel ${ath.first_name}'s spot in ${e.name} on ${when(e.starts_at)} anyway? The spot goes to the next athlete on the waitlist.</p>`;
      label = 'Cancel anyway'; tone = 'warn';
    } else {
      const back = e.my_coverage === 'credit' ? ' The session goes back on your account.' : e.my_coverage === 'paid' && e.my_paid_cents ? ` The ${money(e.my_paid_cents)} drop-in is refunded to your card.` : e.my_coverage === 'member' ? " It won't count against the membership." : '';
      text = html`<p style="margin:0">Cancel ${ath.first_name}'s spot in ${e.name} on ${when(e.starts_at)}?${back}</p>`;
    }
    const ok = await modal({ title: e.my_status === 'waitlist' ? 'Leave waitlist' : 'Cancel booking', body: text, actions: [{ label: 'Keep it', value: false }, { label, value: true, kind: tone }] });
    if (!ok) return;
    try {
      const r = await api.del(`/parent/bookings/${e.my_booking_id}`);
      toast(r.late ? 'Cancelled. The session still counts as used.' : e.my_status === 'waitlist' ? 'Off the waitlist.' : `Cancelled. ${ath.first_name}'s spot is free for someone else.`);
    } catch (err) { toastError(err); }
    refresh();
  }

  // ---------------- privates and evaluations ----------------
  function paintSlots(data) {
    const ath = data.athlete;
    const isPrivate = kind === 'private';
    const price = data.slots[0]?.price_cents;
    const credits = ath.private_credits || 0;
    let note;
    if (isPrivate) {
      note = credits > 0
        ? html`<p class="muted" style="margin:0">Uses one of ${ath.first_name}'s private sessions. ${credits} left.</p>`
        : html`<div class="banner"><span>${ath.first_name} has no private sessions left.${data.single_private && data.card_label ? ` Pick a time to pay ${money(data.single_private.price_cents)} for a single private and book it in one step, or buy a pack.` : ' Buy a private pack to book one.'}</span><a class="btn btn-warn btn-sm" href="/parent/programs?athlete=${ath.id}#packs">See packs</a></div>`;
    } else {
      note = data.card_label
        ? html`<p class="muted" style="margin:0">${price ? `Evaluations are ${money(price)}, charged to the ${data.card_label} when you book.` : 'Pick a time for the evaluation.'}</p>`
        : html`<div class="banner"><span>Evaluations are charged to the card on file. Add a card first.</span><a class="btn btn-warn btn-sm" href="${cardBack(here())}">Add card</a></div>`;
    }
    if (coach && !data.coaches.some((c) => String(c.id) === coach)) coach = '';
    const slots = coach ? data.slots.filter((s) => String(s.coach_id) === coach) : data.slots;
    const manyCoaches = data.coaches.length > 1;
    const places = [...new Set(data.slots.map((s) => s.location).filter(Boolean))];
    const oneplace = places.length === 1 ? places[0] : null;
    const lengths = [...new Set(data.slots.map((s) => s.duration_min))];
    const days = groupByDay(slots);
    const label = isPrivate ? 'private' : 'evaluation';
    const Label = isPrivate ? 'Private' : 'Evaluation';
    const subOf = (s) => [manyCoaches && !coach ? s.coach : null, !oneplace ? s.location : null].filter(Boolean).join(' · ');
    const intro = [lengths.length === 1 ? `${lengths[0]} minutes` : null, oneplace ? `at ${oneplace}` : null, !manyCoaches && data.coaches[0] ? `with ${data.coaches[0].name}` : null].filter(Boolean).join(' ');
    mount(body, html`${note}
      ${data.booked.length ? html`<section class="panel panel-tight bk-booked" aria-labelledby="bk-booked-h" style="gap:0">
        <h2 class="sec-label" id="bk-booked-h" style="margin:0 0 4px">Booked for ${ath.first_name}</h2>
        ${data.booked.map((b) => html`<div class="s-row">
          <div class="s-when">${dayWord(b.starts_at)}<span>${clock(b.starts_at)}</span></div>
          <div class="s-main"><button type="button" class="s-open" data-bopen="${b.id}" aria-label="${Label} on ${when(b.starts_at)}. Details">
            <span class="s-name">${Label}${b.coach ? ` with ${b.coach}` : ''}</span>
            <span class="s-meta">${[b.location, b.note ? `Note: ${b.note}` : null].filter(Boolean).join(' · ')}</span></button>
            ${b.late ? html`<div class="s-tags"><span class="s-late">Inside the late-cancel window</span></div>` : ''}</div>
          <div class="s-act"><button type="button" class="btn btn-ghost btn-sm" data-bcancel="${b.id}" aria-label="Cancel the ${label} on ${dayShort(b.starts_at)} at ${clock(b.starts_at)}">Cancel</button></div>
        </div>`)}</section>` : ''}
      ${manyCoaches ? html`<div class="pills" role="group" aria-label="Coach">
        <button type="button" class="pill" data-coach="" aria-pressed="${String(!coach)}">Any coach</button>
        ${data.coaches.map((c) => html`<button type="button" class="pill" data-coach="${c.id}" aria-pressed="${String(String(c.id) === coach)}">${c.name}</button>`)}</div>` : ''}
      ${days.length && intro ? html`<p class="hint" style="margin:0">${intro[0].toUpperCase() + intro.slice(1)}. Pick a time.</p>` : ''}
      ${days.length ? days.map((d, i) => html`<section class="panel panel-tight bk-day" ${i >= DAYS_SHOWN ? raw('hidden data-later') : ''}>
        <h2 class="slot-day">${dayTitle(d.day)}</h2>
        <div class="slots">${d.items.map((s) => html`<button type="button" class="btn slot" data-slot="${s.starts_at}" data-scoach="${s.coach_id || ''}"
          aria-label="${Label} ${when(s.starts_at)}${s.coach ? `, with ${s.coach}` : ''}${!oneplace && s.location ? `, ${s.location}` : ''}">${clock(s.starts_at)}${subOf(s) ? html`<span class="slot-sub">${subOf(s)}</span>` : ''}</button>`)}</div>
      </section>`) : html`<div class="empty">No open ${label} times${coach ? ' with this coach' : ''} in the next three weeks. ${coach ? html`<button type="button" class="btn btn-ghost btn-sm" data-coach="">Show every coach</button>` : 'Ask your coach about other times.'}</div>`}
      ${days.length > DAYS_SHOWN ? html`<button type="button" class="btn btn-ghost bk-later" id="bk-later">Show later dates (${days.length - DAYS_SHOWN} more ${days.length - DAYS_SHOWN === 1 ? 'day' : 'days'})</button>` : ''}`);

    body.querySelectorAll('[data-coach]').forEach((b) => { b.onclick = () => { coach = b.dataset.coach; paintSlots(data); body.querySelector(`[data-coach="${coach}"]`)?.focus(); }; });
    body.querySelector('#bk-later')?.addEventListener('click', (ev) => {
      const first = body.querySelector('[data-later]');
      body.querySelectorAll('[data-later]').forEach((x) => { x.hidden = false; });
      ev.currentTarget.remove();
      first?.querySelector('.slot')?.focus();
    });
    body.querySelectorAll('[data-slot]').forEach((b) => { b.onclick = () => pickSlot(data.slots.find((s) => s.starts_at === b.dataset.slot && String(s.coach_id || '') === b.dataset.scoach), data); });
    const booked = (id) => data.booked.find((x) => x.id === +id);
    body.querySelectorAll('[data-bcancel]').forEach((b) => { b.onclick = () => cancelSlot(booked(b.dataset.bcancel), data); });
    body.querySelectorAll('[data-bopen]').forEach((b) => { b.onclick = () => slotDetails(booked(b.dataset.bopen), data); });
  }

  const noteField = (s) => html`<div class="field"><label class="label" for="bk-note">Note for ${s.coach || 'the coach'} <span class="muted">(optional)</span></label>
    <textarea class="input" id="bk-note" rows="3" maxlength="${NOTE_MAX}" placeholder="What to work on, an injury to know about, anything else"></textarea></div>`;
  const readNote = (el) => (el.querySelector('#bk-note')?.value || '').trim();

  async function pickSlot(s, data) {
    if (!s) return;
    const ath = data.athlete;
    const isPrivate = kind === 'private';
    const whereWho = [s.location, s.coach ? `with ${s.coach}` : null].filter(Boolean).join(', ');
    const summary = html`<p style="margin:0" tabindex="-1" autofocus><strong>${ath.first_name}</strong>, ${when(s.starts_at)}, ${s.duration_min} min${whereWho ? `, ${whereWho}` : ''}.</p>`;
    const bookIt = async (el) => {
      const note = readNote(el);
      await api.post('/parent/slots', { kind, starts_at: s.starts_at, athlete_id: ath.id, coach_id: s.coach_id, note });
      toast(`${isPrivate ? 'Private' : 'Evaluation'} booked for ${dayShort(s.starts_at)} at ${clock(s.starts_at)}.${note && s.coach ? ` ${s.coach} gets your note.` : ''}`);
    };
    // Handled here (modal closes): the time was taken, or the card needs fixing.
    const handled = async (err) => {
      if (/just taken|already (booked|on the waitlist)/i.test(err.message)) { toastError(err); refresh(); return true; }
      return paymentError(err);
    };

    if (!isPrivate && !data.card_label) {
      const r = await modal({ title: 'Add a card first', body: html`<p style="margin:0">Evaluations${s.price_cents ? ` are ${money(s.price_cents)} and` : ''} are charged to the card on file when you book. Add a card, then pick this time.</p>`, actions: [{ label: 'Not now', value: null }, { label: 'Add a card', value: true, kind: 'primary' }] });
      if (r) ctx.go(cardBack(here()));
      return;
    }
    if (isPrivate && !(ath.private_credits > 0)) {
      const single = data.single_private;
      if (!single || !data.card_label) {
        const r = await modal({ title: 'No private sessions left', body: html`<p style="margin:0">${single && !data.card_label ? `Add a card to buy a single private for ${money(single.price_cents)}, or buy a pack for ${ath.first_name}.` : `Buy a private pack for ${ath.first_name}, then pick this time.`}</p>`,
          actions: [{ label: 'Not now', value: null }, single && !data.card_label ? { label: 'Add a card', value: 'card', kind: 'primary' } : { label: 'See packs', value: 'pack', kind: 'primary' }] });
        if (r === 'pack') ctx.go(`/parent/programs?athlete=${ath.id}#packs`);
        if (r === 'card') ctx.go(cardBack(here()));
        return;
      }
      // Buy one private and book this time in one step.
      let bought = false;
      const r = await modal({
        title: 'Buy and book a private',
        body: html`${summary}
          <p class="muted" style="margin:0">${ath.first_name} has no private sessions left. ${single.name} (${money(single.price_cents)}) is charged to the ${data.card_label}, then this time is booked.</p>
          ${noteField(s)}`,
        actions: [{ label: 'See packs', value: 'pack' }, {
          label: `Pay ${money(single.price_cents)} and book`, value: true, kind: 'primary',
          onClick: async (el) => {
            try {
              if (!bought) { await api.post('/parent/packs', { athlete_id: ath.id, product_id: single.id }); bought = true; }
              await bookIt(el);
              return true;
            } catch (err) {
              if (bought) { toast(`${single.name} is on ${ath.first_name}'s account. ${err.message}`, 'warn'); refresh(); return null; }
              if (await handled(err)) return null;
              throw err;
            }
          },
        }],
      });
      if (r === 'pack') ctx.go(`/parent/programs?athlete=${ath.id}#packs`);
      else if (r) refresh();
      return;
    }
    const ok = await modal({
      title: isPrivate ? 'Book a private' : 'Book an evaluation',
      body: html`${summary}
        <p class="muted" style="margin:0">${isPrivate ? `Uses 1 of ${ath.first_name}'s ${ath.private_credits} private ${ath.private_credits === 1 ? 'session' : 'sessions'}. Cancel more than ${data.late_cancel_hours} hours before and it goes back on the account.` : s.price_cents ? `${money(s.price_cents)} is charged to the ${data.card_label}. Cancel more than ${data.late_cancel_hours} hours before and it is refunded.` : 'There is no charge.'}</p>
        ${noteField(s)}`,
      actions: [{ label: 'Cancel', value: false }, {
        label: isPrivate ? 'Book private' : s.price_cents ? `Book and pay ${money(s.price_cents)}` : 'Book evaluation', value: true, kind: 'primary',
        onClick: async (el) => { try { await bookIt(el); return true; } catch (err) { if (await handled(err)) return null; throw err; } },
      }],
    });
    if (ok) refresh();
  }

  async function slotDetails(b, data) {
    const ath = data.athlete;
    const isPrivate = kind === 'private';
    const map = mapLink(b.location, b.address);
    const act = await modal({
      title: isPrivate ? 'Private' : 'Evaluation',
      body: html`<dl class="s-detail">
          <dt>Athlete</dt><dd>${ath.first_name} ${ath.last_name}</dd>
          <dt>When</dt><dd>${dayLong(b.starts_at)}<br>${timeRange(b.starts_at, b.duration_min)}</dd>
          ${b.location ? html`<dt>Where</dt><dd>${b.location}${b.address ? html`<br><span class="muted">${b.address}</span>` : ''}</dd>` : ''}
          ${b.coach ? html`<dt>Coach</dt><dd>${b.coach}</dd>` : ''}
          ${b.note ? html`<dt>Your note</dt><dd class="bk-note-text">${b.note}</dd>` : ''}
          <dt>Payment</dt><dd>${isPrivate && b.coverage === 'credit' ? 'Uses a private session.' : paidText(b.coverage, b.paid_cents)}</dd>
        </dl>
        ${b.late ? html`<p class="hint" style="margin:0">It starts within ${data.late_cancel_hours} hours, so cancelling now still counts as used.</p>` : ''}
        <div class="btn-row"><a class="btn btn-sm" href="/api/parent/bookings/${b.id}/ics" download="session.ics">${svg(CAL_ADD)} Add to calendar</a>
          ${map ? html`<a class="btn btn-sm btn-ghost" href="${map}" target="_blank" rel="noopener">Directions</a>` : ''}</div>`,
      actions: [{ label: 'Close', value: null }, { label: 'Cancel booking', value: 'cancel', kind: 'ghost' }],
    });
    if (act === 'cancel') cancelSlot(b, data);
  }

  async function cancelSlot(b, data) {
    const ath = data.athlete;
    const what = kind === 'private' ? 'private' : 'evaluation';
    const back = b.coverage === 'credit' ? ` The private session goes back on ${ath.first_name}'s account.` : b.coverage === 'paid' && b.paid_cents ? ` The ${money(b.paid_cents)} is refunded to your card.` : '';
    const told = b.coach ? ` ${b.coach} is told, and the time opens up for others.` : ' The time opens up for others.';
    const text = b.late
      ? html`<div class="banner" style="display:block">This ${what} starts within ${data.late_cancel_hours} hours, so it still counts as used.</div>
        <p style="margin:0">Cancel ${ath.first_name}'s ${what} on ${when(b.starts_at)} anyway?${told}</p>`
      : html`<p style="margin:0">Cancel ${ath.first_name}'s ${what} on ${when(b.starts_at)}?${back}${told}</p>`;
    const ok = await modal({ title: `Cancel ${what}`, body: text, actions: [{ label: 'Keep it', value: false }, { label: b.late ? 'Cancel anyway' : `Cancel ${what}`, value: true, kind: b.late ? 'warn' : 'primary' }] });
    if (!ok) return;
    try {
      const r = await api.del(`/parent/bookings/${b.id}`);
      toast(r.late ? 'Cancelled. The session still counts as used.' : `Cancelled.${back}`);
    } catch (err) { toastError(err); }
    refresh();
  }

  await load({ fresh: true });
}
