if (new URLSearchParams(location.search).has('canceled')) {
  document.getElementById('title').textContent = 'No card saved';
  document.getElementById('msg').textContent = 'You left before saving a card. Open the link from your coach again when you\'re ready.';
}
