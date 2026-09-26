// Programs: camps and clinics, standing weekly spots, session packs and memberships.
import { html, mount, api, toast, toastError, modal, money, badge } from '/js/ui.js';
import { header, athletePills, bindAthletePills, dayShort, clockHM, weekdays } from '../common.js';

const STATUS = { active: 'Active', trial: 'Trial', past_due: 'Past due', paused: 'Paused' };

function dateRange(a, b) { return a && b && a !== b ? `${dayShort(a)}–${dayShort(b)}` : a ? dayShort(a) : ''; }

export async function render(ctx) {
  const a = ctx.athlete;
  if (!a) { mount(ctx.el, html`${header('Programs', ctx.familyName)}<div class="empty">Add an athlete on the Family tab first.</div>`); return; }
  const d = await api.get(`/parent/shop?athlete_id=${a.id}`);
  if (!ctx.isCurrent()) return;
  const ath = d.athlete;
  const m = d.membership;
  const planLine = (p) => `${money(p.price_cents)} a month${p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}${p.group_per_month == null ? ' · unlimited group classes' : ` · ${p.group_per_month} group classes`}${p.private_per_month ? ` · ${p.private_per_month} privates` : ''}`;

  mount(ctx.el, html`${header('Programs', ctx.familyName)}
    ${athletePills(ctx)}
    ${!d.card_label ? html`<div class="banner"><span>Add a card to register, buy packs or start a membership.</span><a class="btn btn-warn btn-sm" href="/parent/card">Add card</a></div>` : ''}

    <section class="panel" id="camps">
      <div><h2 class="panel-title">Camps & clinics</h2><p class="panel-sub">One registration covers every day.</p></div>
      ${d.camps.length ? html`<div>${d.camps.map((c) => html`<div class="offer stackable" id="camp-${c.id}">
        <div class="grow"><div class="offer-name">${c.name}</div>
          <div class="offer-meta">${[dateRange(c.start_date, c.end_date), weekdays(c.weekdays), clockHM(c.start_time), `${c.duration_min} min`, c.ages, c.location].filter(Boolean).join(' · ')}</div>
          <div class="offer-meta">${c.days} ${c.days === 1 ? 'day' : 'days'}${c.reg_deadline ? ` · Register by ${dayShort(c.reg_deadline)}` : ''}</div></div>
        ${c.registered ? badge('registered') : !c.eligible ? html`<span class="muted small">Not for ${ath.first_name}'s age</span>`
          : c.days ? html`<button class="btn btn-primary" data-camp="${c.id}">Register · ${money(c.reg_price_cents)}</button>` : html`<span class="muted small">Full schedule not out yet</span>`}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No camps or clinics open for registration right now.</p>`}
    </section>

    <section class="panel" id="standing">
      <div><h2 class="panel-title">Weekly group classes</h2><p class="panel-sub">Hold a standing spot and ${ath.first_name} is booked every week.</p></div>
      ${!d.is_member ? html`<p class="small muted" style="margin:0">Standing spots are for members. Start a membership below to hold one.</p>` : ''}
      ${d.classes.length ? html`<div>${d.classes.map((c) => html`<div class="offer">
        <div class="grow"><div class="offer-name">${c.name}</div>
          <div class="offer-meta">${[weekdays(c.weekdays), clockHM(c.start_time), `${c.duration_min} min`, c.location, c.ages].filter(Boolean).join(' · ')}</div></div>
        ${c.standing_id ? html`<button class="btn btn-ghost" data-leave="${c.standing_id}" data-name="${c.name}">Leave</button>`
          : html`<button class="btn" data-hold="${c.id}" ${d.is_member ? '' : 'disabled'}>Hold a spot</button>`}
      </div>`)}</div>` : html`<p class="muted" style="margin:0">No weekly classes for ${ath.first_name}'s age.</p>`}
    </section>

    <section class="panel" id="packs">
      <div><h2 class="panel-title">Packs & memberships</h2><p class="panel-sub">For ${ath.first_name}</p></div>
      ${m ? html`<div class="banner info" style="justify-content:flex-start"><span>${ath.first_name}'s membership: ${m.plan_name} · ${STATUS[m.status] || m.status}${m.next_charge ? `. Next charge ${dayShort(m.next_charge)}` : ''}. To change or pause it, ask your coach.</span></div>` : ''}
      <div>
        ${d.plans.map((p) => html`<div class="offer">
          <div class="grow"><div class="offer-name">${p.name}</div><div class="offer-meta">${planLine(p)}</div></div>
          ${m ? (m.plan_id === p.id ? badge('active', 'Current') : '') : html`<button class="btn" data-plan="${p.id}">${p.trial_days ? 'Start trial' : `Start · ${money(p.price_cents)}`}</button>`}
        </div>`)}
        ${d.packs.map((p) => html`<div class="offer">
          <div class="grow"><div class="offer-name">${p.name}</div><div class="offer-meta">${p.credits} ${p.kind === 'private_pack' ? (p.credits === 1 ? 'private session' : 'private sessions') : (p.credits === 1 ? 'group session' : 'group sessions')}</div></div>
          <button class="btn" data-pack="${p.id}">Buy · ${money(p.price_cents)}</button>
        </div>`)}
      </div>
      <p class="small muted" style="margin:0">${ath.first_name} has ${ath.group_credits} group and ${ath.private_credits} private ${ath.private_credits === 1 ? 'session' : 'sessions'} from packs.</p>
    </section>`);
  bindAthletePills(ctx);

  const noCard = async () => {
    const r = await modal({ title: 'Add a card first', body: html`<p style="margin:0">Payments go on the card on file. It takes a minute.</p>`, actions: [{ label: 'Not now', value: null }, { label: 'Add card', value: true, kind: 'primary' }] });
    if (r) ctx.go('/parent/card');
  };
  const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toastError(e); } finally { btn.disabled = false; } };

  ctx.el.querySelectorAll('[data-camp]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const c = d.camps.find((x) => x.id === +btn.dataset.camp);
    if (!d.card_label) return noCard();
    const ok = await modal({ title: 'Register', body: html`<p style="margin:0">Register ${ath.first_name} for ${c.name}, ${dateRange(c.start_date, c.end_date)}. Every day is booked.</p>
      <p class="muted" style="margin:0">${money(c.reg_price_cents)} is charged to the ${d.card_label}.</p>`, actions: [{ label: 'Cancel', value: false }, { label: `Pay ${money(c.reg_price_cents)}`, value: true, kind: 'primary' }] });
    if (!ok) return;
    const r = await api.post(`/parent/camps/${c.id}/register`, { athlete_id: a.id });
    toast(`${ath.first_name} is registered. ${r.days} ${r.days === 1 ? 'day' : 'days'} booked.`);
    ctx.reload();
  }); });

  ctx.el.querySelectorAll('[data-hold]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const c = d.classes.find((x) => x.id === +btn.dataset.hold);
    const r = await api.post('/parent/standing', { athlete_id: a.id, class_id: c.id });
    toast(`Spot held in ${c.name}. ${r.booked} upcoming ${r.booked === 1 ? 'session' : 'sessions'} booked.`);
    ctx.reload();
  }); });

  ctx.el.querySelectorAll('[data-leave]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const ok = await modal({ title: 'Leave standing spot', body: html`<p style="margin:0">Give up ${ath.first_name}'s weekly spot in ${btn.dataset.name}? Upcoming sessions are cancelled, except any inside the late-cancel window.</p>`,
      actions: [{ label: 'Keep it', value: false }, { label: 'Leave', value: true, kind: 'primary' }] });
    if (!ok) return;
    const r = await api.del(`/parent/standing/${btn.dataset.leave}`);
    toast(`Spot released. ${r.cancelled} ${r.cancelled === 1 ? 'session' : 'sessions'} cancelled${r.kept ? `, ${r.kept} kept` : ''}.`);
    ctx.reload();
  }); });

  ctx.el.querySelectorAll('[data-pack]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const p = d.packs.find((x) => x.id === +btn.dataset.pack);
    if (!d.card_label) return noCard();
    const ok = await modal({ title: 'Buy a pack', body: html`<p style="margin:0">${p.name} for ${ath.first_name}.</p><p class="muted" style="margin:0">${money(p.price_cents)} is charged to the ${d.card_label}.</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: `Pay ${money(p.price_cents)}`, value: true, kind: 'primary' }] });
    if (!ok) return;
    await api.post('/parent/packs', { athlete_id: a.id, product_id: p.id });
    toast(`${p.name} added. ${ath.first_name} can book now.`);
    ctx.reload();
  }); });

  ctx.el.querySelectorAll('[data-plan]').forEach((btn) => { btn.onclick = () => run(btn, async () => {
    const p = d.plans.find((x) => x.id === +btn.dataset.plan);
    if (!d.card_label) return noCard();
    const ok = await modal({ title: 'Start membership', body: html`<p style="margin:0">${p.name} for ${ath.first_name}: ${planLine(p)}.</p>
      <p class="muted" style="margin:0">${p.trial_days ? `Nothing is charged today. After ${p.trial_days} days, ${money(p.price_cents)} is charged to the ${d.card_label} every month.` : `${money(p.price_cents)} is charged to the ${d.card_label} today and every month.`} Cancel any time by asking your coach.</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: p.trial_days ? 'Start free trial' : `Pay ${money(p.price_cents)}`, value: true, kind: 'primary' }] });
    if (!ok) return;
    try {
      const r = await api.post('/parent/membership', { athlete_id: a.id, plan_id: p.id });
      toast(r.trial ? `Trial started. ${ath.first_name} can book group classes now.` : 'Membership started.');
    } finally { ctx.reload(); }
  }); });
}
