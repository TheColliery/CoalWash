// CWK-136 -- a textual census: does every git spawn under scripts/ take its env from gitEnv() (scripts/git-env.mjs)?
// CWK-133 gave every fixture and gate one helper; nothing stopped the NEXT fixture from spawning git with no `env:` and
// inheriting whatever GIT_DIR / GIT_INDEX_FILE a linked worktree's hook exports. This is the gate that says so.
//
// Two refusals, in the order the finding was ruled:
//   (1) a git spawn with NO `env:` in the same call;
//   (2) a git spawn whose `env:` value names `process.env` at all. STRICTER than "without the helper" on purpose:
//       gitEnv() already copies process.env, so naming it again beside the helper (`{ ...gitEnv(d), ...process.env }`)
//       can only re-add what the strip removed, and the spread order would decide it silently.
//
// A spawn whose env is a VARIABLE (`env: fixtureEnv`, or the `{ env }` shorthand) is FOLLOWED (UMB-456 (2)) to the nearest
// `const <name> = ...` before the call whose block still encloses the call, and that declaration is judged:
//   - one that calls gitEnv() is judged as if its value were written in the call: refused when it names `process.env`
//     (refusal (2)), else counted as the helper (`viaHelper`);
//   - otherwise it must be an ALLOWLIST (`allowlist`): (a) it never takes process.env as a whole object (`...process.env`,
//     `Object.assign(<x>, process.env)`, `= process.env`, and an `Object.entries` / `Object.keys` of it with no `.filter(`
//     after are refused; a read of one key, `process.env[k]` or `process.env.NAME`, passes); (b) it sets
//     `GIT_CONFIG_NOSYSTEM: '1'`; (c) no GIT_* name appears in it or in a `const` it names, other than GIT_CONFIG_NOSYSTEM,
//     GIT_TERMINAL_PROMPT and GIT_CEILING_DIRECTORIES (the last only narrows where git searches). A declaration that fails is
//     a REFUSAL (a finding, counted in `refused`), never `other`.
//
// NAMED LIMITS, because a textual gate is a tripwire and never a proof:
//   - a spawn whose env is a local WRAPPER (`env: hermeticGit(root)`) passes: its TEXT holds neither `process.env` nor
//     `gitEnv(`, and the wrapper's own body is not followed. A variable with no `const` declaration in scope before the call
//     (a parameter, a `let` or `var`, a destructured name, a declaration after the call) is not followed either. Those are
//     COUNTED and printed (`other`), so the size of the unverified set is visible, never implied away.
//   - the declaration locator is textual: a block is read by counting `{` and `}` outside string literals, so a brace inside
//     a comment can move it, and a parameter or inner `let` that SHADOWS the const is not seen. A declaration's value runs to
//     its `;` (a declaration that ends on ASI reads on to the next `;`, which can only add text, so it can only refuse more).
//     A `const` the declaration names is followed ONE level (its own names are not followed), and only to read GIT_* names
//     and a whole-object process.env.
//   - a filtered `Object.entries(process.env).filter(...)` passes on the presence of `.filter(`; what the filter keeps is
//     not read.
//   - a command that is not a string literal (`spawnSync(GIT, ...)`) is invisible to the locator. git-env.test.mjs uses
//     that on purpose for its one hostile-env control leg.
//   - a `//` earlier on the same line hides a call after it (a `//` inside a string too): under-detection, the same
//     heuristic CoalTipple's exemplar carries. A call written inside a `/* */` block IS scanned (over-detection: loud,
//     fixed by rewording).
//   - THREE more BYPASSES (CWK-137 F-10), named rather than widened, and pinned by a test so this list cannot rot (a
//     widening turns that test red, and the fix is to move the item off this list):
//       (1) `env: process['env']` (or the double-quoted form): the value text has every string literal's CONTENTS
//           blanked, so a bracket access reads as `process['   ']` and refusal (2) never sees it. It is COUNTED as `other`.
//       (2) a command literal that does not START with `git` then a quote or space: `'git.exe'` and any absolute path
//           (`'C:/Program Files/Git/bin/git.exe'`, `'/usr/bin/git'`) never match the locator, so the call is not counted at all.
//       (3) the ASYNC `exec('git ...')` of child_process: only spawnSync, execFileSync, spawn, execFile and execSync are
//           located.
//     A spawn written any of these ways passes this gate whatever its env holds.
// The gate PRINTS its coverage (files, calls, per-class counts) because a locator that matches nothing reports clean.
//
// censusGitSpawns() is pure (a { rel, text } list in, a report out) so it is unit-tested directly, red-first;
// collectScriptsMjs() is the filesystem walk, kept apart so the pure function never touches disk. Exemplar: CoalTipple
// scripts/lib/git-env-census.mjs. Divergences: it lives in scripts/ (dev tooling, never in the dist), it also covers
// spawn / execFile / execSync, it refuses `process.env` inside an env value (refusal 2), and it returns coverage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// CWK-174: BLOB-PINNED EXEMPTION for the house secret scan's TEST file, carried BYTE-EQUAL from its source (Bankfire
// scripts/secret-scan.test.mjs, blob 4433fb56; order 08c), so it cannot be edited here without breaking the org's scanner-parity
// check. It hides ONE finding, quoted: "scripts/secret-scan.test.mjs:593 spawnSync('git', ...) passes an env, 'cleanEnv', that is
// no allowlist: it does not set GIT_CONFIG_NOSYSTEM: '1'". That spawn is the test's own control read of a decoy repository, with an
// env that strips every GIT_* key from process.env but sets no GIT_CONFIG_NOSYSTEM (routed to the scanner's source to fix there).
// The path is exempt ONLY while the git blob id of its content equals the id pinned below (`git hash-object --no-filters`): an edit, a
// re-sync that moves the blob, or the same bytes at another path is a finding again. A named, room-local divergence: DELETE the entry
// the day the source fix lands and the carrier is re-copied. The report lists what it exempted (`exempted`), so the size of the
// unverified set is visible and never implied away. Every entry must hide a finding (git-env-census.test.mjs refuses an inert pin).
export const EXEMPT_CARRIERS = Object.freeze({
  'scripts/secret-scan.test.mjs': '4433fb56bc97d1facc3fb27804e1934c0577115f',
});

