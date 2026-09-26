// Book: classes three weeks ahead, or an open time for a private or an evaluation.
import { html, mount, api, toast, toastError, modal, money, badge } from '/js/ui.js';
import { header, athletePills, bindAthletePills, groupByDay, dayLong, clock } from '../common.js';

const KINDS = [['classes', 'Classes'], ['private', 'Private'], ['evaluation', 'Evaluation']];

export async function render(ctx) {
  const a = ctx.athlete;
  const kind = KINDS.some(([k]) => k === ctx.query.kind) ? ctx.query.kind : 'classes';
  if (!a) { mount(ctx.el, html`${header('Book', ctx.familyName)}<div class="empty">Add an athlete on the Family tab first.</div>`); return; }
  const top = html`${header('Book', ctx.familyName)}
    ${athletePills(ctx)}
    <div class="pills" role="group" aria-label="What to book">${KINDS.map(([k, label]) => html`<button class="pill" data-kind="${k}" aria-pressed="${String(k === kind)}">${label}</button>`)}</div>`;
  if (kind === 'classes') await classes(ctx, a, top);
  else await slots(ctx, a, kind, top);
  if (!ctx.isCurrent()) return;
  bindAthletePills(ctx);
  ctx.el.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => ctx.go(`/parent/book${b.dataset.kind === 'classes' ? '' : '?kind=' + b.dataset.kind}`, { replace: true }); });
}

// ---- classes ----
function coverageLine(a) {
  if (a.member_left === 'unlimited') return `${a.first_name}'s membership covers every group class.`;
  const n = (Number(a.member_left) || 0) + (a.group_credits || 0);
  if (n > 0) return `${a.first_name} has ${n} group ${n === 1 ? 'session' : 'sessions'} left${a.member_left > 0 ? ' this month' : ''}.`;
  return null;
}

