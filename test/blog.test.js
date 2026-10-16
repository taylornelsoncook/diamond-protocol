// The public blog (schema 83, services/blog.js): published stand-alone posts under Education → Blogs are plain HTML
// pages at /blog and /blog/<slug>, with a feed, a sitemap and robots.txt, straight from the server; drafts, lessons in
// courses and the other tabs never show; a post's address is made from its title once and kept; a version 82
// database gains the columns and every blog post its address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createUser } from '../src/services/access.js';
import { openDb } from '../src/db.js';
import { slugify } from '../src/util.js';
import { paragraphs, videoHtml } from '../src/services/blog.js';

let app, base, owner;
const PW = 'correct-horse-battery';
async function req(method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text, res: r };
}
before(async () => {
  app = createApp({ testMode: true, jobs: false, publicUrl: 'https://app.example.org' });
  createUser(app.ctx, { email: 'owner@x.test', name: 'Owner', password: PW, role: 'owner' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const cookie = (await req('POST', '/auth/login', { email: 'owner@x.test', password: PW })).res.headers.get('set-cookie').split(';')[0];
  owner = (m, p, b) => req(m, p, b, { cookie });
});
after(() => app.server.close());

test('slugify: lower case, dashes, no punctuation, 80 characters', () => {
  assert.equal(slugify('Why Sleep Matters! Part 2 — Café'), 'why-sleep-matters-part-2-cafe');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('a'.repeat(100)).length, 80);
});

test('a blog post gets an address from its title, unique among posts, kept when the title changes, or typed', async () => {
  const a = (await owner('POST', '/v1/lessons', { title: 'Why Sleep Matters!', summary: 'Eight hours beats a late lift.', body: 'Para one is short.\n\nPara two links to https://example.com/sleep. And <b>tags</b> stay text.', category: 'blog', minutes: 3 })).body;
  assert.equal(a.slug, 'why-sleep-matters');
  const b = (await owner('POST', '/v1/lessons', { title: 'Why sleep matters', body: 'Again.', category: 'blog' })).body;
  assert.equal(b.slug, 'why-sleep-matters-2', 'the same title gets -2');
  const renamed = (await owner('PATCH', `/v1/lessons/${a.id}`, { title: 'Sleep and speed' })).body;
  assert.equal(renamed.slug, 'why-sleep-matters', 'a new title keeps the address so shared links work');
  const typed = (await owner('PATCH', `/v1/lessons/${b.id}`, { slug: 'Sleep Again!' })).body;
  assert.equal(typed.slug, 'sleep-again');
  const clash = await owner('PATCH', `/v1/lessons/${b.id}`, { slug: 'why-sleep-matters' });
  assert.equal(clash.status, 400); assert.match(clash.body.error.message, /already used/);
  assert.equal((await owner('PATCH', `/v1/lessons/${b.id}`, { slug: '!!!' })).status, 400);
  // Not a blog post: no address is made.
  const c = (await owner('POST', '/v1/lessons', { title: 'Coach notes', body: 'Staff only.', category: 'coach' })).body;
  assert.equal(c.slug, null);
  // A picture needs an https link.
  assert.equal((await owner('PATCH', `/v1/lessons/${a.id}`, { image_url: 'http://x/pic.jpg' })).status, 400);
  assert.equal((await owner('PATCH', `/v1/lessons/${a.id}`, { image_url: 'https://pics.example.org/sleep.jpg' })).body.image_url, 'https://pics.example.org/sleep.jpg');
  // The coach's education report carries the address.
  const edu = (await owner('GET', '/v1/education')).body;
  assert.equal(edu.lessons.find((l) => l.id === a.id).slug, 'why-sleep-matters');
});

test('/blog lists published posts as HTML with the right headers; drafts, courses and other tabs stay off', async () => {
  const draft = (await owner('POST', '/v1/lessons', { title: 'Not yet', body: 'Draft.', category: 'blog', published: false })).body;
  const course = (await owner('POST', '/v1/courses', { title: 'Recovery basics', audience: 'athletes' })).body;
  const inCourse = (await owner('POST', '/v1/lessons', { title: 'In a course', body: 'Course lesson.', course_id: course.id })).body;
  const r = await req('GET', '/blog');
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('content-type'), /text\/html/);
  assert.match(r.res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.res.headers.get('cache-control'), 'public, max-age=300');
  assert.match(r.text, /<h1 class="p-title bl-title">Blog<\/h1>/);
  assert.match(r.text, /href="\/blog\/why-sleep-matters"/);
  assert.match(r.text, /Sleep and speed/);
  assert.match(r.text, /Eight hours beats a late lift\./);
  assert.match(r.text, /href="\/blog\/sleep-again"/);
  assert.doesNotMatch(r.text, /Not yet/); assert.doesNotMatch(r.text, /In a course/); assert.doesNotMatch(r.text, /Coach notes/);
  assert.match(r.text, /<link rel="canonical" href="https:\/\/app\.example\.org\/blog">/);
  assert.match(r.text, /application\/ld\+json/);
  assert.match(r.text, /<img class="bl-card-pic" src="https:\/\/pics\.example\.org\/sleep\.jpg"/);
  // HEAD works and a trailing slash is the same page.
  assert.equal((await fetch(`${base}/blog`, { method: 'HEAD' })).status, 200);
  assert.equal((await req('GET', '/blog/')).status, 200);
  assert.equal((await req('GET', `/blog/${draft.slug}`)).status, 404, 'a draft is not a page');
  assert.equal((await req('GET', `/blog/${inCourse.id}`)).status, 404);
});

