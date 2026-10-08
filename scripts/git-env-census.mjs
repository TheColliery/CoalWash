// ponytail: 646 lines at declaration -- the lexer, the call locator and the grammar judge one shape (the env a git spawn takes) and
// share one lexed view per file; split apart they would each re-lex the file and drift on what "the same text" means.
// CWK-136 -- a textual census: does every git spawn under scripts/ take an env the census can READ as safe?
// CWK-133 gave every fixture and gate one helper (scripts/git-env.mjs); nothing stopped the NEXT spawn from inheriting whatever
// GIT_DIR / GIT_INDEX_FILE a linked worktree's hook exports. This is the gate that says so.
//
// THE ACCEPTED GRAMMAR (08d, UMB-456 (2), the witness list U/scratchpad/dispatch/08d-census-witness-list.md). A git spawn's env
// PASSES only as one of four shapes; ANYTHING else is a FINDING (counted in `refused`), never an unverified pass:
//   (i)   a direct call `gitEnv(...)` where gitEnv is the room helper: a static `import { gitEnv } from './git-env.mjs'` (or
//         '../git-env.mjs'), or a `const { gitEnv } = await import(... 'git-env.mjs' ...)` whose block holds the spawn; no other
//         binding of the name in the file, and no `process.env` in the call (counted `viaHelper`);
//   (ii)  a variable whose nearest `const` in scope is built as `gitEnv(...)` (as (i), `viaHelper`) or as an ALLOWLIST LITERAL
//         (`allowlist`), declared in the spawn's own function, and whose name appears nowhere else in its block but as a git
//         spawn's env: a member write, an alias, a method call, an argument, a loop write or a shadowing declaration is a finding;
//   (iii) a call to a SAME-FILE helper (`const name = (...) => ({ ... })`, or `function name(...) { return { ... }; }`) whose body
//         is ONE return of an allowlist literal and whose name is only ever called (`allowlist`). A same-file function NAMED gitEnv
//         or gitTestEnv is judged here like any other helper: the name is never trusted;
//   (iv)  an allowlist literal written in the call (`allowlist`).
// AN ALLOWLIST LITERAL is one object literal the census reads WHOLE: no nested `{`, no computed key, no `__proto__` key (a spawned
// child inherits its properties) and no key written with an escape (`'GIT\x5fDIR'` is GIT_DIR); every spread is either
// `...Object.fromEntries(L.filter(F).map((k) => [k, process.env[k]]))` (the filter optional, nothing after the final `)`, L a
// `const` array of string literals without escapes or such an array written in place, F `Boolean` or an arrow with no call in it) or `...name`
// with `name` a `const` that is itself such a literal or such a fromEntries (one level); `process` is read only as
// `process.env.NAME`, `process.env[name]` or another member of process; `GIT_CONFIG_NOSYSTEM: '1'` is a key of the literal itself and
// the ONLY GIT_CONFIG_NOSYSTEM in it, its spreads and its key lists (a second one could override it); and no GIT_* name (matched
// case-insensitively, as Windows reads env names) appears in it, its spreads or its key lists except GIT_CONFIG_NOSYSTEM,
// GIT_TERMINAL_PROMPT and GIT_CEILING_DIRECTORIES. A followed const (a key list, a spread) is used nowhere in its block but inside
// the literal that reads it. The spawn's options object holds no spread and one `env` only.
//
// THE LEXER. Every file is read once into a view where comments, string and template-literal text and regex bodies are blank (their
// delimiters kept), so a quote inside a regex or a template cannot open a string the scanner never closes (F41). Template `${...}`
// is read as code. A call or a declaration inside a comment, a string or a template's text is not code and is not seen.
//
// NAMED LIMITS, because a textual gate is a tripwire and never a proof:
//   - the lexer GUESSES at a `/` in two places: after a `)` it reads a division unless the `)` closes an if / while / for / with
//     head, and after a `}` it reads a regex (a block ended there; after an object literal it would be a division). A wrong guess can
//     hide text, so the grammar refuses where a guess could decide: an allowlist literal or helper body that holds a division, a
//     template literal or a regex with a quote in it, and a followed const whose block holds a regex right after a `}`.
//   - a function boundary is seen at `function` and `=>`; a method shorthand (`run() { ... }`) or a class method is not, so a const
//     declared outside one can pass the same-function test. The usage rule still reads the whole block the const lives in.
//   - the dynamic binding of (i) is trusted by the string 'git-env.mjs' in its import argument; the directory it is joined to is
//     not read.
//   - code the census cannot read as text (`eval`, `new Function`, a `with` block) is not modelled.
//   - FOUR BYPASSES of the call LOCATOR, named rather than widened, and pinned by a test so this list cannot rot (a widening turns
//     that test red, and the fix is to move the item off this list): (1) a command that is not a literal (`spawnSync(GIT, ...)`;
//     git-env.test.mjs uses that on purpose for its one hostile-env control leg); (2) a renamed import (`import { spawnSync as run }`
//     then `run('git', ...)`); (3) a shell that runs git (`spawnSync('sh', ['-c', 'git status'])`); (4) a command string that quotes
//     git's path (`execSync('"C:/Program Files/Git/bin/git.exe" status')`). A spawn written any of these ways is not counted at all.
//     The locator DOES count spawnSync, execFileSync, spawn, execFile, execSync and the async exec, a template-literal command, and
//     `git` given as `git.exe` or as an absolute path.
// The gate PRINTS its coverage (files, calls, per-class counts) because a locator that matches nothing reports clean.
//
// censusGitSpawns() is pure (a { rel, text } list in, a report out) so it is unit-tested directly, red-first; collectScriptsMjs()
// is the filesystem walk, kept apart so the pure function never touches disk. Exemplar: CoalTipple scripts/lib/git-env-census.mjs.
// Divergences: it lives in scripts/ (dev tooling, never in the dist), it covers spawn / execFile / execSync / exec, it judges the
// env against the grammar above instead of trusting a helper's name, and it returns coverage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// CWK-174: BLOB-PINNED EXEMPTIONS for files carried BYTE-EQUAL from a source, which cannot be edited here without breaking the org's
// parity check. Each path is exempt ONLY while the git blob id of its content equals the id pinned below (`git hash-object
// --no-filters`): an edit, a re-sync that moves the blob, or the same bytes at another path is a finding again. A named, room-local
// divergence: DELETE an entry the day its source carries an env this grammar reads and the carrier is re-copied. The report lists
// what it exempted (`exempted`), and every entry must hide a finding (git-env-census.test.mjs refuses an inert pin). What each hides:
//   - scripts/secret-scan.test.mjs (Bankfire, the scanner source): its file-local gitEnv() strips GIT_* from a WHOLE copy of
//     process.env and sets GIT_CONFIG_GLOBAL (not one of the three names), and its decoy read takes `cleanEnv`, the same strip with
//     no GIT_CONFIG_NOSYSTEM.
//   - scripts/secret-gate.mjs (the .github canon): its file-local gitEnv() strips GIT_* from a whole copy of process.env and KEEPS
//     GIT_INDEX_FILE, which the pre-commit scan of the staged set needs.
//   - scripts/secret-gate.test.mjs (the .github canon): its file-local gitEnv() strips GIT_* from a whole copy of process.env and
//     sets GIT_CONFIG_GLOBAL, and one spawn spreads a caller's `extra` over it.
//   - scripts/release-notes.test.mjs (the .github overlay, blob 8cf7e5fd): its sandboxEnv() spreads the caller's `extra`.
// The findings, quoted, are in git-env-census.test.mjs's CARRIERS table.
export const EXEMPT_CARRIERS = Object.freeze({
  'scripts/release-notes.test.mjs': '8cf7e5fd58b89d051395efc53cc0a4f6c86848da',
  'scripts/secret-gate.mjs': '044ec4464e83895f1a988198c93b73300652bdf2',
  'scripts/secret-gate.test.mjs': 'a17ae233275c05c6d030f7aa7f0654002b310356',
  'scripts/secret-scan.test.mjs': '4433fb56bc97d1facc3fb27804e1934c0577115f',
});