async function classes(ctx, a, top) {
  const data = await api.get(`/parent/classes?athlete_id=${a.id}`);
  if (!ctx.isCurrent()) return;
  const ath = data.athlete;
  const line = coverageLine(ath);
  const days = groupByDay(data.events);
  mount(ctx.el, html`${top}
    ${line ? html`<p class="muted" style="margin:0">${line}</p>` : html`<div class="banner"><span>${ath.first_name} has no group sessions left. Pay the drop-in price with the card on file, or buy a pack.</span><a class="btn btn-warn btn-sm" href="/parent/programs?athlete=${a.id}#packs">Buy a pack</a></div>`}
    ${days.length ? html`<section class="panel panel-tight" style="gap:0">${days.map((d) => html`
      <h2 class="day-h">${dayLong(d.day)}</h2>
      ${d.items.map((e) => html`<div class="s-row">
        <div class="s-when">${clock(e.starts_at)}</div>
        <div><div class="s-name">${e.name}</div>
          <div class="s-meta">${[e.location, e.full ? 'Full' : e.spots_left != null ? `${e.spots_left} ${e.spots_left === 1 ? 'spot' : 'spots'} left` : null,
            !e.covered && !e.needs_registration && e.price_cents && !e.my_status ? `Drop-in ${money(e.price_cents)}` : null].filter(Boolean).join(' · ')}</div></div>
        <div class="s-act">${action(e)}</div>
      </div>`)}`)}</section>`
      : html`<div class="empty">No classes for ${ath.first_name}'s age in the next three weeks.</div>`}`);

  ctx.el.querySelectorAll('[data-book]').forEach((btn) => {
    btn.onclick = async () => {
      const e = data.events.find((x) => x.id === +btn.dataset.book);
      btn.disabled = true;
      try {
        if (!e.full && !e.covered) {
          const pay = await dropInPrompt(ctx, ath, e, data.card_label);
          if (!pay) return;
          await api.post('/parent/bookings', { athlete_id: a.id, event_id: e.id, pay: 'card' });
          toast(`Booked and paid ${money(e.price_cents)}. See it on Home.`);
        } else {
          const b = await api.post('/parent/bookings', { athlete_id: a.id, event_id: e.id });
          toast(b.status === 'waitlist' ? `${ath.first_name} is on the waitlist. We'll email you if a spot opens.` : `${ath.first_name} is booked. See it on Home.`);
        }
        ctx.reload();
      } catch (err) {
        if (err.data?.needs_payment) { const pay = await dropInPrompt(ctx, ath, e, data.card_label); if (pay) { try { await api.post('/parent/bookings', { athlete_id: a.id, event_id: e.id, pay: 'card' }); toast('Booked and paid.'); ctx.reload(); } catch (x) { toastError(x); } } }
        else toastError(err);
      } finally { btn.disabled = false; }
    };
  });
}

function action(e) {
  if (e.my_status === 'booked') return badge('active', 'Booked');
  if (e.my_status === 'waitlist') return badge('waitlist', 'Waitlisted');
  if (e.needs_registration) return html`<a class="btn btn-outline btn-sm" href="/parent/programs#camp-${e.class_id}">Register</a>`;
  if (e.full) return html`<button class="btn btn-sm" data-book="${e.id}">Waitlist</button>`;
  return html`<button class="btn btn-primary btn-sm" data-book="${e.id}">Book</button>`;
}

// No sessions left: pay the drop-in with the card on file, or go buy a pack. Resolves true to pay.
async function dropInPrompt(ctx, a, e, cardLabel) {
  const when = `${dayLong(e.starts_at)} at ${clock(e.starts_at)}`;
  const r = await modal({
    title: 'No sessions left',
    body: html`<p style="margin:0">${a.first_name} has no group sessions left. ${cardLabel
      ? html`Pay the ${money(e.price_cents)} drop-in for ${e.name} on ${when} with the ${cardLabel}, or buy a pack.`
      : html`Add a card to pay the ${money(e.price_cents)} drop-in, or buy a pack.`}</p>`,
    actions: [{ label: 'Buy a pack', value: 'pack' }, cardLabel ? { label: `Pay ${money(e.price_cents)}`, value: 'pay', kind: 'primary' } : { label: 'Add a card', value: 'card', kind: 'primary' }],
  });
  if (r === 'pack') ctx.go(`/parent/programs?athlete=${a.id}#packs`);
  if (r === 'card') ctx.go('/parent/card');
  return r === 'pay';
}

// ---- privates and evaluations ----
async function slots(ctx, a, kind, top) {
  const data = await api.get(`/parent/slots?kind=${kind}&athlete_id=${a.id}`);
  if (!ctx.isCurrent()) return;
  const ath = data.athlete;
  const price = data.slots[0]?.price_cents;
  let note;
  if (kind === 'private') {
    note = ath.private_credits > 0
      ? html`<p class="muted" style="margin:0">Uses one private session from ${ath.first_name}'s pack. ${ath.private_credits} left.</p>`
      : html`<div class="banner"><span>${ath.first_name} has no private sessions left. Buy a private pack to book one.</span><a class="btn btn-warn btn-sm" href="/parent/programs?athlete=${a.id}#packs">Buy a pack</a></div>`;
  } else {
    note = data.card_label
      ? html`<p class="muted" style="margin:0">${price ? `Evaluations are ${money(price)}, charged to the ${data.card_label}.` : 'Pick a time for the evaluation.'}</p>`
      : html`<div class="banner"><span>Evaluations are charged to the card on file. Add a card first.</span><a class="btn btn-warn btn-sm" href="/parent/card">Add card</a></div>`;
  }
  const days = groupByDay(data.slots);
  mount(ctx.el, html`${top}${note}
    ${days.length ? days.map((d) => html`<section class="panel panel-tight">
      <h2 class="slot-day">${dayLong(d.day)}</h2>
      <div class="slots">${d.items.map((s) => html`<button class="btn slot" data-slot="${s.starts_at}">${clock(s.starts_at)}${s.location ? ` · ${s.location}` : ''}</button>`)}</div>
    </section>`) : html`<div class="empty">No open times in the next three weeks. Ask your coach about other times.</div>`}`);

  ctx.el.querySelectorAll('[data-slot]').forEach((btn) => {
    btn.onclick = async () => {
      const s = data.slots.find((x) => x.starts_at === btn.dataset.slot);
      const when = `${dayLong(s.starts_at)} at ${clock(s.starts_at)}`;
      if (kind === 'private' && !(ath.private_credits > 0)) {
        const r = await modal({ title: 'No private sessions left', body: html`<p style="margin:0">Buy a private pack for ${ath.first_name}, then pick this time.</p>`, actions: [{ label: 'Not now', value: null }, { label: 'Buy a pack', value: true, kind: 'primary' }] });
        if (r) ctx.go(`/parent/programs?athlete=${a.id}#packs`);
        return;
      }
      if (kind === 'evaluation' && !data.card_label) { ctx.go('/parent/card'); return; }
      const ok = await modal({
        title: kind === 'private' ? 'Book a private' : 'Book an evaluation',
        body: html`<p style="margin:0">${ath.first_name}, ${when}${s.location ? `, ${s.location}` : ''}, ${s.duration_min} min.</p>
          <p class="muted" style="margin:0">${kind === 'private' ? `Uses 1 of ${ath.first_name}'s ${ath.private_credits} private sessions.` : `${money(s.price_cents)} is charged to the ${data.card_label}.`}</p>`,
        actions: [{ label: 'Cancel', value: false }, { label: kind === 'private' ? 'Book private' : `Book and pay ${money(s.price_cents)}`, value: true, kind: 'primary' }],
      });
      if (!ok) return;
      try {
        await api.post('/parent/slots', { kind, starts_at: s.starts_at, athlete_id: a.id });
        toast(`Booked for ${when}. See it on Home.`);
        ctx.reload();
      } catch (e) { toastError(e); ctx.reload(); }
    };
  });
}
