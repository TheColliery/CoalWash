// Hermetic tests for the restore door's shell exposure. A cloned or unpacked repository can plant a recovery-bin index row
// and a write-guard snapshot file whose NAME carries a command substitution. The listing commands print those names, and the
// shipped docs tell the agent to paste them into a shell line. The shell expands the substitution before node starts, so no
// check inside node can stop it. Each test runs the shipped doc lines, with the value the listing printed, through one shell,
// and asserts that the substitution never ran. A control line proves the shell does expand substitutions, so a shell that
// does not is a visible failure rather than a false pass.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAT_BIN_NAME } from './tailings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');
const REPO = path.resolve(here, '..', '..');
// The shipped docs that carry a restore command. plugin/ is built from these; the class test (shipped-command-slots) covers the copies.
const DOCS = ['skills/coalwash/SKILL.md', 'skills/coalwash/references/method.md', 'plugin-src/README.md', 'README.md'];
const DOC_RESTORE_CMD = /node\b[^`\n]*cli\.mjs\s+(?:writeguard-restore|estate-restore|restore)\b[^`\n]*/g;

const posix = (p) => p.split(path.sep).join('/');
const BIN_MARK = 'cwc-mark-bin';
const WG_MARK = 'cwc-mark-wg';
const CONTROL_MARK = 'cwc-mark-control';
// Both are legal file and index values on Windows and POSIX: no separator, so isBareId passes them.
const BIN_ID = `$(mkdir ${BIN_MARK})`;
const WG_NAME = `$(mkdir ${WG_MARK})`;

function present(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 });
  return !r.error && r.status === 0;
}
const HAVE_BASH = present('bash', ['-c', 'exit 0']);
const HAVE_PWSH = present('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);

// One line, one shell. bash gets it as one argument; PowerShell gets it base64-encoded so no quoting is ever stripped.
function runLine(shell, line, cwd, env) {
  if (shell === 'bash') return spawnSync('bash', ['-c', line], { cwd, env, encoding: 'utf8', timeout: 60000 });
  const enc = Buffer.from(line, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { cwd, env, encoding: 'utf8', timeout: 60000 });
}

function sandbox(t) {
  const real = fs.realpathSync.native(os.tmpdir());
  const T = fs.realpathSync.native(fs.mkdtempSync(path.join(real, 'cwc-restore-')));
  t.after(() => {
    if (!T.startsWith(real + path.sep)) throw new Error(`refusing to delete ${T}: not under ${real}`);
    fs.rmSync(T, { recursive: true, force: true });
  });
  const home = path.join(T, 'home');
  const proj = path.join(T, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), `# gov\n${'a'.repeat(400)}\n`, 'utf8');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, TEMP: T, TMP: T, TMPDIR: T, CLAUDE_CONFIG_DIR: '',
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
  };
  return { T, proj, env };
}

// What a repository can plant: a bin index row under the fat bin, and a snapshot file under a session folder.
function plant(proj) {
  const binDir = path.join(proj, '.claude', 'coalwash', FAT_BIN_NAME);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'index.json'), JSON.stringify([{ id: BIN_ID, at: 1700000000000, bytes: 5, original: null, origin: 'program-cut' }]));
  const session = path.join(proj, '.claude', 'coalwash', 'writeguard', 'planted-session');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, WG_NAME), 'planted\n');
}