// The git blob id of a text read as UTF-8 (a carrier is valid UTF-8, so the re-encode is byte-exact): sha1 of "blob <bytes>\0" + bytes.
export function gitBlobId(text) {
  const bytes = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^}';
const CONTROL_HEAD = new Set(['if', 'while', 'for', 'with']); // a `/` after the `)` of one of these heads starts a regex
const WORD = /[\w$]/;
const SPACE = /\s/;

// ponytail: 68 lines at declaration -- one state machine; the template and regex branches share its cursor and brace depth.
// One pass over a file: `code` blanks comments, string and template text and regex bodies (delimiters and newlines kept); `sv` blanks
// only comments and regex bodies, so string text stays readable for the GIT_* name scan. Also returns where every regex literal,
// every `/` read as a division and every template literal starts, for the refusals where the lexer has to guess.
export function lex(text) {
  const n = text.length;
  const code = text.split('');
  const sv = text.split('');
  const regexes = [];
  const divisions = [];
  const templates = [];
  const blank = (arr, a, b) => { for (let k = a; k < b && k < n; k++) if (text[k] !== '\n' && text[k] !== '\r') arr[k] = ' '; };
  const tpl = []; // the brace depth each open `${` closes at
  let depth = 0;
  let prev = ''; // the last significant character read as code; 'a' after a word, a number, a string or a regex
  let word = '';
  let ctrl = false; // the last `)` closed an if / while / for / with head
  const parens = [];
  let i = text.startsWith('#!') ? text.indexOf('\n') : 0; // a shebang line is not code
  if (i === -1) i = n;
  else if (i > 0) blank(code, 0, i);
  const templateText = () => { // a template's text from i to its closing backtick, or to a `${` (then the expression is code)
    for (; i < n; i++) {
      if (text[i] === '\\') { blank(code, i, i + 2); i++; continue; }
      if (text[i] === '`') { i++; prev = 'a'; word = ''; return; }
      if (text[i] === '$' && text[i + 1] === '{') { blank(code, i, i + 1); i += 2; tpl.push(depth); depth++; prev = '{'; word = ''; return; }
      blank(code, i, i + 1);
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e === -1 ? n : e; blank(code, i, end); blank(sv, i, end); i = end; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; blank(code, i, end); blank(sv, i, end); i = end; continue; }
    if (c === '\'' || c === '"') { // a string ends at its quote, or at the end of its line (where JS refuses it)
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
      blank(code, i + 1, k);
      i = k + 1; prev = 'a'; word = ''; continue;
    }
    if (c === '`') { templates.push(i); i++; templateText(); continue; }
    if (c === '/') {
      if (prev === '' || REGEX_AFTER_CHAR.includes(prev) || REGEX_AFTER_WORD.has(word) || (prev === ')' && ctrl)) {
        let k = i + 1;
        let cls = false;
        while (k < n && text[k] !== '\n' && (cls || text[k] !== '/')) {
          if (text[k] === '\\') k++;
          else if (text[k] === '[') cls = true;
          else if (text[k] === ']') cls = false;
          k++;
        }
        if (text[k] === '/') {
          let f = k + 1;
          while (f < n && /[A-Za-z]/.test(text[f])) f++;
          regexes.push({ at: i, body: text.slice(i + 1, k), afterBrace: prev === '}' });
          blank(code, i + 1, k); blank(sv, i + 1, k); blank(code, k + 1, f); blank(sv, k + 1, f);
          i = f; prev = 'a'; word = ''; continue;
        }
      }
      divisions.push(i); prev = '/'; word = ''; i++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (tpl.length && depth === tpl[tpl.length - 1]) { tpl.pop(); i++; templateText(); continue; }
    }
    if (WORD.test(c)) { let k = i; while (k < n && WORD.test(text[k])) k++; word = text.slice(i, k); prev = 'a'; i = k; continue; }
    if (c === '(') parens.push(prev === 'a' && CONTROL_HEAD.has(word));
    if (!SPACE.test(c)) { ctrl = c === ')' && parens.pop() === true; prev = c; word = ''; }
    i++;
  }
  return { text, code: code.join(''), sv: sv.join(''), regexes, divisions, templates };
}

