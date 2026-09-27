import { h, fill, toast, money, busy, btn } from './ui.js';

// The page behind a pay link. A parent pays one thing by card without signing in.
const tok = location.pathname.split('/pay/')[1];
const root = document.getElementById('root');
const logo = () => h('img', { src: '/brand/logo.png', alt: 'Diamond Protocol. Built under pressure.', style: 'width:140px;align-self:center' });
const shell = (...kids) => fill(root, h('main', { class: 'p-wrap', style: 'min-height:100vh;justify-content:center' }, logo(), h('div', { class: 'dp-panel stack' }, ...kids)));
const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

async function load() {
  const back = new URLSearchParams(location.search).has('paid');
  const res = await fetch(`/pay-api/${tok}${back ? '/confirm' : ''}`, back ? { method: 'POST' } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return shell(h('h1', { class: 'p-title' }, 'Link not found'), h('p', { class: 'muted' }, 'Check the link in your email or text, or ask us for a new one.'));
  render(data, back);
}

function render(p, back) {
  document.title = `Pay ${p.business_name}`;
  const amount = h('div', { style: 'font:700 44px/1 var(--font-display);color:var(--steel)' }, money(p.amount_cents));
  if (p.status === 'paid') return shell(h('h1', { class: 'p-title' }, 'Paid. Thank you!'), amount, h('p', { class: 'muted', style: 'margin:0' }, `${p.description}. Paid ${fmt(p.paid_at)}. A receipt is on its way by email.`));
  if (back && p.status === 'open') return shell(h('h1', { class: 'p-title' }, 'Thanks! Confirming your payment'), amount, h('p', { class: 'muted', style: 'margin:0' }, 'This usually takes a few seconds. Refresh this page to check, and look for a receipt by email.'), btn('Refresh', () => location.reload(), 'secondary'));
  const closed = { settled: 'This was already paid, so there\'s nothing to pay here.', canceled: 'This link was canceled. If you still owe something, ask us for a new link.', expired: 'This link has expired. Ask us for a new one.' }[p.status];
  if (closed) return shell(h('h1', { class: 'p-title' }, 'Nothing to pay'), h('p', { class: 'muted', style: 'margin:0' }, closed));
  shell(
    h('p', { class: 'small muted', style: 'margin:0;letter-spacing:.08em;text-transform:uppercase' }, `Pay ${p.business_name}`),
    amount,
    h('p', { style: 'margin:0' }, p.description),
    p.can_pay_online ? btn(`Pay ${money(p.amount_cents)} by card`, (e) => busy(e.currentTarget, async () => {
      const r = await fetch(`/pay-api/${tok}/checkout`, { method: 'POST' }).then((x) => x.json());
      if (r.url) location.href = r.url; else toast(r.error?.message ?? 'Paying online isn\'t available right now.', 'warn');
    }), 'primary', { class: 'dp-btn dp-btn--primary dp-btn--block' }) : null,
    p.can_simulate ? btn('Simulate payment (test mode)', (e) => busy(e.currentTarget, async () => {
      const r = await fetch(`/pay-api/${tok}/simulate`, { method: 'POST' }).then((x) => x.json());
      if (r.error) toast(r.error.message, 'warn'); else render(r);
    }), 'secondary', { class: 'dp-btn dp-btn--secondary dp-btn--block' }) : null,
    !p.can_pay_online && !p.can_simulate ? h('p', { class: 'muted', style: 'margin:0' }, 'Paying online isn\'t set up yet. Contact us to pay another way.') : null,
    h('p', { class: 'small muted', style: 'margin:0' }, p.can_pay_online ? 'You\'ll pay on Stripe\'s secure page. We never see your card number.' : ''));
}

load();
