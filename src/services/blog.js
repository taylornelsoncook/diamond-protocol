// The public blog (/blog): the published stand-alone posts under Education → Blogs, served as plain HTML pages straight
// from the server (with a feed and a sitemap), so search engines, link previews and feed readers can read them. Nothing
// personal is on it: titles, text, pictures, videos and dates. Posts are written on the Education screen like any lesson.
import { getSetting } from './families.js';
import { slugify } from '../util.js';

export const PAGE_SIZE = 20;
const POST = `published = 1 AND course_id IS NULL AND category = 'blog'`;
const COLS = 'id, title, summary, body, video_url, image_url, minutes, slug, created_at, updated_at';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A post's web address: made from the title, and never the same as another lesson's ("why-sleep-matters-2").
export function uniqueSlug(ctx, title, { exceptId = '' } = {}) {
  const base = slugify(title) || 'post';
  let slug = base;
  for (let n = 2; ctx.db.get('SELECT 1 FROM lessons WHERE slug = ? AND id != ?', slug, exceptId); n++) slug = `${base}-${n}`;
  return slug;
}
export const slugTaken = (ctx, slug, exceptId = '') => !!ctx.db.get('SELECT 1 FROM lessons WHERE slug = ? AND id != ?', slug, exceptId);

export function listPosts(ctx, { page = 1 } = {}) {
  const total = ctx.db.get(`SELECT COUNT(*) AS n FROM lessons WHERE ${POST}`).n, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const data = ctx.db.all(`SELECT ${COLS} FROM lessons WHERE ${POST} ORDER BY created_at DESC LIMIT ? OFFSET ?`, PAGE_SIZE, (p - 1) * PAGE_SIZE).map(shape);
  return { data, page: p, pages, total };
}
export function getPost(ctx, slug) {
  const l = ctx.db.get(`SELECT ${COLS} FROM lessons WHERE slug = ? AND ${POST}`, String(slug));
  return l ? shape(l) : null;
}
// An older link by id lands on the post's address.
export const slugOfId = (ctx, id) => ctx.db.get(`SELECT slug FROM lessons WHERE id = ? AND ${POST}`, String(id))?.slug ?? null;
const shape = (l) => ({ ...l, slug: l.slug ?? l.id, has_video: !!l.video_url });

// ---------- Pages ----------
const business = (ctx) => ({ name: getSetting(ctx, 'business_name') || 'Diamond Protocol', zone: getSetting(ctx, 'timezone') || 'UTC' });
const dateText = (iso, zone) => new Date(iso).toLocaleDateString('en-US', { timeZone: zone, month: 'long', day: 'numeric', year: 'numeric' });
const dayOf = (iso, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
// The description search engines and link previews show: the summary, or the first sentence or so of the text.
const descriptionOf = (p) => (p.summary || String(p.body ?? '').replace(/\s+/g, ' ').trim()).slice(0, 160);
// Plain text to paragraphs: blank lines start one, single line breaks stay, https links become links.
export function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" rel="noopener">${u}</a>`).replace(/\n/g, '<br>')}</p>`).join('\n');
}
// A video on the post: YouTube and Vimeo in their players, a video file in the browser's own.
export function videoHtml(url, title) {
  let u; try { u = new URL(url); } catch { return ''; }
  const yt = u.hostname.includes('youtu') ? (u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.split('/').pop()) : null;
  const vimeo = u.hostname.includes('vimeo.com') ? u.pathname.split('/').filter(Boolean).pop() : null;
  const src = yt ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?rel=0` : vimeo ? `https://player.vimeo.com/video/${encodeURIComponent(vimeo)}` : null;
  return `<div class="video-frame">${src ? `<iframe src="${esc(src)}" title="${esc(title)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>` : `<video src="${esc(url)}" controls playsinline preload="metadata" aria-label="${esc(title)}"></video>`}</div>`;
}
function layout(ctx, baseUrl, { title, description, path, image, kind = 'website', body, jsonLd }) {
  const b = business(ctx), url = `${baseUrl}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:site_name" content="${esc(b.name)}">
<meta property="og:type" content="${kind === 'article' ? 'article' : 'website'}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="alternate" type="application/rss+xml" title="${esc(b.name)} blog" href="${esc(baseUrl)}/blog/feed.xml">
<link rel="icon" href="/brand/mark.png">
<link rel="apple-touch-icon" href="/brand/mark.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/parent.css">
<link rel="stylesheet" href="/blog.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<div id="root"><main class="p-wrap bl-wrap">
<header class="bl-head">
<a class="bl-brand" href="/blog"><img src="/brand/logo.png" alt="${esc(b.name)}. Built under pressure." width="160"></a>
<nav class="bl-nav" aria-label="Site"><a href="/blog">Blog</a><a href="/learn">Coach's education</a><a href="/book">Book now</a><a href="/start">Ask about training</a></nav>
</header>
${body}
<footer class="bl-foot"><p class="small muted">Want to train with us? <a href="/start">Ask about training</a> or <a href="/join">sign your family up</a>.</p>
<p class="small muted">${esc(b.name)} · <a href="/blog/feed.xml">RSS feed</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></footer>
</main></div>
</body>
</html>`;
}
const card = (p, zone) => `<a class="bl-card" href="/blog/${esc(p.slug)}">
${p.image_url ? `<img class="bl-card-pic" src="${esc(p.image_url)}" alt="" loading="lazy">` : ''}
<span class="bl-card-text"><span class="bl-card-title">${esc(p.title)}</span>${p.summary ? `<span class="bl-card-sum">${esc(p.summary)}</span>` : ''}
<span class="bl-card-meta">${[dateText(p.created_at, zone), p.minutes ? `${p.minutes} min` : null, p.has_video ? 'Video' : null].filter(Boolean).map(esc).join(' · ')}</span></span></a>`;