const skipWs = (s, i) => { while (i < s.length && SPACE.test(s[i])) i++; return i; };
const backWs = (s, i) => { while (i >= 0 && SPACE.test(s[i])) i--; return i; };
const esc = (name) => name.replace(/\$/g, '\\$');
const lineOf = (text, i) => text.slice(0, i).split('\n').length;
const cut = (s) => { const one = s.trim().replace(/\s+/g, ' '); return one.length > 60 ? `${one.slice(0, 57)}...` : one; }; // source text quoted in a finding

// The index of the bracket that closes the one at `open` (round, square and curly counted together), -1 when unbalanced.
function closeOf(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; if (depth < 0) return -1; }
  }
  return -1;
}

// Where an expression that starts at `from` ends: the first `,` or `;` at depth 0, or the closer of the bracket around it.
function exprEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if ((c === ',' || c === ';') && depth === 0) return i;
  }
  return code.length;
}

// The items of [a, b) split at commas at depth 0, each trimmed: [start, end) pairs.
function splitTop(code, a, b) {
  const parts = [];
  let depth = 0;
  let from = a;
  for (let i = a; i < b; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push([from, i]); from = i + 1; }
  }
  parts.push([from, b]);
  return parts.map(([s, e]) => { const s2 = skipWs(code, s); let e2 = e; while (e2 > s2 && SPACE.test(code[e2 - 1])) e2--; return [s2, e2]; }).filter(([s, e]) => e > s);
}

// The block that holds index `at`: [after its `{`, its `}`), or the whole file at module level.
function blockOf(code, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] === '}') depth++;
    else if (code[i] === '{') {
      if (depth === 0) { const close = closeOf(code, i); return [i + 1, close === -1 ? code.length : close]; }
      depth--;
    }
  }
  return [0, code.length];
}

// The nearest `const <name> = ...` before `before` whose block still holds `before`, or null.
function findConst(lx, name, before) {
  const re = new RegExp(`(?<![\\w$.])const\\s+${esc(name)}\\s*=(?![=>])`, 'g');
  let found = null;
  for (let m; (m = re.exec(lx.code)) && m.index < before;) {
    const block = blockOf(lx.code, m.index);
    if (block[0] <= before && before <= block[1]) {
      const init = skipWs(lx.code, m.index + m[0].length);
      found = { at: m.index, init, initEnd: exprEnd(lx.code, init), block };
    }
  }
  return found;
}

