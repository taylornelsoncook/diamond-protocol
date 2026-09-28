// Reading a table out of a text-based PDF (an export from an app or a report printed to PDF), with no outside libraries.
// It finds the pages' text and where each piece sits, puts pieces on the same line into rows and splits a row into
// cells where there's a gap. The table is the run of lines with the most common number of cells; its first line is the
// header. Scanned or photographed pages have no text to read: those get a message to export a CSV or Excel file instead.
// Compressed streams (FlateDecode), compressed object streams (PDF 1.5+) and fonts with a ToUnicode map are supported.
import { inflateSync } from 'node:zlib';

// Limits, so an odd or hostile file can't tie up the server: decompressed bytes in all, map entries in all
// (font maps, widths, packed objects) and pieces of text.
const MAX_INFLATE = 32 * 1024 * 1024, MAX_ENTRIES = 500000, MAX_RUNS = 200000;
const TOO_BIG = 'This PDF is too large or complex to read. Export the data as a CSV or Excel file instead.';
let budget = null;
function spend(kind, n) {
  if (!budget) return;
  budget[kind] -= n;
  if (budget[kind] < 0) throw new Error(TOO_BIG);
}
const NO_TEXT = 'This PDF has no text we can read (it may be a scan or a photo). Export the data as a CSV or Excel file instead, or use a PDF made by the app itself.';

// ---------- Objects ----------
function parseObjects(buf) {
  const src = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    const body = src.slice(start, end);
    const si = body.search(/\bstream(\r\n|\n|\r)/);
    let dict = body, stream = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      const nl = body.slice(si).match(/^stream(\r\n|\n|\r)/)[0].length;
      const from = start + si + nl;
      const len = dict.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/);   // a reference (/Length 12 0 R): find endstream instead
      let to = len ? from + Number(len[1]) : src.lastIndexOf('endstream', end);
      if (!len) while (to > from && /[\r\n]/.test(src[to - 1])) to--;
      stream = buf.subarray(from, Math.min(to, end));
    }
    objs.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }
  // Objects packed in compressed object streams.
  for (const [, o] of [...objs]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = decode(o);
    if (!data) continue;
    const text = data.toString('latin1');
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] ?? 0), first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    const count = Math.min(n, Math.floor(nums.length / 2));
    spend('entries', count);
    for (let i = 0; i < count; i++) {
      const id = nums[i * 2], off = first + nums[i * 2 + 1], next = i + 1 < count ? first + nums[(i + 1) * 2 + 1] : text.length;
      if (!objs.has(id)) objs.set(id, { dict: text.slice(off, next), stream: null });
    }
  }
  return objs;
}
function decode(o) {
  if (!o?.stream) return null;
  if (!/\/Filter/.test(o.dict)) return Buffer.from(o.stream);
  if (!/\/FlateDecode/.test(o.dict) || /\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|LZWDecode|ASCII85Decode)/.test(o.dict)) return null;
  if (o.decoded !== undefined) return o.decoded;
  const max = budget ? Math.max(1, budget.inflate) : MAX_INFLATE;
  let out = null;
  try { out = inflateSync(o.stream, { maxOutputLength: max }); }
  catch (e) {
    if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new Error(TOO_BIG);
    try { out = inflateSync(o.stream, { finishFlush: 2, maxOutputLength: max }); }
    catch (e2) { if (e2?.code === 'ERR_BUFFER_TOO_LARGE' || e2 instanceof RangeError) throw new Error(TOO_BIG); out = null; }
  }
  if (out) spend('inflate', out.length);
  o.decoded = out;                                 // each stream is inflated (and counted) once
  return out;
}
const ref = (s) => { const m = String(s ?? '').match(/^\s*(\d+)\s+\d+\s+R/); return m ? Number(m[1]) : null; };
// The value after /Key in a dictionary: a reference, a <<dictionary>>, an [array] or a single token.
function entry(dict, key) {
  const i = dict.search(new RegExp(`/${key}(?![A-Za-z0-9])`));
  if (i < 0) return null;
  let s = dict.slice(i + key.length + 1).trimStart();
  if (/^\d+\s+\d+\s+R/.test(s)) return s.match(/^\d+\s+\d+\s+R/)[0];
  const open = s[0] === '<' && s[1] === '<' ? ['<<', '>>'] : s[0] === '[' ? ['[', ']'] : null;
  if (!open) return s.match(/^\/?[^\s/<>[\]()]+/)?.[0] ?? null;   // a number or /Name, not the >> after it
  let depth = 0;
  for (let j = 0; j < s.length; j++) {
    if (s.startsWith(open[0], j)) { depth++; j += open[0].length - 1; }
    else if (s.startsWith(open[1], j)) { depth--; j += open[1].length - 1; if (!depth) return s.slice(0, j + 1); }
  }
  return s;
}
const resolve = (objs, v) => { const r = ref(v); return r != null ? objs.get(r)?.dict ?? '' : v ?? ''; };

