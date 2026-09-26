// Home: each athlete at a glance, with what's coming up and a way to cancel.
import { html, mount, api, toast, toastError, modal } from '/js/ui.js';
import { header, weekday, clock, dayShort, dayLong } from '../common.js';

const STATUS = { active: 'Active', trial: 'Trial', past_due: 'Past due', paused: 'Paused' };

function stats(a) {
  const m = a.membership;
  const unlimited = a.member_left === 'unlimited';
  const groupLeft = unlimited ? null : (Number(a.member_left) || 0) + (a.group_credits || 0);
  const groupNote = !unlimited && a.member_left > 0 && a.group_credits > 0 ? `${a.member_left} from membership, ${a.group_credits} from packs` : null;
  return html`<div class="stats">
    <div class="stat"><div class="stat-v word ${m?.status === 'past_due' ? 'warn' : ''}">${m ? STATUS[m.status] || m.status : '—'}</div>
      <div class="stat-l">${m ? m.plan_name : 'No membership'}</div></div>
    <div class="stat"><div class="stat-v ${unlimited ? 'word' : ''}">${unlimited ? 'Unlimited' : groupLeft}</div>
      <div class="stat-l">${unlimited ? 'Group classes' : 'Group classes left'}${groupNote ? html`<br>${groupNote}` : ''}</div></div>
    <div class="stat"><div class="stat-v">${a.private_credits || 0}</div><div class="stat-l">Privates left</div></div>
  </div>`;
}

function sessionRow(b) {
  return html`<div class="s-row">
    <div class="s-when">${weekday(b.starts_at)}<span>${clock(b.starts_at)}</span></div>
    <div><div class="s-name">${b.name}</div><div class="s-meta">${dayShort(b.starts_at)}${b.location ? ` · ${b.location}` : ''}${b.status === 'waitlist' ? ' · On the waitlist' : ''}</div></div>
    <div class="s-act"><button class="btn btn-ghost btn-sm" data-cancel="${b.id}">${b.status === 'waitlist' ? 'Leave' : 'Cancel'}</button></div>
  </div>`;
}

export async function render(ctx) {
  const { me } = ctx;
  const bookings = await api.get('/parent/bookings');
  if (!ctx.isCurrent()) return;
  const f = me.family;
  const pastDue = me.athletes.filter((a) => a.membership?.status === 'past_due');
  const banners = [
    !f.waiver_current ? html`<div class="banner"><span>${f.waiver_version ? 'The waiver has changed. Sign the new one before the next session.' : 'Sign the waiver before the first session.'}</span><a class="btn btn-warn btn-sm" href="/parent/family#waiver">Sign waiver</a></div>` : '',
    !f.card_last4 ? html`<div class="banner"><span>Add a card for drop-ins, packs, camps and memberships.</span><a class="btn btn-warn btn-sm" href="/parent/card">Add card</a></div>` : '',
    pastDue.length && f.card_last4 ? html`<div class="banner"><span>${pastDue.map((a) => a.first_name).join(' and ')}'s membership payment was declined. Update the card to keep booking.</span><a class="btn btn-warn btn-sm" href="/parent/card">Update card</a></div>` : '',
  ];
  mount(ctx.el, html`${header('Home', ctx.familyName)}
    ${banners}
    ${me.athletes.length ? '' : html`<div class="empty">No athletes on this account yet. <a href="/parent/family#add-athlete">Add an athlete</a>.</div>`}
    ${me.athletes.map((a) => {
      const mine = bookings.filter((b) => b.athlete_id === a.id);
      return html`<section class="panel" aria-label="${a.first_name} ${a.last_name}">
        <div><h2 class="a-name">${a.first_name} ${a.last_name}</h2>
          <p class="a-meta">${[a.age != null ? `Age ${a.age}` : null, a.sport, a.position].filter(Boolean).join(' · ')}</p>
          <p class="a-meta">Athlete ID <span class="mono">${a.code}</span></p></div>
        ${stats(a)}
        <h3 class="sec-label">Coming up</h3>
        ${mine.length ? html`<div class="list">${mine.map(sessionRow)}</div>` : html`<p class="muted" style="margin:0">Nothing booked yet.</p>`}
        <div class="btn-row">
          <a class="btn" href="/parent/book?athlete=${a.id}">Book a session</a>
          ${a.workout_token && a.has_program ? html`<a class="btn btn-ghost" href="/w/${a.workout_token}">Open workouts</a>` : ''}
        </div>
      </section>`;
    })}`);

  ctx.el.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.onclick = async () => {
      const b = bookings.find((x) => x.id === +btn.dataset.cancel);
      const a = me.athletes.find((x) => x.id === b.athlete_id);
      const when = `${dayLong(b.starts_at)} at ${clock(b.starts_at)}`;
      let body, label = 'Cancel booking', kind = 'primary';
      if (b.status === 'waitlist') { body = html`<p style="margin:0">Take ${a.first_name} off the waitlist for ${b.name} on ${when}?</p>`; label = 'Leave waitlist'; }
      else if (b.late) {
        body = html`<div class="banner" style="display:block">This session starts within ${me.settings.late_cancel_hours} hours, so it still counts as used.</div>
          <p style="margin:0">Cancel ${a.first_name}'s spot in ${b.name} on ${when} anyway? The spot goes to the next athlete on the waitlist.</p>`;
        label = 'Cancel anyway'; kind = 'warn';
      } else {
        const back = b.coverage === 'credit' ? ' The session goes back on your account.' : b.coverage === 'paid' && b.paid_cents ? ' The drop-in is refunded to your card.' : b.coverage === 'member' ? " It won't count against the membership." : '';
        body = html`<p style="margin:0">Cancel ${a.first_name}'s spot in ${b.name} on ${when}?${back}</p>`;
      }
      const ok = await modal({ title: b.status === 'waitlist' ? 'Leave waitlist' : 'Cancel booking', body, actions: [{ label: 'Keep it', value: false }, { label, value: true, kind }] });
      if (!ok) return;
      try {
        const r = await api.del(`/parent/bookings/${b.id}`);
        toast(r.late ? 'Cancelled. The session still counts as used.' : b.status === 'waitlist' ? 'Off the waitlist.' : 'Cancelled.');
        ctx.reload();
      } catch (e) { toastError(e); }
    };
  });
}
