// CWK-137 -- CONTAINED WRITES on REPO-DERIVED paths. The READ half (bounded,
// kind-gated, contained reads) lives in config-load.mjs beside the canonicalization
// primitives it depends on; this module is the WRITE half. Mirrored from CoalMine
// v3.20.2 (`scripts/lib/repo-fs.mjs`): same NAMES for the shared rules, plus the one
// rule this room needs that CoalMine does not -- `ownSandboxDir`.
//
// WHY THIS ROOM NEEDS MORE THAN CoalMine's RULE. CoalWash keeps its own transaction
// state INSIDE the project it serves: `<root>/.claude/coalwash/` holds the write-guard
// snapshots, the wash journal and snapshots, the bins and keeps.json -- and it DELETES
// there on its own schedule (the SessionStart write-guard sweep, the snapshot and bin
// retention). A cloned repository can commit that path, or any directory under it, as
// a link. Measured before this fix: a junction committed at
// `.claude/coalwash/writeguard` pointing at a directory holding `Documents/thesis.txt`
// left that directory EMPTY after one SessionStart (scratchpad/r8/poc/sweep-poc.mjs).
// Containment alone (CoalMine's checkRepoDirTarget) would not have been enough for a
// DELETE: a link that stays INSIDE the repo would still aim the sweep at the user's
// uncommitted work. So our own sandbox gets the stricter rule -- no link at all
// between the project root and the directory we write or delete in.
//
//   WRITE -- the nearest existing ancestor of the target resolves inside the root's
//            canonical path; the target, if it exists, is a regular file and not a
//            link; the bytes go to a sibling temp opened O_EXCL and are renamed over
//            the target, so a link planted after the check is REPLACED, never written
//            through (node/runtime.md section 5).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalOrNull, pathWithin } from './config-load.mjs';

// A refused write. `code` lets a caller tell a refusal from an ordinary I/O error.
export class RepoWriteRefused extends Error {
  constructor(message) { super(message); this.code = 'COALWASH_WRITE_REFUSED'; }
}

// `projectRoot` joined with `segs`, after proving every EXISTING component below the
// root is a real directory -- not a symlink, not a junction (Node's lstat reports a
// junction as a symbolic link), not a file. Missing components are fine: we create
// them as real directories. Throws RepoWriteRefused otherwise. The root itself may
// sit anywhere, links above it included; only the part a cloned repo controls is
// checked.
export function ownSandboxDir(projectRoot, ...segs) {
  if (!canonicalOrNull(projectRoot)) throw new RepoWriteRefused(`the project root ${projectRoot} does not resolve`);
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..' || path.basename(seg) !== seg) throw new RepoWriteRefused(`not a plain directory name: ${seg}`);
  }
  let cur = path.resolve(projectRoot);
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) {
      if (e && e.code === 'ENOENT') return path.join(cur, ...segs.slice(i + 1));
      throw new RepoWriteRefused(`cannot inspect ${cur} (${e && e.code})`);
    }
    if (st.isSymbolicLink()) throw new RepoWriteRefused(`${cur} is a link -- CoalWash never writes or deletes through a link inside the project (a cloned repo can plant one)`);
    if (!st.isDirectory()) throw new RepoWriteRefused(`${cur} exists and is not a directory`);
  }
  return cur;
}

function nearestExistingAncestor(p) {
  let dir = p;
  for (;;) {
    try { fs.lstatSync(dir); return dir; } catch { /* keep climbing */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Is `dir` (existing or not) a directory whose writes stay inside `root`? null = yes,
// else the reason, phrased for a human.
export function checkRepoDirTarget(dir, root) {
  const rootPhys = canonicalOrNull(root);
  if (!rootPhys) return `the root ${root} does not resolve`;
  const anc = nearestExistingAncestor(path.resolve(dir));
  if (anc === null) return `no existing directory above ${dir}`;
  const ancPhys = canonicalOrNull(anc);
  if (!ancPhys) return `${anc} does not resolve`;
  if (!pathWithin(ancPhys, rootPhys)) return `${anc} resolves to ${ancPhys}, outside ${rootPhys}`;
  return null;
}

// Is `target` a file CoalWash may (re)write inside `root`? null = yes, else the reason.
export function checkRepoWriteTarget(target, root) {
  const dirWhy = checkRepoDirTarget(path.dirname(path.resolve(target)), root);
  if (dirWhy) return dirWhy;
  let st;
  try { st = fs.lstatSync(target); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return `cannot inspect ${target} (${e && e.code})`;
  }
  if (st.isSymbolicLink()) {
    let to = 'an unresolvable target';
    try { to = fs.realpathSync.native(target); } catch { /* dangling */ }
    return `${target} is a symbolic link to ${to}`;
  }
  if (!st.isFile()) return `${target} exists but is not a regular file`;
  return null;
}

// Write `content` (string or Buffer) to `target` through an unpredictable sibling temp
// opened O_EXCL, then rename it over the target -- the rename replaces whatever
// directory entry sits there, a planted link included, and never writes through it.
// The temp sits in the target's own directory, so the rename is same-device by
// construction. NO containment check here: the caller has already decided the
// directory is its own (ownSandboxDir) or contained (writeRepoFile below).
export function replaceFile(target, content) {
  const tmp = `${target}.coalwash-tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// Write `content` to `target` inside `root`, or throw RepoWriteRefused.
//
// Windows refuses to rename over a file another process holds open without
// FILE_SHARE_DELETE (EPERM/EBUSY/EACCES). CoalMine hit it from inside a running git
// hook; the same can happen to a config an editor holds open. Fall back to an
// in-place write ONLY when the target is a plain regular file with a single link,
// checked ON THE OPEN HANDLE (CoalMine's CodeQL #69 lesson): open without truncating,
// O_NOFOLLOW and O_NONBLOCK where the platform has them, fstat that fd, and only then
// truncate + write through the SAME fd. A symlink or a hard link (nlink > 1) would be
// written THROUGH, so those still fail. RESIDUAL, named: Windows has no O_NOFOLLOW, so
// a symlink planted in that window would be followed there -- it still has to resolve
// to a single-link regular file, and creating one needs a privilege on Windows.
export function writeRepoFile(target, content, root) {
  const why = checkRepoWriteTarget(target, root);
  if (why) throw new RepoWriteRefused(why);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    replaceFile(target, content);
  } catch (e) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e;
    let fd;
    const flags = fs.constants.O_WRONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
    try { fd = fs.openSync(target, flags); } catch { throw e; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink > 1) throw e;
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      fs.ftruncateSync(fd, 0);
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off);
    } finally {
      fs.closeSync(fd);
    }
  }
}