// The git blob id of a text read as UTF-8 (a carrier is valid UTF-8, so the re-encode is byte-exact): sha1 of "blob <bytes>\0" + bytes.
export function gitBlobId(text) {
  const bytes = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// The command must be a string literal starting with git: `'git'` for the argv forms, `'git add ...'` for execSync.
const CALL_RE = /\b(spawnSync|execFileSync|spawn|execFile|execSync)\(\s*['"`]git(?=['"`\s])/g;

// A match with an EARLIER `//` on its own line is inside a line comment.
function isInLineComment(text, matchIndex) {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  return text.slice(lineStart, matchIndex).includes('//');
}

// The index of the paren that closes the one at openIdx, skipping string contents; -1 when unbalanced.
function findMatchingClose(text, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// The text of an `env:` value: from `from` to the first comma or closing bracket at depth 0, with every string
// literal's CONTENTS blanked, so a `process.env` inside a string is (correctly) not a reference.
function valueText(text, from) {
  let depth = 0;
  let quote = null;
  let out = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') { out += '  '; i++; } else if (c === quote) { quote = null; out += c; } else out += ' '; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return out; depth--; }
    else if (c === ',' && depth === 0) return out;
    out += c;
  }
  return out;
}

// The raw text and the string-blanked text of a declaration's value, from `from` to its `;` at depth 0 (or the bracket
// that closes the enclosing one).
function declValue(text, from) {
  let depth = 0;
  let quote = null;
  let code = '';
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') { code += '  '; i++; } else if (c === quote) { quote = null; code += c; } else code += ' '; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; code += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
    code += c;
  }
  return { raw: text.slice(from, i), code };
}

// Does the block open at `from` still enclose `to`? Braces counted outside string literals (the named limit: not comments).
function encloses(text, from, to) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return true;
}

// The nearest `const <name> = ...` before `before` that is still in scope there: { at, raw, code } or null.
function findConst(text, name, before) {
  const re = new RegExp(`\\bconst\\s+${name.replace(/\$/g, '\\$')}\\s*=(?![=>])`, 'g');
  let found = null;
  for (let m; (m = re.exec(text)) && m.index < before;) {
    if (!isInLineComment(text, m.index) && encloses(text, m.index, before)) found = { at: m.index, ...declValue(text, m.index + m[0].length) };
  }
  return found;
}

const ALLOWED_GIT_KEYS = new Set(['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_CEILING_DIRECTORIES']);

// process.env taken as a whole object (not one key read off it), unless it is an Object.entries/keys(...) with .filter( after.
function wholeEnvUses(code) {
  const bad = [];
  const re = /\bprocess\.env\b(?!\s*[.[])/g;
  for (let m; (m = re.exec(code));) {
    const filtered = /\bObject\.(?:entries|keys)\(\s*$/.test(code.slice(0, m.index)) && /^process\.env\s*\)\s*\.filter\(/.test(code.slice(m.index));
    if (!filtered) bad.push(m.index);
  }
  return bad;
}

// Judge the declaration a variable env leads to: 'helper' | 'allowlist' | a refusal reason string | null (not followed).
function judgeEnvVariable(text, name, before) {
  const decl = findConst(text, name, before);
  if (!decl) return null;
  if (/\bgitEnv\s*\(/.test(decl.code)) {
    return /\bprocess\.env\b/.test(decl.code) ? 'it names process.env beside gitEnv() (refusal 2)' : 'helper';
  }
  let raw = decl.raw;
  let code = decl.code;
  const seen = new Set([name]);
  for (const m of decl.code.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) { // the consts it names, one level
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    const named = findConst(text, m[0], decl.at);
    if (named) { raw += `\n${named.raw}`; code += `\n${named.code}`; }
  }
  const why = [];
  if (wholeEnvUses(code).length) why.push('it takes process.env as a whole object, unfiltered');
  if (!/['"]?GIT_CONFIG_NOSYSTEM['"]?\s*:\s*['"`]1['"`]/.test(decl.raw)) why.push("it does not set GIT_CONFIG_NOSYSTEM: '1'");
  const keys = [...new Set(raw.match(/\bGIT_[A-Z0-9_]+/g) || [])].filter((k) => !ALLOWED_GIT_KEYS.has(k));
  if (keys.length) why.push(`it names ${keys.join(', ')}, which can aim git at another repository`);
  return why.length ? why.join('; ') : 'allowlist';
}

export function censusGitSpawns(files) {
  const findings = [];
  let calls = 0;
  let viaHelper = 0;
  let allowlist = 0;
  let refused = 0;
  let other = 0;
  const exempted = [];
  for (const { rel, text } of files) {
    const pin = Object.hasOwn(EXEMPT_CARRIERS, rel) ? EXEMPT_CARRIERS[rel] : null;
    const exempt = pin !== null && gitBlobId(text) === pin;
    if (exempt) exempted.push(rel);
    const mark = findings.length; // this file's findings start here; an exempt carrier drops them below
    const refusedMark = refused;
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(text))) {
      if (isInLineComment(text, m.index)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const openIdx = text.indexOf('(', m.index);
      const closeIdx = findMatchingClose(text, openIdx);
      if (closeIdx === -1) {
        findings.push(`${rel}:${line} unbalanced parens scanning a ${m[1]}('git', ...) call -- the census cannot verify it`);
        continue;
      }
      calls++;
      const callText = text.slice(openIdx, closeIdx + 1);
      const key = /\benv\s*:/.exec(callText);
      let variable = null;
      if (!key) {
        if (!/[{,]\s*env\s*[,}]/.test(callText)) {
          findings.push(`${rel}:${line} ${m[1]}('git', ...) carries no 'env:' -- it must take gitEnv() from scripts/git-env.mjs (CWK-133)`);
          continue;
        }
        variable = 'env'; // the `{ env }` shorthand
      } else {
        const value = valueText(callText, key.index + key[0].length);
        if (/\bprocess\.env\b/.test(value)) {
          findings.push(`${rel}:${line} ${m[1]}('git', ...) passes an 'env:' that names process.env -- take gitEnv() from scripts/git-env.mjs, which already copies it minus the GIT_* family (CWK-133)`);
          continue;
        }
        if (/\bgitEnv\s*\(/.test(value)) { viaHelper++; continue; }
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(value);
        if (!bare) { other++; continue; } // a wrapper call or an expression: not followed
        variable = bare[1];
      }
      const verdict = judgeEnvVariable(text, variable, m.index);
      if (verdict === null) other++;
      else if (verdict === 'helper') viaHelper++;
      else if (verdict === 'allowlist') allowlist++;
      else {
        refused++;
        findings.push(`${rel}:${line} ${m[1]}('git', ...) passes an env, '${variable}', that is no allowlist: ${verdict} -- take gitEnv() from scripts/git-env.mjs, or build the env from named keys with GIT_CONFIG_NOSYSTEM: '1' (UMB-456 (2))`);
      }
    }
    if (exempt) { findings.splice(mark); refused = refusedMark; }
  }
  return { findings, calls, viaHelper, allowlist, refused, other, scanned: files.length, exempted };
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
