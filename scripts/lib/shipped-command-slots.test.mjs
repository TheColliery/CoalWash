// Hermetic test over every shipped text (skills, commands, agents when present, the plugin README, the repository README, and
// the plugin/ copies of them). It finds each command span, a fenced block or a code span that runs node or cli.mjs, and fails
// on a placeholder slot that is not on the allowlist below. A slot is allowed only when no outsider can write its value; each
// entry states the reason. The restore doors take their ids and names from a file, never from a placeholder in a shell line,
// so an id or name slot appearing in a shipped command is the defect this test exists to catch.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');

// The placeholder tokens a shipped command may carry, and why no outsider can write each one.
const ALLOW = new Map([
  ['[LIB]', 'the installed plugin folder: the user\'s plugin cache, which a repository does not write'],
  ['<plugin>', 'the installed plugin folder, the same place as [LIB], named in the README prose'],
  ['[PROJECT_ROOT]', 'the project folder the agent runs from, taken from its own working directory'],
  ['[FILE]', 'a path the agent chooses for a file it writes or reads itself; the file holds the value, never the shell line'],
  ['<query>', 'the user\'s own search term'],
  ['<sessionId>', 'read from the global archive index, which no repository writes (since 1.9.0)'],
  ['<your session id, if known>', 'the agent\'s own session id, from its own context'],
  ['[HOME]', 'the user\'s home folder, from the agent\'s own environment'],
  ['[FILES]', 'a file count the engine printed; the billing functions coerce it with Number(), so text takes no effect'],
  ['[TOTAL_BYTES]', 'a byte total the engine printed; coerced with Number() by the billing functions'],
  ['[FAT_TOKENS_OR_NULL]', 'a token estimate the engine printed, or null; billLine keeps only a finite number'],
  ['<path>', 'a folder the user names in the request for configure.mjs (the archive folder), never a file name a repository wrote'],
  ['<flags>', 'configure flags the user asks for; keys and values come from the config schema'],
]);

const PLACEHOLDER = /<[A-Za-z][^<>\n]{0,80}>|\[[A-Za-z][A-Za-z_]*\]/g;
const COMMAND = /cli\.mjs|\bnode\b/;

// Command spans of one document: each fenced block that runs node or cli.mjs (whole, since a node -e snippet spans its
// lines), and each inline code span that does. Returns { line, text }, the line being where the span starts.
function commandSpans(text) {
  const spans = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) {
      if (!inFence) { inFence = true; block = { line: i + 1, lines: [] }; }
      else {
        if (block.lines.some((x) => COMMAND.test(x))) spans.push({ line: block.line, text: block.lines.join('\n') });
        inFence = false; block = null;
      }
      continue;
    }
    if (inFence) { block.lines.push(l); continue; }
    for (const m of l.matchAll(/`([^`\n]+)`/g)) {
      if (COMMAND.test(m[1])) spans.push({ line: i + 1, text: m[1] });
    }
  }
  return spans;
}

// Findings for one document: every placeholder token in a command span that the allowlist does not name.
function scanText(text, file) {
  const findings = [];
  for (const span of commandSpans(text)) {
    for (const m of span.text.matchAll(PLACEHOLDER)) {
      if (!ALLOW.has(m[0])) findings.push({ file, line: span.line, token: m[0] });
    }
  }
  return findings;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(md|mdx)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function shippedFiles() {
  const roots = [
    path.join(REPO, 'skills'), path.join(REPO, 'commands'), path.join(REPO, 'agents'),
    path.join(REPO, 'plugin', 'skills'), path.join(REPO, 'plugin', 'commands'), path.join(REPO, 'plugin', 'agents'),
  ];
  const files = roots.flatMap(walk);
  for (const f of [path.join(REPO, 'plugin-src', 'README.md'), path.join(REPO, 'plugin', 'README.md'), path.join(REPO, 'README.md')]) {
    if (fs.existsSync(f)) files.push(f);
  }
  return files;
}

test('shipped command spans carry no placeholder slot except the allowlisted ones, in the tree', () => {
  const files = shippedFiles();
  assert.ok(files.length >= 6, `the scan reached ${files.length} shipped document(s); expected the skills, the plugin README and the repository README`);
  let restoreSpans = 0;
  const findings = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    restoreSpans += commandSpans(text).filter((s) => /cli\.mjs\s+(?:writeguard-restore|estate-restore|restore)\b/.test(s.text)).length;
    findings.push(...scanText(text, path.relative(REPO, f)));
  }
  assert.ok(restoreSpans >= 4, `the scan saw ${restoreSpans} restore command span(s); the restore doors must be among what it checks`);
  assert.deepStrictEqual(findings.map((x) => `${x.file}:${x.line} ${x.token}`), []);
});

test('the slot scan flags an id or name placeholder in a shell line (dirty fixture)', () => {
  const dirty = ['```bash', 'node [LIB]/cli.mjs restore <id> > recovered.md', '```', '', '`node [LIB]/cli.mjs writeguard-restore "[SNAP_NAME]"`'].join('\n');
  const found = scanText(dirty, 'fixture').map((x) => x.token);
  assert.deepStrictEqual(found.sort(), ['<id>', '[SNAP_NAME]']);
});

test('the slot scan passes a restore line that takes its value from a file (clean fixture)', () => {
  const clean = ['```bash', 'node [LIB]/cli.mjs restore --from [FILE] > recovered.md', 'node "[LIB]/cli.mjs" writeguard-restore --from [FILE] --out [FILE].restored', '```'].join('\n');
  assert.deepStrictEqual(scanText(clean, 'fixture'), []);
});
