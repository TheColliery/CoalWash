#!/usr/bin/env node
// CW-017 — LINK CHECK. Every internal relative link and heading anchor in this repo's own
// tracked Markdown must resolve on a CLONE, the way GitHub renders it.
//
// WHERE THIS FILE LIVES, and why it is not scripts/lib/: build-plugin.mjs copies
// scripts/lib/ into plugin/, and this checks THIS repo's docs — it has no business in the
// installed skill. scripts/ is where the room's other repo gates live (pointer-check.mjs,
// config-keys.mjs), none of which ship.
//
// ============================================================================
// THE SLUG RULE IS MEASURED, NOT GUESSED (CWK-098). Record:
// CoalWorks/warehouse/slug-oracle-2026-09.md, sha256
// 2a8acee03f15e28ff02c2ee37bc0f833954f4cf11fc9bdc14f9d5bd10450bf78 — 998 of 998 anchors
// reproduced against GitHub's own POST /markdown render. This engine was conformed to that
// record's scratch original (CoalHearth's slug-oracle.md, sha256
// ae1ff6aefddc05e758f9cf0d6f5384e59e0cb0697b83fb2ebbc4ac2e9b0b099a); the warehouse copy is that
// file byte-identical under a provenance comment line and a blank line. If the record is
// revised, its hash is how the drift shows.
//
// The rule, per clause — every one of these was WRONG in at least one sibling room:
//   step 0  resolve inline markup to rendered text (code span content kept, link/image text
//           kept, raw HTML tags removed, escapes and entities resolved, `_` emphasis removed)
//   step 1  lowercase EACH CODE POINT on its own ('Σ' -> 'σ' even word-final; 'İ' -> 'i'+U+0307)
//   step 2  delete every code point NOT in \p{Alphabetic} \p{M} \p{Nd} \p{Pc} \p{Join_Control},
//           U+0020 or U+002D. NOT \p{L} ('Ⓐ' is So yet Alphabetic, and stays); NOT \p{N}
//           ('²' '½' are No, and go). VS16 and ZWJ are Mn/Join_Control and STAY — no pre-strip.
//   step 3  each U+0020 -> one '-'. NO run collapse, NO trim ('A — B' -> 'a--b').
//   step 4  github-slugger's occurrence counter, with EVERY emitted slug registered — so a
//           literal "x 1" after "x", "x" gives "x-1-1", never a second "x-1".
// An empty slug is registered but never linkable (GitHub emits id="").
//
// DECLARED BOUNDS of step 0 — shapes the oracle did NOT measure, handled by CommonMark's own
// rule where cheap and NAMED here rather than trusted: autolinks, reference-style links in a
// heading, link text with brackets nested deeper than one level, multi-backtick code spans
// that hold backticks, emphasis edge cases beyond a single matched `_` pair, and named
// entities other than amp/lt/gt/quot/apos/nbsp (numeric entities are all decoded).
//
// ============================================================================
// WHAT IS SCANNED, AND WHAT IS NOT (bounds, each measured on this room's 11 in-scope docs
// on 2026-09-17 before it was chosen: 224 ATX headings, 9 internal and 36 external links,
// 1 autolink, 0 anchors of any kind, 0 reference definitions, 0 raw HTML links):
//   - ATX headings at the start of a line only. Setext headings are not read: 0 in scope
//     (the 3 candidate lines are YAML frontmatter closers). A heading inside a blockquote or
//     a list item is not read either: a link to one FAILs.
//   - YAML frontmatter at line 1 is skipped for headings AND links: GitHub renders it as a
//     table, not as Markdown.
//   - Fenced code blocks (CommonMark 4.5) and inline code spans are skipped. Indented code
//     blocks are NOT detected (telling one from a list continuation needs container
//     parsing): a link-shaped line inside one is checked, a loud false FAIL, never silent.
//   - A code span or link text that spans two lines is not seen as one.
//   - Checked: inline links and images, reference DEFINITIONS (their destination; an
//     undefined label is doc-structure's job, not this gate's), and href/src on raw <a>/<img>.
//   - Explicit HTML id/name anchors in a document are not collected: a link to one FAILs.
//
// HOW A FRAGMENT MATCHES — the HTML Standard's own "select the indicated part" (verified at
// html.spec.whatwg.org, browsing-the-web, 2026-09-17): the raw fragment first, then the
// percent-decoded fragment (UTF-8 decode without BOM), then an ASCII case-insensitive "top".
// Matching is otherwise CASE-SENSITIVE. GitHub emits non-ASCII anchors RAW (0 of 999 ids
// percent-encoded), so a raw link matches directly and a percent-encoded one matches on the
// decoded step. Unmeasured and NOT accepted: GitHub's own `#user-content-…` spelling.
//
// TARGETS: a destination with a URL scheme or starting `//` is external and skipped. A
// leading `/` resolves from the repo root. The target must be a TRACKED file or a tracked
// directory — present-but-untracked FAILs, because a clone does not have it. Tracked-ness
// is `git ls-files`: git absent (spawn ENOENT) degrades VISIBLY to existence-only; git
// present but failing is a FAIL (an unanswered probe is never read as clean).
// A fragment on a Markdown target is checked against that file's headings; on another file
// only GitHub's line-anchor shape (L12, L12-L20, L12C3) is accepted.
//
// EXIT: 1 on any finding, on no input files, or on an unreadable input. process.exitCode,
// never process.exit().

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BT = String.fromCharCode(96);
const ESC_BASE = 0xF0000;   // an escaped ASCII punctuation char, held as a private-use code point
const CODE_BASE = 0xF1000;  // an inline code span, held as ONE private-use code point (index)
const ESCAPABLE = /[!-\/:-@\[-`{-~]/;

// ---------------------------------------------------------------------------
// Inline tokenizing shared by the slug's step 0 and by link extraction: backslash escapes
// and code spans are resolved FIRST, because inside a code span nothing else applies and an
// escaped backtick or bracket opens nothing. Returns the masked string plus the spans.
// ---------------------------------------------------------------------------
function maskInline(line) {
  const spans = [];
  let out = '';
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && ESCAPABLE.test(line[i + 1])) {
      out += String.fromCodePoint(ESC_BASE + line.charCodeAt(i + 1));
      i += 2;
      continue;
    }
    if (c === BT) {
      let j = i;
      while (line[j] === BT) j++;
      const run = j - i;
      let k = j;
      let close = -1;
      while (k < line.length) {
        if (line[k] !== BT) { k++; continue; }
        let m = k;
        while (line[m] === BT) m++;
        if (m - k === run) { close = k; break; }
        k = m;
      }
      if (close === -1) { out += line.slice(i, j); i = j; continue; } // no matching run: literal backticks
      let body = line.slice(j, close);
      if (body.length > 2 && body[0] === ' ' && body[body.length - 1] === ' ' && body.trim() !== '') body = body.slice(1, -1);
      spans.push(body);
      out += String.fromCodePoint(CODE_BASE + spans.length - 1);
      i = close + run;
      continue;
    }
    out += c;
    i++;
  }
  return { masked: out, spans };
}
function unmask(s, spans) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= CODE_BASE && cp < CODE_BASE + spans.length) out += spans[cp - CODE_BASE];
    else if (cp >= ESC_BASE && cp < ESC_BASE + 0x80) out += String.fromCharCode(cp - ESC_BASE);
    else out += ch;
  }
  return out;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCodePoint(0xA0) };
function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : String.fromCodePoint(0xFFFD);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

// `_` emphasis: CommonMark's flanking rules decide which runs are delimiters; an intraword
// `_` is literal (and \p{Pc}, so it SURVIVES step 2). `*` needs no pass — it is punctuation
// and step 2 deletes it wherever it sits.
function stripUnderscoreEmphasis(s) {
  const cps = Array.from(s);
  const ws = (c) => c === undefined || /\s/u.test(c);
  const punct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
  const runs = [];
  for (let i = 0; i < cps.length;) {
    if (cps[i] !== '_') { i++; continue; }
    let j = i;
    while (cps[j] === '_') j++;
    const before = cps[i - 1];
    const after = cps[j];
    const left = !ws(after) && (!punct(after) || ws(before) || punct(before));
    const right = !ws(before) && (!punct(before) || ws(after) || punct(after));
    runs.push({ start: i, len: j - i, open: left && (!right || punct(before)), close: right && (!left || punct(after)) });
    i = j;
  }
  const drop = new Set();
  const openers = [];
  for (const r of runs) {
    if (r.close && openers.length) {
      const o = openers.pop();
      const n = Math.min(o.len, r.len);
      for (let x = 0; x < n; x++) { drop.add(o.start + o.len - 1 - x); drop.add(r.start + x); }
      continue;
    }
    if (r.open) openers.push(r);
  }
  return cps.filter((_, i) => !drop.has(i)).join('');
}

const LINK_TEXT = String.raw`((?:[^\[\]]|\[[^\[\]]*\])*)`;
const LINK_DEST = String.raw`(<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*)`;
const LINK_TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?`;
const INLINE_LINK = new RegExp(String.raw`(!?)\[` + LINK_TEXT + String.raw`\]\(\s*` + LINK_DEST + LINK_TITLE + String.raw`\s*\)`, 'g');

function renderInline(raw) {
  const { masked, spans } = maskInline(raw);
  let t = masked.replace(INLINE_LINK, (m, bang, text) => text);
  t = t.replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g, '$1');     // autolink (unmeasured): its URL is its text
  // ONE pass, on purpose (CodeQL #42, js/incomplete-multi-character-sanitization): GitHub strips a
  // raw tag once and keeps its inner text, so a loop would break oracle fidelity. `<<a>b>` can leave
  // a re-formed tag here, and that is safe: this text is never HTML. slugifyHeading's SLUG_DROP
  // deletes every `<` and `>`, and a slug is only ever a Map/Set key (HeadingAnchors, fragmentMatches).
  // Pinned by the test "CodeQL #42: no slug and no heading anchor ever contains < or >".
  t = t.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '');       // raw HTML tag: removed, inner text stays
  t = stripUnderscoreEmphasis(t);
  t = decodeEntities(t);                                                   // after emphasis: a decoded `_` is literal
  return unmask(t, spans);
}

