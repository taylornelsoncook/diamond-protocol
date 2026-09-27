// Unsubscribe from CRM emails (/unsubscribe/<signed token>): shows whose address it is, then one button.
(function () {
  var box = document.getElementById('us');
  var token = location.pathname.split('/').pop();
  function show(html) { box.innerHTML = html; }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  fetch('/api/public/unsubscribe/' + encodeURIComponent(token)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (x) {
    if (!x.ok) return show('<h1>Link not valid</h1><p>' + esc(x.j.error) + '</p>');
    var j = x.j;
    if (j.already) return show('<h1>Unsubscribed</h1><p>' + esc(j.email) + ' is already off the list. You won’t get emails like that from ' + esc(j.business) + '.</p>');
    show('<h1>Unsubscribe</h1><p>Stop emails like this from ' + esc(j.business) + ' to ' + esc(j.email) + '? Account emails, like booking confirmations and receipts, still arrive.</p><div><button class="btn btn-primary btn-lg" id="go">Unsubscribe</button></div>');
    document.getElementById('go').addEventListener('click', function () {
      this.disabled = true;
      fetch('/api/public/unsubscribe/' + encodeURIComponent(token), { method: 'POST' }).then(function (r) { return r.json(); }).then(function (k) {
        if (k.error) return show('<h1>Something went wrong</h1><p>' + esc(k.error) + '</p>');
        show('<h1>Unsubscribed</h1><p>Done. ' + esc(j.email) + ' won’t get emails like that from ' + esc(k.business) + ' again. Changed your mind? Reply to any email and we’ll add you back.</p>');
      });
    });
  }).catch(function () { show('<h1>Something went wrong</h1><p>Check your connection and try the link again.</p>'); });
})();