function listPage(ctx, baseUrl, query) {
  const b = business(ctx), { data, page, pages, total } = listPosts(ctx, { page: query.page });
  const nav = pages > 1 ? `<nav class="bl-pages" aria-label="More posts">${page > 1 ? `<a class="dp-btn dp-btn--secondary" href="/blog${page - 1 > 1 ? `?page=${page - 1}` : ''}">Newer</a>` : '<span></span>'}<span class="small muted">Page ${page} of ${pages}</span>${page < pages ? `<a class="dp-btn dp-btn--secondary" href="/blog?page=${page + 1}">Older</a>` : '<span></span>'}</nav>` : '';
  const body = `<h1 class="p-title bl-title">Blog</h1>
<p class="muted bl-sub">Training, speed, strength and recovery, from the coaches at ${esc(b.name)}.</p>
${data.length ? `<div class="bl-list">${data.map((p) => card(p, b.zone)).join('\n')}</div>${nav}` : '<p class="muted bl-empty">Nothing posted yet. Check back soon.</p>'}`;
  return { status: 200, type: 'text/html; charset=utf-8', body: layout(ctx, baseUrl, { title: `Blog · ${b.name}`, description: `Training, speed, strength and recovery, from the coaches at ${b.name}.${total ? ` ${total} post${total === 1 ? '' : 's'}.` : ''}`, path: page > 1 ? `/blog?page=${page}` : '/blog', body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Blog', name: `${b.name} blog`, url: `${baseUrl}/blog`, publisher: { '@type': 'Organization', name: b.name } } }) };
}
function postPage(ctx, baseUrl, p) {
  const b = business(ctx);
  const more = ctx.db.all(`SELECT ${COLS} FROM lessons WHERE ${POST} AND id != ? ORDER BY created_at DESC LIMIT 3`, p.id).map(shape);
  const body = `<article class="bl-post">
<a class="small bl-back" href="/blog">‹ Blog</a>
<h1 class="p-title bl-title">${esc(p.title)}</h1>
<p class="bl-meta small muted"><time datetime="${esc(p.created_at)}">${esc(dateText(p.created_at, b.zone))}</time>${p.minutes ? ` · ${p.minutes} min` : ''} · ${esc(b.name)}</p>
${p.summary ? `<p class="bl-summary">${esc(p.summary)}</p>` : ''}
${p.image_url ? `<figure class="bl-pic"><img src="${esc(p.image_url)}" alt=""></figure>` : ''}
${p.video_url ? videoHtml(p.video_url, p.title) : ''}
<div class="bl-body">${paragraphs(p.body)}</div>
</article>
${more.length ? `<section class="bl-more"><h2 class="dp-panel-title">More from the blog</h2><div class="bl-list">${more.map((x) => card(x, b.zone)).join('\n')}</div></section>` : ''}`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, description: descriptionOf(p), datePublished: p.created_at, dateModified: p.updated_at ?? p.created_at,
    url: `${baseUrl}/blog/${p.slug}`, mainEntityOfPage: `${baseUrl}/blog/${p.slug}`, ...(p.image_url ? { image: p.image_url } : {}), author: { '@type': 'Organization', name: b.name }, publisher: { '@type': 'Organization', name: b.name } };
  return { status: 200, type: 'text/html; charset=utf-8', body: layout(ctx, baseUrl, { title: `${p.title} · ${b.name}`, description: descriptionOf(p), path: `/blog/${p.slug}`, image: p.image_url, kind: 'article', body, jsonLd }) };
}
function notFoundPage(ctx, baseUrl) {
  const b = business(ctx);
  return { status: 404, type: 'text/html; charset=utf-8', body: layout(ctx, baseUrl, { title: `Not found · ${b.name}`, description: 'That post isn\'t here.', path: '/blog',
    body: '<h1 class="p-title bl-title">That post isn\'t here</h1><p class="muted">It may have been taken down, or the link is wrong. <a href="/blog">See every post</a>.</p>' }) };
}
export function feed(ctx, baseUrl) {
  const b = business(ctx), posts = ctx.db.all(`SELECT ${COLS} FROM lessons WHERE ${POST} ORDER BY created_at DESC LIMIT 50`).map(shape);
  const items = posts.map((p) => `<item><title>${esc(p.title)}</title><link>${esc(baseUrl)}/blog/${esc(p.slug)}</link><guid isPermaLink="true">${esc(baseUrl)}/blog/${esc(p.slug)}</guid><pubDate>${new Date(p.created_at).toUTCString()}</pubDate><description>${esc(descriptionOf(p))}</description></item>`).join('\n');
  return { status: 200, type: 'application/rss+xml; charset=utf-8', body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${esc(b.name)} blog</title><link>${esc(baseUrl)}/blog</link><atom:link href="${esc(baseUrl)}/blog/feed.xml" rel="self" type="application/rss+xml"/><description>Training, speed, strength and recovery, from the coaches at ${esc(b.name)}.</description><language>en-us</language>
${items}
</channel></rss>` };
}
export function sitemap(ctx, baseUrl) {
  const b = business(ctx), posts = ctx.db.all(`SELECT ${COLS} FROM lessons WHERE ${POST} ORDER BY created_at DESC LIMIT 5000`).map(shape);
  const urls = [`<url><loc>${esc(baseUrl)}/blog</loc>${posts[0] ? `<lastmod>${dayOf(posts[0].updated_at ?? posts[0].created_at, b.zone)}</lastmod>` : ''}</url>`,
    ...posts.map((p) => `<url><loc>${esc(baseUrl)}/blog/${esc(p.slug)}</loc><lastmod>${dayOf(p.updated_at ?? p.created_at, b.zone)}</lastmod></url>`)];
  return { status: 200, type: 'application/xml; charset=utf-8', body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>` };
}
// Search engines: the public pages are open; the dashboard, the portal, the app and the APIs aren't theirs to index.
export const robots = (baseUrl) => ({ status: 200, type: 'text/plain; charset=utf-8', body: ['User-agent: *', 'Allow: /blog', 'Allow: /learn', 'Allow: /book', 'Allow: /shop', 'Allow: /start', 'Allow: /join', 'Allow: /terms', 'Allow: /privacy', 'Disallow: /app', 'Disallow: /client', 'Disallow: /v1/', 'Disallow: /portal/', 'Disallow: /pay/', 'Disallow: /invoice/', 'Disallow: /receipt/', 'Disallow: /spot/', 'Disallow: /here/', 'Disallow: /kiosk', 'Disallow: /tv', `Sitemap: ${baseUrl}/blog/sitemap.xml`, ''].join('\n') });

// One entry for the server: the page, the feed, the sitemap, or an older link by id sent to the post's address.
export function render(ctx, pathname, query, baseUrl) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/blog') return listPage(ctx, baseUrl, query);
  if (path === '/blog/feed.xml') return feed(ctx, baseUrl);
  if (path === '/blog/sitemap.xml') return sitemap(ctx, baseUrl);
  const m = path.match(/^\/blog\/([^/]+)$/);
  if (!m) return notFoundPage(ctx, baseUrl);
  const key = decodeURIComponent(m[1]);
  const post = getPost(ctx, key);
  if (post) return postPage(ctx, baseUrl, post);
  const slug = slugOfId(ctx, key);
  if (slug && slug !== key) return { redirect: `/blog/${slug}` };
  return notFoundPage(ctx, baseUrl);
}