// Every reference to `name` in [a, b): a member name (`x.name`) and an object key (`{ name: ...`) are not references.
function references(code, name, a, b) {
  const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'g');
  re.lastIndex = a;
  const out = [];
  for (let m; (m = re.exec(code)) && m.index < b;) {
    const i = m.index;
    if (code[i - 1] === '.' && code.slice(i - 3, i) !== '...') continue;
    const after = skipWs(code, i + name.length);
    const before = backWs(code, i - 1);
    if (code[after] === ':' && (code[before] === '{' || code[before] === ',')) continue;
    out.push(i);
  }
  return out;
}

// A reference to a declared const anywhere in its block but in its own declaration and the spans `allowed` (start indexes, or [a, b) pairs).
function strayReference(lx, name, decl, allowed) {
  const refs = [...references(lx.code, name, decl.block[0], decl.at), ...references(lx.code, name, decl.initEnd, decl.block[1])];
  return refs.find((i) => !allowed.some((x) => (Array.isArray(x) ? x[0] <= i && i < x[1] : x === i)));
}

// Does a function that opens after `from` hold `to`? (`function ... {}` and arrows; a method shorthand is a named limit)
function functionBetween(code, from, to) {
  const re = /(?<![\w$])function(?![\w$])|=>/g;
  re.lastIndex = from;
  for (let m; (m = re.exec(code)) && m.index < to;) {
    let start = skipWs(code, m.index + 2);
    let end;
    if (m[0] === 'function') {
      const open = code.indexOf('(', m.index);
      const params = open === -1 ? -1 : closeOf(code, open);
      start = params === -1 ? -1 : skipWs(code, params + 1);
      if (start === -1 || code[start] !== '{') continue;
      end = closeOf(code, start);
    } else end = code[start] === '{' ? closeOf(code, start) : exprEnd(code, start);
    if (end === -1 || (start <= to && to <= end)) return true;
  }
  return false;
}

// Where the lexer had to guess inside [a, b): a regex right after `}` (a block ends there; after an object literal it would be a division).
function guessRisk(lx, a, b) {
  const r = lx.regexes.find((x) => x.at >= a && x.at < b && x.afterBrace);
  return r ? `a regex at line ${lineOf(lx.text, r.at)} follows a '}' (it could be a division)` : null;
}

const ALLOWED_GIT_KEYS = new Set(['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_CEILING_DIRECTORIES']);
const NAME = /^[A-Za-z_$][\w$]*$/;
const PICK_MAP = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\[\s*\1\s*,\s*process\s*\.\s*env\s*\[\s*\1\s*\]\s*\]$/;
const FILTER_WORDS = new Set(['process', 'env', 'undefined', 'null', 'in', 'typeof', 'true', 'false']);

// A followed const: found before `at`, used nowhere in its block but inside [useS, useE), and its block free of a lexer guess.
function followConst(lx, name, at, useS, useE) {
  const decl = findConst(lx, name, at);
  if (!decl) return { why: `'${name}' is no const the census can read here` };
  const stray = strayReference(lx, name, decl, [[useS, useE]]);
  if (stray !== undefined) return { why: `'${name}' is used at line ${lineOf(lx.text, stray)}, outside the expression that reads it` };
  const guess = guessRisk(lx, decl.block[0], decl.block[1]);
  return guess ? { why: `the block of '${name}' is unsafe to read: ${guess}` } : { decl };
}