const SLUG_DROP = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu;

// THE slug function (CWK-098). Takes the heading's raw Markdown source, returns the base slug
// before the occurrence counter.
export function slugifyHeading(rawHeading) {
  let lower = '';
  for (const ch of renderInline(String(rawHeading))) lower += ch.toLowerCase();
  return lower.replace(SLUG_DROP, '').replace(/ /g, '-');
}

// THE occurrence counter: github-slugger's shape, per document.
export class HeadingAnchors {
  constructor() { this.occurrences = new Map(); }
  next(slug) {
    let anchor = slug;
    while (this.occurrences.has(anchor)) {
      this.occurrences.set(slug, this.occurrences.get(slug) + 1);
      anchor = `${slug}-${this.occurrences.get(slug)}`;
    }
    this.occurrences.set(anchor, 0);
    return anchor;
  }
}

// ---------------------------------------------------------------------------
// Document structure: frontmatter and fenced code blocks, line by line.
// ---------------------------------------------------------------------------
function proseLines(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const out = [];
  let i = 0;
  if (/^---[ \t]*$/.test(lines[0] || '')) {
    const end = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === BT && open[2].includes(BT))) { fence = open[1]; continue; }
    out.push({ n: i + 1, line });
  }
  return out;
}

export function headingAnchors(text) {
  const counter = new HeadingAnchors();
  const linkable = new Set();
  for (const { line } of proseLines(text)) {
    const m = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!m) continue;
    let content = m[1] || '';
    if (/^#+$/.test(content)) content = '';
    else content = content.replace(/[ \t]+#+$/, '');
    const anchor = counter.next(slugifyHeading(content));
    if (anchor !== '') linkable.add(anchor);
  }
  return linkable;
}

const REF_DEF = /^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*(<[^<>\n]*>|\S+)/; // `[^1]: …` is a GFM footnote, not a link
const HTML_REF = /<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

export function extractLinks(text) {
  const links = [];
  for (const { n, line } of proseLines(text)) {
    const { masked, spans } = maskInline(line);
    for (const m of masked.matchAll(INLINE_LINK)) links.push({ line: n, dest: unmask(m[3], spans) });
    const def = REF_DEF.exec(masked);
    if (def) links.push({ line: n, dest: unmask(def[1], spans) });
    for (const m of masked.matchAll(HTML_REF)) links.push({ line: n, dest: unmask(m[1] ?? m[2], spans) });
  }
  return links;
}

// HTML Standard, "select the indicated part": percent-decode, then UTF-8 decode WITHOUT BOM.
function percentDecodeFragment(fragment) {
  const bytes = Buffer.from(fragment, 'utf8');
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x25 && i + 2 < bytes.length && /^[0-9a-fA-F]{2}$/.test(String.fromCharCode(bytes[i + 1], bytes[i + 2]))) {
      out.push(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
      i += 2;
    } else {
      out.push(bytes[i]);
    }
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(out));
}

