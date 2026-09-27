// Diamond Protocol "Book now" for your website. Paste where the schedule should appear:
//   <script src="https://app.diamondprotocol.org/embed.js" async></script>
// Add data-button="Book now" to show a single button that opens the booking page instead of the whole schedule.
(function () {
  var me = document.currentScript;
  if (!me) return;
  var origin = new URL(me.src).origin;
  var label = me.getAttribute('data-button');
  if (label) {
    var a = document.createElement('a');
    a.href = origin + '/book';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    a.style.cssText = 'display:inline-block;padding:14px 24px;border-radius:999px;background:#2F6B34;color:#fff;font:600 16px/1 system-ui,sans-serif;text-decoration:none';
    me.parentNode.insertBefore(a, me);
    return;
  }
  var f = document.createElement('iframe');
  f.src = origin + '/book?embed=1';
  f.title = 'Book a session';
  f.loading = 'lazy';
  f.style.cssText = 'width:100%;max-width:680px;height:720px;border:0;border-radius:12px;background:#000;display:block;margin:0 auto';
  me.parentNode.insertBefore(f, me);
  window.addEventListener('message', function (e) {
    if (e.origin === origin && e.source === f.contentWindow && e.data && typeof e.data.dpBookHeight === 'number') f.style.height = Math.min(Math.max(e.data.dpBookHeight, 300), 4000) + 'px';
  });
})();