// ---------- Fonts: ToUnicode maps ----------
function hexToStr(hex) {
  if (hex.length <= 2) return hex ? String.fromCharCode(parseInt(hex, 16)) : '';
  let out = '';
  for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16));
  return out;
}
function parseCmap(text) {
  const map = new Map();
  let bytes = 1;
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { spend('entries', 1); map.set(parseInt(p[1], 16), hexToStr(p[2])); bytes = Math.max(bytes, p[1].length / 2); }
  }
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]*>)/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
      bytes = Math.max(bytes, p[1].length / 2);
      if (p[3][0] === '[') { [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((h, k) => { spend('entries', 1); map.set(lo + k, hexToStr(h[1])); }); continue; }
      const base = p[3].slice(1, -1);
      const start = parseInt(base.slice(-4), 16), prefix = hexToStr(base.slice(0, -4));
      spend('entries', Math.max(0, Math.min(hi - lo + 1, 65536)));
      for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, prefix + String.fromCharCode(start + c - lo));
    }
  }
  return { map, bytes };
}
function fontsOf(objs, pageDict, cache) {
  let res = entry(pageDict, 'Resources'), d = pageDict, guard = 0;
  while (!res && guard++ < 20) { const p = ref(entry(d, 'Parent')); if (p == null) break; d = objs.get(p)?.dict ?? ''; res = entry(d, 'Resources'); }
  const fontDict = resolve(objs, entry(resolve(objs, res ?? ''), 'Font') ?? '');
  const fonts = new Map();
  for (const f of String(fontDict).matchAll(/\/([^\s/<>[\]()]+)\s+(\d+\s+\d+\s+R)/g)) {
    const fid = ref(f[2]);
    if (cache.has(fid)) { fonts.set(f[1], cache.get(fid)); continue; }
    const fd = objs.get(fid)?.dict ?? '';
    const tu = ref(entry(fd, 'ToUnicode'));
    const cmap = tu != null ? decode(objs.get(tu)) : null;
    const font = { cmap: cmap ? parseCmap(cmap.toString('latin1')) : null, identity: /Identity-H/.test(fd), ...widthsOf(objs, fd) };
    cache.set(fid, font);                          // pages sharing a font read it once
    fonts.set(f[1], font);
  }
  return fonts;
}
// Glyph widths (thousandths of the font size), so we know where each piece of text ends and can tell a space between
// words from the gap between two columns. Simple fonts: /FirstChar and /Widths; composite fonts: the descendant's /W.
function widthsOf(objs, fd) {
  const widths = new Map();
  const nums = (s) => [...String(s ?? '').matchAll(/-?\d+(\.\d+)?/g)].map((x) => Number(x[0]));
  const w = entry(fd, 'Widths');
  if (w) {
    const first = Number(entry(fd, 'FirstChar') ?? 0);
    const list = nums(ref(w) != null ? objs.get(ref(w))?.dict : w);
    spend('entries', list.length);
    list.forEach((x, i) => widths.set(first + i, x));
    return { widths, dw: 500 };
  }
  const desc = entry(fd, 'DescendantFonts');
  const cid = resolve(objs, desc?.startsWith('[') ? desc.match(/\d+\s+\d+\s+R/)?.[0] : desc);
  if (!cid) return { widths, dw: 500 };
  const dw = Number(entry(cid, 'DW') ?? 1000);
  const W = entry(cid, 'W');
  const text = ref(W) != null ? objs.get(ref(W))?.dict ?? '' : W ?? '';
  // [c [w1 w2 ...] c1 c2 w ...]
  const toks = [...String(text).matchAll(/\[|\]|-?\d+(\.\d+)?/g)].map((x) => x[0]);
  let i = 1;                                       // skip the outer [
  while (i < toks.length - 1) {
    const c = Number(toks[i]);
    if (toks[i + 1] === '[') {
      let k = i + 2, n = 0;
      while (toks[k] !== ']' && k < toks.length) { spend('entries', 1); widths.set(c + n++, Number(toks[k++])); }
      i = k + 1;
    } else { const c2 = Number(toks[i + 1]), wv = Number(toks[i + 2]); spend('entries', Math.max(0, Math.min(c2 - c + 1, 65536))); for (let x = c; x <= c2 && x - c < 65536; x++) widths.set(x, wv); i += 3; }
  }
  return { widths, dw };
}
// The 14 standard fonts (Helvetica, Times...) carry no widths: close-enough Helvetica widths for Latin-1 text.
function standardWidth(c) {
  const ch = String.fromCharCode(c);
  if (ch === ' ' || /[.,:;!|'iIjl]/.test(ch)) return 278;
  if (/[0-9]/.test(ch)) return 556;
  if (ch === '-' || ch === '(' || ch === ')' || ch === 'f' || ch === 't' || ch === 'r') return 333;
  if (ch === '%' || ch === 'm' || ch === 'M' || ch === 'W' || ch === 'w') return 833;
  if (/[A-Z]/.test(ch)) return 667;
  return 556;
}
// The text a string shows, and how wide it is (in thousandths of the font size).
function showText(raw, font) {
  const two = font?.identity || (font?.cmap?.bytes ?? 1) >= 2;
  const n = two ? 2 : 1;
  let out = '', width = 0;
  for (let i = 0; i + n - 1 < raw.length; i += n) {
    const code = n === 2 ? (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1) : raw.charCodeAt(i);
    width += font?.widths?.get(code) ?? (font?.widths?.size ? font.dw : standardWidth(code));
    if (font?.cmap?.map.size) out += font.cmap.map.get(code) ?? '';
    else if (!font?.identity) out += String.fromCharCode(code);   // simple fonts: the bytes are (close enough to) Latin-1 text
  }
  return { text: out, width };
}

// ---------- Content streams ----------
function tokenize(s) {
  const out = [];
  let i = 0;
  const ws = /[\s\0]/;
  while (i < s.length) {
    const c = s[i];
    if (ws.test(c)) { i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '(') {
      let depth = 1, str = ''; i++;
      while (i < s.length && depth) {
        const ch = s[i];
        if (ch === '\\') {
          const nx = s[i + 1];
          const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[nx];
          if (esc !== undefined) { str += esc; i += 2; }
          else if (/[0-7]/.test(nx)) { const o = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0]; str += String.fromCharCode(parseInt(o, 8)); i += 1 + o.length; }
          else if (nx === '\r' || nx === '\n') { i += nx === '\r' && s[i + 2] === '\n' ? 3 : 2; }
          else { i += 2; }
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) { i++; break; } }
        str += ch; i++;
      }
      out.push({ t: 'str', v: str }); continue;
    }
    if (c === '<' && s[i + 1] === '<') { out.push({ t: 'op', v: '<<' }); i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') { out.push({ t: 'op', v: '>>' }); i += 2; continue; }
    if (c === '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/\s/g, '');
      let str = '';
      for (let k = 0; k < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      out.push({ t: 'str', v: str }); i = end < 0 ? s.length : end + 1; continue;
    }
    if (c === '[' || c === ']') { out.push({ t: c }); i++; continue; }
    if (c === '/') { const m = s.slice(i + 1).match(/^[^\s/<>[\]()%{}]*/)[0]; out.push({ t: 'name', v: m }); i += 1 + m.length; continue; }
    const m = s.slice(i).match(/^[^\s/<>[\]()%{}]+/);
    if (!m) { i++; continue; }
    const w = m[0]; i += w.length;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) out.push({ t: 'num', v: Number(w) }); else out.push({ t: 'op', v: w });
  }
  return out;
}
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
function runsOf(content, fonts, page) {
  const toks = tokenize(content);
  const runs = [];
  let stack = [], ctm = [1, 0, 0, 1, 0, 0], saved = [], tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], font = null, size = 10, leading = 0, arr = null;
  const advance = (units) => { tm = mul([1, 0, 0, 1, (units / 1000) * size, 0], tm); };
  // Draws a string at the current point and moves past it. Text the font can't turn into characters moves the point only.
  const place = (shown) => {
    if (!shown.width && !shown.text) return;
    const m = mul(tm, ctm), scale = Math.hypot(m[0], m[1]) || 1;
    const fs = size * scale;
    if (shown.text) runs.push({ page, x: m[4], y: m[5], text: shown.text, size: fs, w: (shown.width / 1000) * fs });
    advance(shown.width);
  };
  for (const tk of toks) {
    if (tk.t === '[') { arr = []; continue; }
    if (tk.t === ']') { stack.push({ t: 'arr', v: arr ?? [] }); arr = null; continue; }
    if (arr) { arr.push(tk); continue; }
    if (tk.t !== 'op') { stack.push(tk); continue; }
    const n = stack.map((x) => x.v);
    switch (tk.v) {
      case 'q': saved.push(ctm); break;
      case 'Q': ctm = saved.pop() ?? ctm; break;
      case 'cm': if (n.length >= 6) ctm = mul(n.slice(-6).map(Number), ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case 'Tf': font = fonts.get(stack.at(-2)?.v) ?? null; size = Number(n.at(-1)) || size; break;
      case 'TL': leading = Number(n.at(-1)) || 0; break;
      case 'Tm': if (n.length >= 6) { tm = n.slice(-6).map(Number); tlm = tm; } break;
      case 'Td': tlm = mul([1, 0, 0, 1, Number(n.at(-2)) || 0, Number(n.at(-1)) || 0], tlm); tm = tlm; break;
      case 'TD': leading = -(Number(n.at(-1)) || 0); tlm = mul([1, 0, 0, 1, Number(n.at(-2)) || 0, Number(n.at(-1)) || 0], tlm); tm = tlm; break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
      case 'Tj': place(showText(stack.at(-1)?.v ?? '', font)); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; place(showText(stack.at(-1)?.v ?? '', font)); break;
      case '"': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; place(showText(stack.at(-1)?.v ?? '', font)); break;
      case 'TJ': {
        // Strings with spacing between them (in thousandths of the font size; negative moves right). A big move is a
        // space between words or a gap between columns, so the pieces are placed where they fall.
        for (const part of stack.at(-1)?.v ?? []) {
          if (part.t === 'str') place(showText(part.v, font));
          else if (part.t === 'num') advance(-part.v);
        }
        break;
      }
      default: break;
    }
    stack = [];
  }
  return runs;
}

// ---------- Lines, cells and the table ----------
const readable = (t) => t.replace(/[^\x20-\x7e -￿]/g, '').trim();
function linesOf(runs) {
  const lines = [];
  const byPage = new Map();
  for (const r of runs) { const t = r.text.replace(/\s+/g, ' '); if (!t.trim()) continue; (byPage.get(r.page) ?? byPage.set(r.page, []).get(r.page)).push({ ...r, text: t }); }
  for (const [page, rs] of [...byPage].sort((a, b) => a[0] - b[0])) {
    rs.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const r of rs) {
      // Sorted top to bottom, so the only row close enough is the last one started.
      const last = rows.at(-1);
      const row = last && Math.abs(last.y - r.y) <= Math.max(2, r.size * 0.4) ? last : null;
      if (row) row.runs.push(r); else rows.push({ y: r.y, runs: [r] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.runs.sort((a, b) => a.x - b.x);
      const cells = [];
      let last = null;
      for (const r of row.runs) {
        const gap = last ? r.x - (last.x + last.w) : Infinity;
        // A space is about 0.28 of the font size; columns sit further apart.
        if (last && gap < r.size * 0.55) { cells[cells.length - 1].text += (gap > r.size * 0.15 && !/\s$/.test(cells.at(-1).text) ? ' ' : '') + r.text; cells[cells.length - 1].end = r.x + r.w; }
        else cells.push({ text: r.text, x: r.x, end: r.x + r.w });
        last = { x: r.x, w: r.w };
      }
      lines.push({ page, cells: cells.map((c) => readable(c.text)).filter((c) => c !== '') });
    }
  }
  return lines;
}
export function pdfTable(buf) {
  const { lines, pages } = pdfLines(buf);
  if (!lines.length) throw new Error(NO_TEXT);
  // The table: the most common number of cells (2 or more) among the lines; its first line is the header.
  const counts = new Map();
  for (const l of lines) if (l.cells.length >= 2) counts.set(l.cells.length, (counts.get(l.cells.length) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (!best || best[1] < 2) throw new Error('We found text in this PDF but no table (rows with the same columns). Export the data as a CSV or Excel file instead.');
  const width = best[0];
  const tableLines = lines.filter((l) => l.cells.length === width);
  const headers = tableLines[0].cells.map((h, i) => h || `Column ${i + 1}`);
  const key = headers.join('\u0001');
  const rows = tableLines.slice(1).filter((l) => l.cells.join('\u0001') !== key)   // a header repeated on each page
    .map((l) => Object.fromEntries(headers.map((h, i) => [h, l.cells[i] ?? ''])));
  if (!rows.length) throw new Error('We found a header row in this PDF but no rows under it. Export the data as a CSV or Excel file instead.');
  return { headers, rows, ignored_lines: lines.length - tableLines.length, pages };
}
// Every line of text on every page, split into cells.
export function pdfLines(buf) {
  budget = { inflate: MAX_INFLATE, entries: MAX_ENTRIES };
  try { return readLines(buf); } finally { budget = null; }
}
function readLines(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 1024).toString('latin1').includes('%PDF')) throw new Error('That file isn\'t a PDF. Choose the PDF again, or export a CSV or Excel file.');
  if (/\/Encrypt\b/.test(buf.toString('latin1'))) throw new Error('This PDF is password-protected. Save a copy without a password, or export a CSV or Excel file.');
  const objs = parseObjects(buf);
  const pageIds = [...objs].filter(([, o]) => /\/Type\s*\/Page(?![s\w])/.test(o.dict)).map(([id]) => id);
  // Page order: as listed in the page tree's Kids, when we can follow it; otherwise object order.
  const order = [];
  const walk = (id, depth = 0) => {
    const d = objs.get(id)?.dict ?? '';
    if (/\/Type\s*\/Page(?![s\w])/.test(d)) { if (!order.includes(id)) order.push(id); return; }
    if (depth > 30) return;
    for (const k of String(entry(d, 'Kids') ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  const root = [...objs].find(([, o]) => /\/Type\s*\/Pages/.test(o.dict) && !/\/Parent\s/.test(o.dict));
  if (root) walk(root[0]);
  for (const id of pageIds) if (!order.includes(id)) order.push(id);
  const runs = [], fontCache = new Map();
  order.forEach((id, pageNo) => {
    const d = objs.get(id).dict;
    const c = entry(d, 'Contents');
    const ids = c?.startsWith('[') ? [...c.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1])) : [ref(c)].filter((x) => x != null);
    const content = ids.map((x) => decode(objs.get(x))?.toString('latin1') ?? '').join('\n');
    for (const r of runsOf(content, fontsOf(objs, d, fontCache), pageNo)) {
      if (runs.length >= MAX_RUNS) throw new Error(TOO_BIG);
      runs.push(r);
    }
  });
  return { lines: linesOf(runs).filter((l) => l.cells.length), pages: order.length };
}
