// Website enquiry form (/enquire, or embedded with ?embed=1): sends to /api/public/enquiry and says thanks.
(function () {
  var page = document.getElementById('page');
  var f = document.getElementById('eq');
  var err = document.getElementById('eq-err');
  if (new URLSearchParams(location.search).get('embed') === '1') page.classList.add('embed');
  fetch('/api/public/enquiry-config').then(function (r) { return r.json(); }).then(function (c) {
    document.title = 'Enquire about training · ' + c.business;
    document.querySelectorAll('.biz').forEach(function (el) { el.textContent = c.business; });
    var sel = document.getElementById('eq-int');
    c.interests.forEach(function (i) { var o = document.createElement('option'); o.value = i[0]; o.textContent = i[1]; sel.appendChild(o); });
  }).catch(function () {});
  function fail(msg, field) {
    err.textContent = msg;
    f.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = {};
    Array.prototype.forEach.call(f.elements, function (el) { if (el.name) d[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    if (!d.parent_name) return fail('Enter your name.', f.parent_name);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return fail('Enter your email so we can reply.', f.email);
    if (d.sms_opt_in && !d.phone) return fail('Add your mobile number, or untick the box about texts.', f.phone);
    // The form sends the sport and position together; the first word or two is the sport.
    var sp = String(d.sport || '').split(','); d.sport = sp[0].trim(); d.position = sp.slice(1).join(',').trim();
    if (d.athlete_age === '') delete d.athlete_age; else d.athlete_age = Number(d.athlete_age);
    if (d.grad_year === '') delete d.grad_year; else d.grad_year = Number(d.grad_year);
    if (!d.athlete_name) d.athlete_name = d.athlete_age || d.grad_year ? d.parent_name : '';
    var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Sending…';
    fail('');
    fetch('/api/public/enquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { btn.disabled = false; btn.textContent = 'Send enquiry'; return fail(x.j.error || 'That didn’t send. Try again, or call us.'); }
        f.outerHTML = '<div class="panel eq-done" role="status"><h2>Enquiry sent</h2><p class="muted" style="margin:0"></p></div>';
        page.querySelector('.eq-done p').textContent = x.j.message;
        document.getElementById('eq-sub').hidden = true;
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'Send enquiry'; fail('That didn’t send. Check your connection and try again.'); });
  });
})();