// A key list: an array literal of string literals only. Returns { names, range } or { why }.
function keyList(lx, open) {
  const close = closeOf(lx.code, open);
  if (close === -1) return { why: 'an unbalanced key list' };
  const names = [];
  for (const [s, e] of splitTop(lx.code, open + 1, close)) {
    const raw = lx.text.slice(s, e);
    if (!/^(['"])[^'"\\\n]*\1$/.test(raw)) return { why: `the key list holds ${cut(raw)}, not a string literal without escapes` };
    names.push(raw.slice(1, -1));
  }
  return { names, range: [open, close + 1] };
}

// `Object.fromEntries(...)` at [a, b) (a at `Object`): L.filter(F).map((k) => [k, process.env[k]]) and nothing after. { names, ranges } or { why }.
function pick(lx, a, b) {
  const { code } = lx;
  const head = /^Object\s*\.\s*fromEntries\s*\(/.exec(code.slice(a, b));
  if (!head || closeOf(code, a + head[0].length - 1) !== b - 1) return { why: `it spreads ${cut(lx.text.slice(a, b))}` };
  let i = skipWs(code, a + head[0].length);
  const end = b - 1;
  let list;
  if (code[i] === '[') { list = keyList(lx, i); if (list.why) return list; i = list.range[1]; }
  else {
    const w = /^[A-Za-z_$][\w$]*(?=\s*\.\s*(?:filter|map)\s*\()/.exec(code.slice(i, end));
    if (!w) return { why: `its fromEntries reads ${cut(lx.text.slice(i, end))}, not a named key list` };
    const f = followConst(lx, w[0], a, a, b);
    if (f.why) return f;
    const init = skipWs(code, f.decl.init);
    if (code[init] !== '[' || closeOf(code, init) !== backWs(code, f.decl.initEnd - 1)) return { why: `'${w[0]}' is not an array literal of string literals` };
    list = keyList(lx, init);
    if (list.why) return list;
    i += w[0].length;
  }
  const step = (method) => {
    const m = new RegExp(`^\\s*\\.\\s*${method}\\s*\\(`).exec(code.slice(i, end));
    if (!m) return null;
    const open = i + m[0].length - 1;
    const close = closeOf(code, open);
    if (close === -1 || close >= end) return null;
    i = close + 1;
    return [open + 1, close];
  };
  const filter = step('filter');
  if (filter) {
    const f = code.slice(filter[0], filter[1]).trim();
    const arrow = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>([\s\S]*)$/.exec(f);
    if (!(f === 'Boolean' || (arrow && !arrow[2].includes('(')
      && [...arrow[2].matchAll(/[A-Za-z_$][\w$]*/g)].every((x) => x[0] === arrow[1] || FILTER_WORDS.has(x[0]))
      && [...arrow[2].matchAll(/(?<![\w$.])process(?![\w$])/g)].every((x) => /^\s*\.\s*env(?![\w$])/.test(arrow[2].slice(x.index + 7)))))) {
      return { why: `its filter ${cut(lx.text.slice(filter[0], filter[1]))} is not Boolean or a call-free arrow over the key` };
    }
  }
  const map = step('map');
  if (!map || !PICK_MAP.test(code.slice(map[0], map[1]).trim())) return { why: 'its fromEntries does not end in .map((k) => [k, process.env[k]])' };
  if (code.slice(i, end).trim()) return { why: `its fromEntries goes on after the map: ${cut(lx.text.slice(i, end))}` };
  return { names: list.names, ranges: [list.range] };
}

// `process` in [a, b) read only as a member (process.platform, process.env.NAME, process.env[name]); null, or the reason it is not.
function processWhole(lx, a, b) {
  const seg = lx.code.slice(a, b);
  for (const m of seg.matchAll(/(?<![\w$.])process(?![\w$])/g)) {
    const rest = seg.slice(m.index + 7);
    const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (!member) return 'it reads process other than through a member';
    if (member[1] === 'env' && !/^\s*(?:\.\s*[A-Za-z_$]|\[\s*[A-Za-z_$][\w$]*\s*\]|\[\s*(['"])[^'"]*\1\s*\])/.test(rest.slice(member[0].length))) {
      return 'it takes process.env as a whole object';
    }
  }
  return null;
}

// ponytail: 67 lines at declaration -- the literal's members, its spreads and its three name rules are read in one walk.
// Judge the object literal at [s, e) (s at `{`, e after `}`): { cls: 'allowlist' } or { why }. `level` 1 is a followed spread.
function judgeLiteral(lx, s, e, level = 0) {
  const { code, text, sv } = lx;
  const why = [];
  if (lx.templates.some((t) => t > s && t < e)) why.push('it holds a template literal');
  if (lx.divisions.some((d) => d > s && d < e)) why.push('it holds a / read as a division');
  if (lx.regexes.some((r) => r.at > s && r.at < e && /['"`]/.test(r.body))) why.push('it holds a regex literal with a quote in it');
  if (code.slice(s + 1, e - 1).includes('{')) why.push('it holds a nested object or block');
  const ranges = [[s, e]];
  const nosys = [];
  for (const [ms, me] of splitTop(code, s + 1, e - 1)) {
    const member = code.slice(ms, me);
    if (member.startsWith('...')) {
      const a = skipWs(code, ms + 3);
      const target = code.slice(a, me);
      if (NAME.test(target)) {
        if (level > 0) { why.push(`it spreads '${target}' a second level down`); continue; }
        const f = followConst(lx, target, s, s, e);
        if (f.why) { why.push(f.why); continue; }
        const init = skipWs(code, f.decl.init);
        const initEnd = backWs(code, f.decl.initEnd - 1) + 1;
        if (code[init] === '{' && closeOf(code, init) === initEnd - 1) {
          const inner = judgeLiteral(lx, init, initEnd, level + 1);
          if (inner.why) why.push(`its spread '${target}': ${inner.why}`);
          ranges.push(...inner.ranges);
          nosys.push(...inner.nosys);
        } else {
          const p = pick(lx, init, initEnd);
          if (p.why) { why.push(`its spread '${target}': ${p.why}`); continue; }
          ranges.push(...p.ranges, [init, initEnd]);
          for (const k of p.names) if (k.toUpperCase() === 'GIT_CONFIG_NOSYSTEM') nosys.push({ top: false, one: false });
        }
        continue;
      }
      const p = pick(lx, a, me);
      if (p.why) { why.push(p.why); continue; }
      ranges.push(...p.ranges);
      for (const k of p.names) if (k.toUpperCase() === 'GIT_CONFIG_NOSYSTEM') nosys.push({ top: false, one: false });
      continue;
    }
    if (member.startsWith('[')) { why.push('it has a computed key'); continue; }
    let colon = -1;
    for (let i = ms, depth = 0; i < me; i++) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) { colon = i; break; }
    }
    let key = colon === -1 ? text.slice(ms, me) : text.slice(ms, colon).trim();
    if (colon === -1 && !NAME.test(key)) { why.push(`it holds a member the census cannot read: ${cut(key)}`); continue; }
    key = key.replace(/^(['"])(.*)\1$/, '$2');
    if (key.includes('\\')) { why.push(`its key ${cut(key)} is written with an escape, so its name is not the text`); continue; }
    if (key === '__proto__') { why.push('it sets __proto__, whose properties a spawned child inherits'); continue; }
    if (key.toUpperCase() === 'GIT_CONFIG_NOSYSTEM') nosys.push({ top: level === 0, one: colon !== -1 && /^(['"])1\1$/.test(text.slice(colon + 1, me).trim()) });
    const whole = processWhole(lx, colon === -1 ? ms : colon + 1, me);
    if (whole) why.push(whole);
  }
  for (const [a, b] of ranges) {
    for (const m of sv.slice(a, b).matchAll(/(?<![\w$])git_[A-Za-z0-9_]*/gi)) {
      if (!ALLOWED_GIT_KEYS.has(m[0].toUpperCase())) why.push(`it names ${m[0]}, which can aim git at another repository`);
    }
  }
  if (level === 0 && !(nosys.length === 1 && nosys[0].top && nosys[0].one)) {
    why.push(nosys.length > 1 ? 'it sets GIT_CONFIG_NOSYSTEM more than once (the last one wins)' : "it does not set GIT_CONFIG_NOSYSTEM: '1' in its own text");
  }
  const out = why.length ? { why: [...new Set(why)].join('; ') } : { cls: 'allowlist' };
  return { ...out, ranges, nosys };
}

// A same-file helper `name`: ONE definition whose body is one return of an allowlist literal, and a name that is only ever called.
function judgeHelper(lx, name) {
  const { code } = lx;
  const defs = [...code.matchAll(new RegExp(`(?<![\\w$.])(?:function\\s+${esc(name)}\\s*\\(|(const|let|var)\\s+${esc(name)}\\s*=(?![=>]))`, 'g'))];
  if (defs.length !== 1) return { why: defs.length ? `'${name}' is defined more than once in this file` : `'${name}' is not defined in this file (a helper from another file is not read)` };
  const def = defs[0];
  if (def[1] && def[1] !== 'const') return { why: `'${name}' is a ${def[1]}, which can be reassigned` };
  let body;
  if (!def[1]) {
    const open = def.index + def[0].length - 1;
    const params = closeOf(code, open);
    body = params === -1 ? -1 : skipWs(code, params + 1);
  } else {
    let i = skipWs(code, def.index + def[0].length);
    const arrow = /^(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(code.slice(i));
    if (!arrow) return { why: `'${name}' is not an arrow function` };
    i = skipWs(code, i + arrow[0].length);
    if (code[i] === '(') {
      const lit = skipWs(code, i + 1);
      const litEnd = code[lit] === '{' ? closeOf(code, lit) : -1;
      const paren = litEnd === -1 ? -1 : skipWs(code, litEnd + 1);
      if (paren === -1 || code[paren] !== ')' || closeOf(code, i) !== paren) return { why: `'${name}' does not return one object literal` };
      const after = skipWs(code, paren + 1);
      if (!/[;,)\]}]/.test(code[after] ?? ';')) return { why: `'${name}' does more than return one object literal` };
      return helperResult(lx, name, def.index, lit, litEnd + 1);
    }
    if (code[i] !== '{') return { why: `'${name}' does not return one object literal` };
    body = i;
  }
  if (body === -1 || code[body] !== '{') return { why: `'${name}' has no body the census can read` };
  const bodyEnd = closeOf(code, body);
  const ret = /^\s*return\s*\(?\s*\{/.exec(code.slice(body + 1, bodyEnd));
  if (!ret) return { why: `'${name}' does not start with a return of one object literal` };
  const lit = body + 1 + ret[0].length - 1;
  const litEnd = closeOf(code, lit);
  const rest = code.slice(litEnd + 1, bodyEnd).replace(/^\s*\)?\s*;?\s*/, '');
  if (litEnd === -1 || rest) return { why: `'${name}' does more than return one object literal` };
  return helperResult(lx, name, def.index, lit, litEnd + 1);
}

function helperResult(lx, name, defAt, lit, litEnd) {
  const nameAt = defAt + lx.code.slice(defAt).search(new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`));
  const call = references(lx.code, name, 0, lx.code.length).find((i) => i !== nameAt && lx.code[skipWs(lx.code, i + name.length)] !== '(');
  if (call !== undefined) return { why: `'${name}' is used at line ${lineOf(lx.text, call)} other than as a call` };
  const r = judgeLiteral(lx, lit, litEnd);
  return r.why ? { why: `the helper '${name}' returns a literal that is no allowlist: ${r.why}` } : { cls: 'allowlist' };
}

// Is `gitEnv` the room helper where `at` stands? A static import from ./git-env.mjs or ../git-env.mjs, or a
// `const { gitEnv } = await import(... 'git-env.mjs' ...)` whose block holds `at`, and no other binding of the name in the file.
function roomGitEnv(lx, at) {
  const { code, text } = lx;
  const imports = [];
  let binding = false;
  for (const m of text.matchAll(/(?<![\w$.])import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (code[m.index] !== 'i') continue; // inside a comment or a string
    imports.push([m.index, m.index + m[0].length]);
    if (/^\.\.?\/git-env\.mjs$/.test(m[3]) && m[1].split(',').some((s) => s.trim() === 'gitEnv')) binding = true;
  }
  for (const m of code.matchAll(/(?<![\w$.])const\s*\{\s*gitEnv\s*\}\s*=\s*await\s+import\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    const block = blockOf(code, m.index);
    if (close !== -1 && /(['"])git-env\.mjs\1/.test(text.slice(open, close)) && block[0] <= at && at <= block[1]) { binding = true; imports.push([m.index, close + 1]); }
  }
  if (!binding) return false;
  for (const i of references(code, 'gitEnv', 0, code.length)) {
    if (imports.some(([a, b]) => a <= i && i < b)) continue;
    const next = skipWs(code, i + 6);
    if (code[next] === '(') continue; // a call
    const prev = code.slice(0, i).match(/([\w$]+)\s*$/);
    if (prev && ['const', 'let', 'var', 'function', 'class'].includes(prev[1])) return false;
    if ((code[next] === '=' && code[next + 1] !== '=') || code.startsWith('=>', next)) return false; // an assignment, a default, an arrow parameter
    const open = enclosingOpen(code, i);
    if (open !== -1 && code[open] === '(') {
      const after = skipWs(code, closeOf(code, open) + 1);
      if (code.startsWith('=>', after) || /(?:function\s*[\w$]*|catch)\s*$/.test(code.slice(0, open))) return false; // a parameter
    }
    if (open !== -1 && code[open] !== '(') { const after = skipWs(code, closeOf(code, open) + 1); if (code[after] === '=' && !'=>'.includes(code[after + 1])) return false; } // a destructured name
  }
  return true;
}

// The nearest unclosed bracket before `i`, or -1.
function enclosingOpen(code, i) {
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    const c = code[k];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { if (depth === 0) return k; depth--; }
  }
  return -1;
}

// Judge the env value at [vs, ve) of a spawn at `at`: { cls: 'helper' | 'allowlist' } or { why }.
function judgeValue(lx, vs, ve, at, envAt) {
  const { code } = lx;
  const v = code.slice(vs, ve);
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(v);
  if (call && closeOf(code, vs + call[0].length - 1) === ve - 1) {
    if (call[1] === 'gitEnv' && roomGitEnv(lx, at)) {
      return /(?<![\w$.])process\s*\.\s*env(?![\w$])/.test(v) ? { why: 'it names process.env beside the room helper gitEnv() (refusal 2)' } : { cls: 'helper' };
    }
    return judgeHelper(lx, call[1]);
  }
  if (v.startsWith('{') && closeOf(code, vs) === ve - 1) return judgeLiteral(lx, vs, ve);
  if (NAME.test(v)) return judgeConst(lx, v, at, envAt);
  if (/(?<![\w$.])process(?![\w$])/.test(v)) return { why: 'it names process.env' };
  return { why: `the census cannot read ${cut(lx.text.slice(vs, ve))} as gitEnv(), an allowlist literal, a const or a same-file helper` };
}

// (ii): a variable env, followed to its const.
function judgeConst(lx, name, at, envAt) {
  const { code } = lx;
  const decl = findConst(lx, name, at);
  if (!decl) return { why: `'${name}' is no 'const ${name} =' in scope (a parameter, let, var, import or destructured name is not followed)` };
  if (functionBetween(code, decl.initEnd, at)) return { why: `'${name}' is declared outside the spawn's own function` };
  const stray = strayReference(lx, name, decl, envAt);
  if (stray !== undefined) return { why: `'${name}' is used at line ${lineOf(lx.text, stray)} other than as a git spawn's env (a write, an alias, a call or an argument can change what reaches git)` };
  const guess = guessRisk(lx, decl.block[0], decl.block[1]);
  if (guess) return { why: `the block of '${name}' is unsafe to read: ${guess}` };
  const init = skipWs(code, decl.init);
  const initEnd = backWs(code, decl.initEnd - 1) + 1;
  const v = code.slice(init, initEnd);
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(v);
  if (call && call[1] === 'gitEnv' && closeOf(code, init + call[0].length - 1) === initEnd - 1 && roomGitEnv(lx, at)) {
    return /(?<![\w$.])process\s*\.\s*env(?![\w$])/.test(v) ? { why: `'${name}' names process.env beside the room helper gitEnv() (refusal 2)` } : { cls: 'helper' };
  }
  if (v.startsWith('{') && closeOf(code, init) === initEnd - 1) {
    const r = judgeLiteral(lx, init, initEnd);
    return r.why ? { why: `'${name}' is no allowlist: ${r.why}` } : r;
  }
  return { why: `'${name}' is built as neither gitEnv() nor an allowlist literal` };
}

// Accept a command literal: git, git.exe, or an absolute path to either, in any case; the async exec too (08d R1, R2).
const CALL_RE = /(?<![\w$])(spawnSync|execFileSync|spawn|execFile|execSync|exec)\(\s*(['"`])(?:[^'"`\n]*[\\/])?git(?:\.exe)?(?=\2|\s)/gi;

// ponytail: 52 lines at declaration -- two passes over one file's calls (locate, then judge with every env position known).
export function censusGitSpawns(files) {
  const findings = [];
  let calls = 0;
  let viaHelper = 0;
  let allowlist = 0;
  let refused = 0;
  const exempted = [];
  for (const { rel, text } of files) {
    const pin = Object.hasOwn(EXEMPT_CARRIERS, rel) ? EXEMPT_CARRIERS[rel] : null;
    const exempt = pin !== null && gitBlobId(text) === pin;
    if (exempt) exempted.push(rel);
    const mark = findings.length; // this file's findings start here; an exempt carrier drops them below
    const refusedMark = refused;
    const lx = lex(text);
    const { code } = lx;
    const located = [];
    CALL_RE.lastIndex = 0;
    for (let m; (m = CALL_RE.exec(text));) {
      if (code.slice(m.index, m.index + m[1].length) !== m[1]) continue; // in a comment, a string or a template's text
      const fn = m[1];
      const line = lineOf(text, m.index);
      const open = m.index + fn.length;
      const close = closeOf(code, open);
      if (close === -1) { findings.push(`${rel}:${line} unbalanced parens scanning a ${fn}('git', ...) call -- the census cannot verify it`); continue; }
      calls++;
      const said = (why) => { refused++; findings.push(`${rel}:${line} ${fn}('git', ...) ${why} -- take gitEnv() from scripts/git-env.mjs, or build the env as one literal of named keys with GIT_CONFIG_NOSYSTEM: '1' (UMB-456 (2))`); };
      const opts = splitTop(code, open + 1, close).filter(([s, e]) => code[s] === '{' && closeOf(code, s) === e - 1).pop();
      const envs = [];
      let spread = null;
      if (opts) {
        for (const [s, e] of splitTop(code, opts[0] + 1, opts[1] - 1)) {
          if (code.startsWith('...', s)) { spread = cut(text.slice(s, e)); continue; }
          const key = /^(?:env|(['"])env\1)\s*(?::|$)/.exec(text.slice(s, e));
          if (key) envs.push(key[0].endsWith(':') ? [skipWs(code, s + key[0].length), e] : [s, e]);
        }
      }
      if (spread) { said(`spreads ${spread} into its options, which can carry an env the census cannot read`); continue; }
      if (!envs.length) { refused++; findings.push(`${rel}:${line} ${fn}('git', ...) carries no 'env:' -- it must take gitEnv() from scripts/git-env.mjs (CWK-133)`); continue; }
      if (envs.length > 1) { said('sets env more than once (the last one wins)'); continue; }
      located.push({ fn, line, at: m.index, value: envs[0], said });
    }
    const envAt = located.filter((c) => NAME.test(code.slice(c.value[0], c.value[1]))).map((c) => c.value[0]);
    for (const c of located) {
      const v = judgeValue(lx, c.value[0], c.value[1], c.at, envAt);
      if (v.cls === 'helper') viaHelper++;
      else if (v.cls === 'allowlist') allowlist++;
      else c.said(`passes an env that is no allowlist: ${v.why}`);
    }
    if (exempt) { findings.splice(mark); refused = refusedMark; }
  }
  return { findings, calls, viaHelper, allowlist, refused, scanned: files.length, exempted };
}

// Every scripts/**/*.mjs, `rel` relative to `repo` and slash-separated. Sorted (node/runtime.md 9): directory order is
// whatever the filesystem yields.
export function collectScriptsMjs(repo) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push({ rel: path.relative(repo, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  })(path.join(repo, 'scripts'));
  return files;
}
