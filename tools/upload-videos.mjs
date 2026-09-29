#!/usr/bin/env node
// The video library upload: run once on the computer that has the videos (see CHECKLIST.md → Video library).
//
//   node tools/upload-videos.mjs "/Users/you/Movies/Exercises" "/Volumes/My Drive/Exercises"
//
// For every video in those folders (and the folders inside them) it:
//   1. names the exercise after the file ("Back squat.mp4" → Back squat; a folder like "Lower body" is its category),
//   2. makes a copy that loads fast on a phone (MP4, up to 1280 pixels, starts playing before it has all downloaded)
//      and a still picture from the first second, with ffmpeg,
//   3. uploads both to your own storage (Cloudflare R2, or any S3-compatible bucket) with a long cache time,
//   4. writes video-library.csv: bring it in at Settings → Exercise library → Import a list.
// The same exercise name in two places (the computer and the hard drive) is uploaded once; the others are listed in
// video-upload-report.txt. Stop it any time (Ctrl+C) and run it again: it carries on where it stopped.
//
// Settings go in video-upload.env next to where you run it (or in the environment):
//   VIDEO_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
//   VIDEO_S3_BUCKET=dp-videos
//   VIDEO_S3_KEY_ID=...            VIDEO_S3_SECRET=...     (an R2 API token that can write to that bucket)
//   VIDEO_PUBLIC_URL=https://videos.diamondprotocol.org   (the bucket's public address)
// Options: --dry-run (list what it would do; no settings needed), --no-convert (upload the files as they are; only
// .mp4, .m4v, .mov and .webm up to 1 GB, and no still pictures), --out <file> (default video-library.csv), --jobs <n> (2),
// --skip-check (don't test the public address first).
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, extname, relative, dirname, sep, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sign } from '../src/services/offsite.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.webm', '.mts', '.m2ts', '.3gp', '.mpg', '.mpeg']);
const AS_IS = new Set(['.mp4', '.m4v', '.mov', '.webm']);     // formats phones play without converting
const MAX_NAME = 120;
const MAX_AS_IS = 1024 * 1024 * 1024;                     // --no-convert reads each file into memory to sign it
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.jpg': 'image/jpeg' };

// ---------- Names ----------
// "back_squat (1).MP4" → "back squat"; "Front Plank copy.mov" → "Front Plank". Hyphens stay (Push-up).
export function exerciseName(file) {
  return basename(file, extname(file)).normalize('NFC').replace(/_/g, ' ').replace(/\s+\(\d+\)$/, '').replace(/\s+copy(\s+\d+)?$/i, '').replace(/\s+/g, ' ').trim();
}
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'exercise';

// Every video under the folders, in order: the first folder given wins when a name comes up twice.
export function scan(roots) {
  const found = [], seen = new Map(), duplicates = [], skipped = [];
  const walk = (root, dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped.push(`${dir}: couldn't open it (${e.code ?? e.message})`); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;                           // hidden files, and the "._" copies Macs leave on drives
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(root, full); continue; }
      if (!e.isFile() || !VIDEO_EXT.has(extname(e.name).toLowerCase())) continue;
      const name = exerciseName(e.name);
      if (!name) { skipped.push(`${full}: no name left after removing the extension`); continue; }
      if (name.length > MAX_NAME) { skipped.push(`${full}: the name is ${name.length} characters; rename the file to ${MAX_NAME} or fewer`); continue; }
      const lower = name.toLowerCase();
      if (seen.has(lower)) { duplicates.push(`${full} (same name as ${seen.get(lower)})`); continue; }
      seen.set(lower, full);
      const folder = relative(root, dirname(full));
      let st;
      try { st = statSync(full); } catch (x) { skipped.push(`${full}: couldn't read it (${x.code ?? x.message})`); continue; }
      found.push({ path: full, name, category: folder ? folder.split(sep).at(-1).normalize('NFC') : '', size: st.size, mtime: st.mtimeMs });
    }
  };
  for (const r of roots) {
    const root = resolve(r);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`There's no folder at ${root}. Check the path (drag the folder into the Terminal window to paste it).`);
    walk(root, root);
  }
  return { found, duplicates, skipped };
}

