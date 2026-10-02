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
// NAMED LIMITS, because a textual gate is a tripwire and never a proof:
//   - a spawn whose env is a local wrapper or a variable (`env: hermeticGit(root)`, `env: fixtureEnv`, a `{ env }`
//     shorthand) passes: its TEXT holds neither `process.env` nor `gitEnv(`, and the wrapper's own body is not followed.
//     Those are COUNTED and printed (`other`), so the size of the unverified set is visible, never implied away.
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

export function censusGitSpawns(files) {
  const findings = [];
  let calls = 0;
  let viaHelper = 0;
  let other = 0;
  for (const { rel, text } of files) {
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
      if (!key) {
        if (/[{,]\s*env\s*[,}]/.test(callText)) { other++; continue; } // `{ env }` shorthand: text unverifiable
        findings.push(`${rel}:${line} ${m[1]}('git', ...) carries no 'env:' -- it must take gitEnv() from scripts/git-env.mjs (CWK-133)`);
        continue;
      }
      const value = valueText(callText, key.index + key[0].length);
      if (/\bprocess\.env\b/.test(value)) {
        findings.push(`${rel}:${line} ${m[1]}('git', ...) passes an 'env:' that names process.env -- take gitEnv() from scripts/git-env.mjs, which already copies it minus the GIT_* family (CWK-133)`);
      } else if (/\bgitEnv\s*\(/.test(value)) {
        viaHelper++;
      } else {
        other++;
      }
    }
  }
  return { findings, calls, viaHelper, other, scanned: files.length };
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