test('a post page: text as paragraphs, escaped, links made, the picture, the meta tags; an id link goes to the address', async () => {
  const r = await req('GET', '/blog/why-sleep-matters');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Sleep and speed · Diamond Protocol<\/title>/);
  assert.match(r.text, /<p>Para one is short\.<\/p>/);
  assert.match(r.text, /<a href="https:\/\/example\.com\/sleep" rel="noopener">https:\/\/example\.com\/sleep<\/a>\./);
  assert.match(r.text, /&lt;b&gt;tags&lt;\/b&gt; stay text/);
  assert.doesNotMatch(r.text, /<b>tags<\/b>/);
  assert.match(r.text, /<meta property="og:type" content="article">/);
  assert.match(r.text, /<meta property="og:image" content="https:\/\/pics\.example\.org\/sleep\.jpg">/);
  assert.match(r.text, /<link rel="canonical" href="https:\/\/app\.example\.org\/blog\/why-sleep-matters">/);
  assert.match(r.text, /"@type":"BlogPosting"/);
  assert.match(r.text, /More from the blog/);
  assert.match(r.text, /href="\/blog\/sleep-again"/);
  const a = app.ctx.db.get(`SELECT id FROM lessons WHERE slug = 'why-sleep-matters'`);
  const byId = await req('GET', `/blog/${a.id}`);
  assert.equal(byId.status, 301); assert.equal(byId.res.headers.get('location'), '/blog/why-sleep-matters');
  const gone = await req('GET', '/blog/nope-not-here');
  assert.equal(gone.status, 404); assert.match(gone.text, /That post isn.t here/);
  assert.equal((await req('GET', '/blog/a/b')).status, 404);
  // A title with markup is escaped everywhere it appears.
  const evil = (await owner('POST', '/v1/lessons', { title: '<script>alert(1)</script> & co', body: 'x', category: 'blog' })).body;
  assert.equal(evil.slug, 'script-alert-1-script-co');
  const page = await req('GET', `/blog/${evil.slug}`);
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
  await owner('DELETE', `/v1/lessons/${evil.id}`);
});

test('the feed, the sitemap and robots.txt', async () => {
  const feed = await req('GET', '/blog/feed.xml');
  assert.equal(feed.status, 200); assert.match(feed.res.headers.get('content-type'), /rss\+xml/);
  assert.match(feed.text, /<item><title>Sleep and speed<\/title><link>https:\/\/app\.example\.org\/blog\/why-sleep-matters<\/link>/);
  assert.doesNotMatch(feed.text, /Not yet/);
  const map = await req('GET', '/blog/sitemap.xml');
  assert.equal(map.status, 200); assert.match(map.text, /<loc>https:\/\/app\.example\.org\/blog\/sleep-again<\/loc>/);
  const robots = await req('GET', '/robots.txt');
  assert.equal(robots.status, 200); assert.match(robots.text, /Sitemap: https:\/\/app\.example\.org\/blog\/sitemap\.xml/); assert.match(robots.text, /Disallow: \/app/);
});

test('paragraphs and videos', () => {
  assert.equal(paragraphs('One\nstill one\n\nTwo'), '<p>One<br>still one</p>\n<p>Two</p>');
  assert.equal(paragraphs(''), '');
  assert.match(videoHtml('https://www.youtube.com/watch?v=abc123', 'T'), /youtube-nocookie\.com\/embed\/abc123/);
  assert.match(videoHtml('https://vimeo.com/12345', 'T'), /player\.vimeo\.com\/video\/12345/);
  assert.match(videoHtml('https://cdn.example.org/clip.mp4', 'T "q"'), /<video src="https:\/\/cdn\.example\.org\/clip\.mp4" controls/);
  assert.equal(videoHtml('not a url', 'T'), '');
});

test('a version 82 database gains slug and image_url, and every blog post its address', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dp-v82-')), file = join(tmp, 'dp.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('./fixtures/schema-v82.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 82');
    const ins = old.prepare("INSERT INTO lessons (id, title, body, category, published, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)");
    ins.run('les_1', 'Why sleep matters', 'a', 'blog', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    ins.run('les_2', 'Why sleep matters', 'b', 'blog', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    ins.run('les_3', 'Staff notes', 'c', 'coach', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    old.close();
    for (const round of [1, 2]) {
      const d = openDb(file);
      assert.equal(d.get('PRAGMA user_version').user_version, 84, `round ${round}`);
      const cols = d.all('PRAGMA table_info(lessons)').map((c) => c.name);
      assert.ok(cols.includes('slug') && cols.includes('image_url'));
      assert.deepEqual(d.all('SELECT id, slug FROM lessons ORDER BY id').map((r) => [r.id, r.slug]), [['les_1', 'why-sleep-matters'], ['les_2', 'why-sleep-matters-2'], ['les_3', null]]);
      d.close();
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