// The list the docs tell the agent to run: the write-guard CLI listing, and the inline listBin snippet from method.md.
function listWriteguardNames(env, proj) {
  const r = spawnSync(process.execPath, [CLI, 'writeguard-list'], { cwd: proj, env, encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')[0]);
}
function shippedBinListing(env, proj) {
  const text = fs.readFileSync(path.join(REPO, 'skills/coalwash/references/method.md'), 'utf8');
  // The fenced block that opens with its language tag: a prose sentence that names listBin( is not the snippet.
  const block = text.split('```').find((b) => /^\s*bash\s*\r?\n/.test(b) && b.includes('listBin('));
  if (!block) throw new Error('method.md carries no listBin snippet');
  const cmd = block.replace(/^\s*bash\s*/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ')
    .replace(/\[LIB\]/g, () => posix(here)).replace(/\[PROJECT_ROOT\]/g, () => posix(proj));
  const r = spawnSync('bash', ['-c', cmd], { cwd: proj, env, encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout || '[]').map((row) => row.id); } catch { return []; }
}

function docRestoreCommands() {
  const seen = new Set();
  for (const rel of DOCS) {
    for (const m of fs.readFileSync(path.join(REPO, rel), 'utf8').matchAll(DOC_RESTORE_CMD)) seen.add(m[0].trim());
  }
  return [...seen];
}

// Fill one shipped command the way the agent would: the value the listing printed goes in raw where the doc has a
// name slot, and into a file the agent wrote where the doc has --from. Every other slot gets a harmless stand-in.
function fill(cmd, { lib, proj, T, value }) {
  let n = 0;
  const unique = (ext) => posix(path.join(T, `slot-${++n}${ext}`));
  return cmd
    .replace(/\[LIB\]/g, () => posix(lib))
    .replace(/<plugin>/g, () => posix(path.resolve(lib, '..', '..'))) // the plugin root: <plugin>/scripts/lib/cli.mjs
    .replace(/\[PROJECT_ROOT\]/g, () => posix(proj))
    .replace(/--from \[FILE\]/g, () => { const f = path.join(T, `from-${++n}.txt`); fs.writeFileSync(f, `${value}\n`); return `--from ${posix(f)}`; })
    .replace(/--to-file \[FILE\]/g, () => `--to-file ${unique('')}`)
    .replace(/\[FILE\]/g, () => unique('.out'))
    .replace(/\[ITEM_ID\]|<id>|\[SNAP_NAME\]|<snapName>/g, () => value)
    .replace(/<sessionId>/g, () => 'cwc-no-such-session')
    .replace(/<query>/g, () => 'cwc')
    .replace(/<dir>/g, () => unique(''));
}

function exerciseDoors(t, shell) {
  const { T, proj, env } = sandbox(t);
  plant(proj);

  // Control: the shell must expand a substitution, or the marker check below proves nothing.
  runLine(shell, `echo cwc-control $(mkdir ${CONTROL_MARK})`, proj, env);
  assert.ok(fs.existsSync(path.join(proj, CONTROL_MARK)), `control: ${shell} did not expand a command substitution, so the marker check would prove nothing`);
  fs.rmSync(path.join(proj, CONTROL_MARK), { recursive: true, force: true });

  const printedBin = shippedBinListing(env, proj);
  const printedWg = listWriteguardNames(env, proj);
  const printed = [...printedBin, ...printedWg];
  const failures = [];
  if (printedBin.includes(BIN_ID) || printedWg.includes(WG_NAME)) {
    failures.push(`list: the listing printed the planted name (bin: ${printedBin.includes(BIN_ID)}, snapshot: ${printedWg.includes(WG_NAME)})`);
  }

  const cmds = docRestoreCommands();
  assert.ok(cmds.length >= 4, `the docs carry ${cmds.length} restore command(s); expected the restore, writeguard-restore and estate-restore lines`);
  const values = printed.length ? printed : [''];
  for (const cmd of cmds) {
    for (const value of values) {
      const line = fill(cmd, { lib: here, proj, T, value });
      runLine(shell, line, proj, env);
      for (const mark of [BIN_MARK, WG_MARK]) {
        if (fs.existsSync(path.join(proj, mark))) {
          failures.push(`${shell}: \`${line}\` ran the substitution planted as ${mark}`);
          fs.rmSync(path.join(proj, mark), { recursive: true, force: true });
        }
      }
    }
  }
  assert.deepStrictEqual(failures, []);
}

test('restore door, bash: a planted bin id or snapshot name never runs as a shell substitution from the shipped doc lines', { skip: HAVE_BASH ? false : 'bash is not on this box' }, (t) => {
  exerciseDoors(t, 'bash');
});

test('restore door, PowerShell: a planted bin id or snapshot name never runs as a shell substitution from the shipped doc lines', { skip: HAVE_PWSH ? false : 'powershell.exe is not on this box' }, (t) => {
  exerciseDoors(t, 'powershell');
});