// ---------- Settings ----------
export function settings(env = process.env, file = 'video-upload.env') {
  const vals = { ...env };
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) vals[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const c = { endpoint: (vals.VIDEO_S3_ENDPOINT ?? '').replace(/\/+$/, ''), bucket: vals.VIDEO_S3_BUCKET ?? '', keyId: vals.VIDEO_S3_KEY_ID ?? '',
    secret: vals.VIDEO_S3_SECRET ?? '', region: vals.VIDEO_S3_REGION || 'auto', publicUrl: (vals.VIDEO_PUBLIC_URL ?? '').replace(/\/+$/, ''), prefix: vals.VIDEO_S3_PREFIX ?? 'exercises/' };
  const missing = ['VIDEO_S3_ENDPOINT', 'VIDEO_S3_BUCKET', 'VIDEO_S3_KEY_ID', 'VIDEO_S3_SECRET', 'VIDEO_PUBLIC_URL'].filter((k) => !vals[k]);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}. Put them in ${file} (see CHECKLIST.md → Video library).`);
  if (!/^https:\/\//.test(c.publicUrl)) throw new Error('VIDEO_PUBLIC_URL must start with https:// (the app only plays secure links).');
  let ep; try { ep = new URL(c.endpoint); } catch { throw new Error('VIDEO_S3_ENDPOINT isn\'t a web address. Copy the S3 endpoint from the R2 API token page.'); }
  if (ep.pathname.replace(/\/+$/, '')) throw new Error(`VIDEO_S3_ENDPOINT should end at .com (${ep.origin}), without the bucket name after it; the bucket goes in VIDEO_S3_BUCKET.`);
  return c;
}

// ---------- Storage ----------
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
async function put(c, key, body, type, { method = 'PUT', cache = 'public, max-age=31536000, immutable' } = {}) {
  const url = `${c.endpoint}/${enc(c.bucket)}/${key.split('/').map(enc).join('/')}`;
  const ms = Math.ceil(120_000 + (body?.length ?? 0) / 50);   // two minutes, plus time for a slow home connection (~400 kbit/s)
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = { ...sign({ method, url, body, region: c.region, keyId: c.keyId, secret: c.secret }), ...(type ? { 'content-type': type } : {}), ...(cache ? { 'cache-control': cache } : {}) };
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(ms) });
      if (res.ok) return;
      const text = await res.text();
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      if (res.status === 403 || res.status === 401) throw Object.assign(new Error(`The storage refused the upload (${code ?? res.status}). Check VIDEO_S3_KEY_ID and VIDEO_S3_SECRET, and that the token can write to ${c.bucket}.`), { fatal: true });
      if (res.status === 404) throw Object.assign(new Error(`There's no bucket called ${c.bucket} at that address. Check VIDEO_S3_BUCKET and VIDEO_S3_ENDPOINT.`), { fatal: true });
      throw new Error(`Storage answered ${res.status}${code ? ` ${code}` : ''}`);
    } catch (e) {
      if (e.fatal || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}
// Upload a tiny file and read it back from the public address, so a wrong setting shows up before hours of uploads.
async function checkPublic(c) {
  const key = `${c.prefix}.upload-check-${Date.now()}.txt`, body = Buffer.from(`ok ${Date.now()}`);
  await put(c, key, body, 'text/plain', { cache: 'no-store' });
  let res;
  try { res = await fetch(`${c.publicUrl}/${key.split('/').map(enc).join('/')}`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' }); } catch { res = null; }
  const ok = res?.ok && (await res.text()) === body.toString();
  await put(c, key, undefined, null, { method: 'DELETE', cache: null }).catch(() => {});
  if (!ok) throw new Error(`Uploading works, but ${c.publicUrl} doesn't show the files. In Cloudflare, open the bucket → Settings → Custom domains and connect that address (see DEPLOY.md → Video library).`);
}

// ---------- Converting ----------
const hasFfmpeg = () => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg couldn't convert it: ${err.trim().split('\n').at(-1) || `it stopped with code ${code}`}`))));
  });
}
// A video kept in iCloud (Desktop and Documents synced, "Optimize Mac Storage") is only a placeholder on the Mac until
// it's opened, and ffmpeg gives up waiting ("Error opening input files: Operation timed out"). Ask iCloud for the file
// (brctl download, macOS) and wait for it, up to a few minutes, before giving up on it.
const CLOUD_WAIT_MS = 5 * 60000;
const isCloudTimeout = (e) => /Operation timed out|Resource deadlock|Input\/output error/i.test(e?.message ?? '');
async function localCopy(path, log) {
  if (process.platform !== 'darwin' && !process.env.DP_TEST_CLOUD) return false;   // the test pretends to be a Mac
  const started = Date.now();
  spawnSync('brctl', ['download', path], { stdio: 'ignore' });
  let told = false;
  while (Date.now() - started < CLOUD_WAIT_MS) {
    try {
      // Reading the first bytes only works once the file is really here; a placeholder blocks, then errors.
      const fd = openSync(path, 'r'); const buf = Buffer.alloc(16); readSync(fd, buf, 0, 16, 0); closeSync(fd);
      return true;
    } catch { /* still downloading */ }
    if (!told) { log(`  … ${basename(path)} is in iCloud; waiting for it to download`); told = true; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}
// Up to 1280 pixels on the long side (phones held either way), H.264 + AAC, "faststart" so playback begins at once.
export { isCloudTimeout };
export const convertArgs = (src, out) => ['-y', '-v', 'error', '-i', src,
  '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2",   // even sizes, which H.264 needs
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', out];
export const posterArgs = (src, out, at = '1') => ['-y', '-v', 'error', '-ss', at, '-i', src, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '4', out];

// ---------- The run ----------
const csvCell = (s) => (/[",\n\r]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
function writeCsv(file, rows) {
  const out = ['Name,Category,Video URL,Poster URL', ...rows.map((r) => [r.name, r.category, r.video_url, r.poster_url ?? ''].map(csvCell).join(','))].join('\n') + '\n';
  writeFileSync(`${file}.tmp`, out); renameSync(`${file}.tmp`, file);
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, cwd = process.cwd() } = {}) {
  // --flag, --option value or --option=value. A mistyped option stops the run (a typo in --dry-run must not upload).
  const FLAGS = ['--dry-run', '--no-convert', '--skip-check'], OPTS = ['--out', '--jobs'];
  const flags = new Set(), opts = {}, roots = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { roots.push(a); continue; }
    const [name, inline] = a.split(/=(.*)/s);
    if (FLAGS.includes(name) && inline === undefined) flags.add(name);
    else if (OPTS.includes(name)) {
      const val = inline ?? argv[++i];
      if (!val || val.startsWith('--')) throw new Error(`${name} needs a value, like ${name === '--out' ? '--out video-library.csv' : '--jobs 2'}.`);
      opts[name] = val;
    } else throw new Error(`There's no option called ${a}. The options are ${[...FLAGS, ...OPTS].join(', ')}.`);
  }
  const opt = (name, dflt) => opts[name] ?? dflt;
  if (!roots.length) throw new Error('Give the folders with the videos, like: node tools/upload-videos.mjs "/Users/you/Movies/Exercises" "/Volumes/Drive/Exercises"');
  const outFile = resolve(cwd, opt('--out', 'video-library.csv'));
  const stateFile = resolve(cwd, 'video-upload-state.json'), reportFile = resolve(cwd, 'video-upload-report.txt');
  const jobs = Math.min(Math.max(Number(opt('--jobs', 2)) || 2, 1), 8);
  const convert = !flags.has('--no-convert');

  const { found, duplicates, skipped } = scan(roots);
  const total = found.reduce((n, f) => n + f.size, 0);
  log(`Found ${found.length.toLocaleString()} videos (${mb(total)}). ${duplicates.length ? `${duplicates.length.toLocaleString()} have the same name as another and will be skipped. ` : ''}${skipped.length ? `${skipped.length} can't be used (see the report).` : ''}`);
  const notPlayable = convert ? [] : found.filter((f) => !AS_IS.has(extname(f.path).toLowerCase()));
  writeFileSync(reportFile, [`Video library upload, ${new Date().toISOString()}`, '',
    `Same name as another video (skipped, ${duplicates.length}):`, ...duplicates, '', `Can't be used (${skipped.length + notPlayable.length}):`, ...skipped,
    ...notPlayable.map((f) => `${f.path}: phones can't play this format as it is; run without --no-convert`), ''].join('\n'));
  if (flags.has('--dry-run')) {
    for (const f of found.slice(0, 20)) log(`  ${f.name}${f.category ? `  [${f.category}]` : ''}  ${mb(f.size)}`);
    if (found.length > 20) log(`  … and ${(found.length - 20).toLocaleString()} more`);
    log(`Nothing was uploaded (--dry-run). The full list of skipped files is in ${reportFile}.`);
    return { found: found.length, uploaded: 0, duplicates: duplicates.length };
  }
  if (convert && !hasFfmpeg()) throw new Error('This needs ffmpeg to make the quick-loading copies. On a Mac: install Homebrew (brew.sh), then run  brew install ffmpeg  and try again.');
  const c = settings(env, resolve(cwd, 'video-upload.env'));
  if (!flags.has('--skip-check')) { log('Checking the storage…'); await checkPublic(c); log('Storage works.'); }

  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const saveState = () => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };
  const done = (f) => { const s = state[f.path]; return s && s.size === f.size && s.mtime === f.mtime && s.video_url; };
  const todo = found.filter((f) => !done(f) && (convert || AS_IS.has(extname(f.path).toLowerCase())));
  if (found.length - todo.length) log(`${(found.length - todo.length).toLocaleString()} already uploaded on an earlier run.`);
  const work = join(tmpdir(), `dp-videos-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const rows = () => found.filter(done).map((f) => ({ name: f.name, category: f.category, video_url: state[f.path].video_url, poster_url: state[f.path].poster_url }));
  const started = Date.now();
  let n = 0, failed = 0, sent = 0, stop = false;
  const failures = [];
  const one = async (f) => {
    const ext = extname(f.path).toLowerCase();
    const tmpVideo = join(work, `${n}-${Math.random().toString(36).slice(2)}.mp4`), tmpPoster = tmpVideo.replace(/\.mp4$/, '.jpg');
    try {
      let videoFile = f.path, poster = null;
      if (convert) {
        try { await run('ffmpeg', convertArgs(f.path, tmpVideo)); }
        catch (e) {
          if (!isCloudTimeout(e) || !(await localCopy(f.path, log))) throw e;
          await run('ffmpeg', convertArgs(f.path, tmpVideo));     // once more, now that the file is here
        }
        videoFile = tmpVideo;
        // The still from the first second, or the very start of a shorter clip; a video without one still goes up.
        for (const at of ['1', '0']) {
          await run('ffmpeg', posterArgs(tmpVideo, tmpPoster, at)).catch(() => {});
          if (existsSync(tmpPoster) && statSync(tmpPoster).size > 0) { poster = readFileSync(tmpPoster); break; }
        }
      } else if (f.size > MAX_AS_IS) throw new Error(`it's ${mb(f.size)}; without converting, files can be up to ${mb(MAX_AS_IS)} (run without --no-convert)`);
      const video = readFileSync(videoFile);
      const hash = createHash('sha256').update(video).digest('hex').slice(0, 10);
      const stem = `${c.prefix}${slug(f.name)}-${hash}`;
      const vExt = convert ? '.mp4' : ext;
      await put(c, `${stem}${vExt}`, video, TYPES[vExt]);
      if (poster) await put(c, `${stem}.jpg`, poster, 'image/jpeg');
      state[f.path] = { size: f.size, mtime: f.mtime, video_url: `${c.publicUrl}/${stem}${vExt}`, poster_url: poster ? `${c.publicUrl}/${stem}.jpg` : null };
      saveState();
      sent += video.length + (poster?.length ?? 0);
    } catch (e) {
      if (e.fatal) { stop = true; throw e; }
      failed++; failures.push(`${f.path}: ${e.message}`);
    } finally {
      rmSync(tmpVideo, { force: true }); rmSync(tmpPoster, { force: true });
      n++;
      const secs = (Date.now() - started) / 1000, left = todo.length - n;
      log(`[${n}/${todo.length}] ${f.name}${failed ? ` · ${failed} failed so far` : ''}${n >= 3 && left ? ` · about ${Math.ceil((secs / n) * left / 60)} min left` : ''}`);
      if (n % 25 === 0) writeCsv(outFile, rows());
    }
  };
  let next = 0, fatal = null;
  const finish = () => {
    writeCsv(outFile, rows());
    rmSync(work, { recursive: true, force: true });
    if (failures.length) writeFileSync(reportFile, `${readFileSync(reportFile, 'utf8')}\nFailed this run (run again to retry them, ${failures.length}):\n${failures.join('\n')}\n`);
    if (failures.some((x) => isCloudTimeout({ message: x }))) log(`Some videos couldn't be read from the Mac: they're kept in iCloud and didn't download in time. In Finder, right-click the folder → Download Now (or run: brctl download "<folder>"), wait for the cloud icons to disappear, then run the same command again.`);
  };
  // Ctrl+C: save the list so far and tidy up; the next run carries on.
  const onStop = () => { stop = true; try { finish(); } catch { /* best effort */ } log('\nStopped. Run the same command again to carry on.'); process.exit(130); };
  process.once('SIGINT', onStop);
  try {
    // Each worker finishes the video it's on before the run stops, so nothing is cut off halfway.
    await Promise.all(Array.from({ length: jobs }, async () => {
      while (!stop && next < todo.length) { try { await one(todo[next++]); } catch (e) { fatal ??= e; stop = true; } }
    }));
  } finally {
    process.removeListener('SIGINT', onStop);
    finish();
  }
  if (fatal) throw fatal;
  const ready = rows().length;
  log(`Done: ${ready.toLocaleString()} exercises in ${outFile} (${mb(sent)} uploaded this run).${failed ? ` ${failed} failed; run the same command again to retry them (details in ${reportFile}).` : ''}`);
  log('Next: in the app, Settings → Exercise library → Import a list, and choose that file.');
  return { found: found.length, uploaded: n - failed, failed, duplicates: duplicates.length, csv: outFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`\nStopped: ${e.message}`); process.exit(1); });
}
