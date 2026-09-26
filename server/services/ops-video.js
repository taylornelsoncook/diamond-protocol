// Demo video links for exercises: YouTube, Vimeo or a direct video file.
'use strict';

const FILE_RE = /\.(mp4|m4v|webm|mov|ogv)(\?.*)?$/i;

// Returns { kind: 'youtube'|'vimeo'|'file', id?, url } or null when the link isn't one we can play.
function parseVideo(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/); if (m) id = m[1]; }
    return id && /^[\w-]{6,20}$/.test(id) ? { kind: 'youtube', id, url: raw } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(?:^|\/)(\d{5,12})(?:\/|$)/);
    return m ? { kind: 'vimeo', id: m[1], url: raw } : null;
  }
  if (FILE_RE.test(u.pathname)) return { kind: 'file', url: raw };
  return null;
}

// Validates and normalizes a link typed by staff. Empty is allowed (no video yet).
function cleanVideoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (!parseVideo(raw)) {
    const { bad } = require('../lib');
    throw bad('Use a YouTube or Vimeo link, or a direct link to a video file ending in .mp4, .webm or .mov.');
  }
  return raw;
}

module.exports = { parseVideo, cleanVideoUrl };