export function fragmentMatches(fragment, anchors) {
  if (fragment === '' || anchors.has(fragment)) return true;
  const decoded = percentDecodeFragment(fragment);
  return anchors.has(decoded) || /^top$/i.test(decoded);
}

const LINE_ANCHOR = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/;
const MARKDOWN = /\.(md|markdown)$/i;

// root: absolute repo root. files: repo-relative POSIX paths to scan. tracked: Set of
// repo-relative tracked paths, or null for existence-only.
export function checkLinks({ root, files, tracked }) {
  const findings = [];
  let checked = 0;
  let external = 0;
  const trackedDirs = new Set();
  if (tracked) {
    for (const f of tracked) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'));
    }
  }
  const anchorCache = new Map();
  const anchorsOf = (rel) => {
    if (!anchorCache.has(rel)) {
      try { anchorCache.set(rel, headingAnchors(fs.readFileSync(path.join(root, rel), 'utf8'))); } catch { anchorCache.set(rel, null); }
    }
    return anchorCache.get(rel);
  };
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (e) {
      findings.push({ file, line: 0, msg: `cannot read this file (${e.code || e.message})` });
      continue;
    }
    for (const { line, dest } of extractLinks(text)) {
      const at = (msg) => findings.push({ file, line, msg: `link \`${dest}\` — ${msg}` });
      let d = dest.trim();
      if (d.startsWith('<') && d.endsWith('>')) d = d.slice(1, -1);
      if (d === '') continue; // an empty destination is the current document
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(d) || d.startsWith('//')) { external++; continue; }
      checked++;
      const hash = d.indexOf('#');
      const fragment = hash === -1 ? null : d.slice(hash + 1);
      let target = hash === -1 ? d : d.slice(0, hash);
      const query = target.indexOf('?');
      if (query !== -1) target = target.slice(0, query);
      let rel;
      let isDir;
      if (target === '') {
        rel = file; // the document being scanned: it was just read, so it exists
        isDir = false;
      } else {
        try { target = decodeURIComponent(target); } catch { at('its path has malformed percent-encoding'); continue; }
        const joined = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(file), target);
        rel = path.posix.normalize(joined).replace(/\/+$/, '');
        if (rel === '..' || rel.startsWith('../') || rel === '.') {
          if (rel !== '.') { at('leaves the repository'); continue; }
          rel = '';
        }
        if (rel === '') {
          isDir = true; // the repo root
        } else if (tracked) {
          if (tracked.has(rel)) isDir = false;
          else if (trackedDirs.has(rel)) isDir = true;
          else { at(fs.existsSync(path.join(root, rel)) ? 'exists here but is NOT TRACKED — a clone does not have it' : 'does not resolve in this repo'); continue; }
        } else {
          if (!fs.existsSync(path.join(root, rel))) { at('does not resolve in this repo'); continue; }
          isDir = fs.statSync(path.join(root, rel)).isDirectory();
        }
      }
      if (fragment === null || fragment === '') continue;
      if (isDir) { at('has an anchor on a directory, which this gate cannot check'); continue; }
      if (MARKDOWN.test(rel)) {
        const anchors = anchorsOf(rel);
        if (!anchors) { at('its target cannot be read for headings'); continue; }
        if (!fragmentMatches(fragment, anchors)) at(`no heading in ${rel} renders the anchor #${fragment}`);
      } else if (!LINE_ANCHOR.test(fragment)) {
        at(`#${fragment} is not a line anchor, and ${rel} is not Markdown`);
      }
    }
  }
  return { findings, checked, external, files: files.length };
}

function main(argv) {
  const root = process.cwd();
  const files = argv.map((f) => path.relative(root, path.resolve(root, f)).split(path.sep).join('/'));
  if (!files.length) {
    console.log('link-check: no files given — refusing to report a clean run over nothing');
    process.exitCode = 1;
    return;
  }
  let tracked = null;
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ls.error && ls.error.code === 'ENOENT') {
    console.log('  --   git not found: targets are checked for existence only, not for being tracked');
  } else if (ls.error || ls.status !== 0) {
    const why = ls.error ? ls.error.message : String(ls.stderr || '').split('\n')[0].trim();
    console.log(`FAIL git ls-files exited ${ls.error ? 'with a spawn error' : ls.status}${why ? ` — ${why}` : ''} — cannot tell a tracked target from an untracked one`);
    process.exitCode = 1;
    return;
  } else {
    tracked = new Set(ls.stdout.split('\0').filter(Boolean));
  }
  const r = checkLinks({ root, files, tracked });
  for (const f of r.findings) console.log(`FAIL ${f.file}:${f.line}: ${f.msg}`);
  console.log(`link-check: ${r.findings.length} finding(s) across ${r.files} file(s) — ${r.checked} internal link(s) checked, ${r.external} external skipped`);
  if (r.findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
