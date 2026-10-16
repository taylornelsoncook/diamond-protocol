const q = new URLSearchParams(location.search);
const title = document.getElementById('title'), msg = document.getElementById('msg');
const client = q.get('client');
if (q.has('canceled')) {
  title.textContent = 'No card saved';
  msg.textContent = client ? 'You left Stripe\'s page before saving a card. Nothing changed.' : 'You left before saving a card. Open the link from your coach again when you\'re ready.';
}
// Staff came back from Stripe's page: save the card on the client now (the webhook would too, a moment later) and offer the way back.
if (client) {
  const back = document.createElement('a');
  back.href = `/#/clients/${encodeURIComponent(client)}?tab=membership`;
  back.textContent = 'Back to the client page';
  back.className = 'dp-btn dp-btn--primary';
  if (!q.has('canceled')) {
    title.textContent = 'Card saved at Stripe';
    msg.textContent = 'Stripe keeps the card details. The client page shows the brand, the last 4 digits and the expiry.';
    if (q.get('session_id')) {
      fetch(`/v1/clients/${encodeURIComponent(client)}/card/setup-done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: q.get('session_id') }) })
        .then((r) => r.json()).then((d) => { if (d?.on_file) msg.textContent = `${(d.brand || 'Card').replace(/^./, (x) => x.toUpperCase())} ending ${d.last4} is on file. Stripe keeps the card details; the client page shows only the brand, the last 4 digits and the expiry.`; })
        .catch(() => {});
    }
  }
  msg.insertAdjacentElement('afterend', back);
}
