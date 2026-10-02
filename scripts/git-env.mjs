// CWK-133 -- a git spawn made from THIS room's own fixtures or gate scripts must never inherit an ambient
// GIT_* override. A LINKED WORKTREE's own pre-commit/pre-push hook exports an ABSOLUTE GIT_DIR (the
// worktree's admin dir) and an ABSOLUTE GIT_INDEX_FILE -- both override `cwd` AND any
// GIT_CEILING_DIRECTORIES a fixture tries to impose. Measured (CoalFace, r5, 2026-09-23):
// `GIT_DIR=<abs> git init -q .` in an EMPTY fixture dir creates NO fixture `.git` and flips the REAL
// enclosing repository's `core.bare` to `true` -- it happened to CoalFace's own repo on 2026-09-10, and
// the same mechanism is a second path to the 2026-09-10 umbrella outage (dispatch-transport.md, seventh
// amendment, C-4).
//
// Deleting the WHOLE `GIT_*` family, not a hand-maintained list, is the point -- a list rots (this room's
// own pointer-check.test.mjs carried a 14-name list until this file replaced it); the family is what git
// actually reads (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, and
// whatever a future git adds under the same prefix). The match is case-INSENSITIVE: env names are
// case-insensitive on Windows, and a `git_dir` written that way is read the same. It is a deny-list on
// purpose: git needs the rest of the OS environment to run at all on Windows (PATH, SystemRoot,
// USERPROFILE, TEMP ...), so an allow-list would enumerate the OS rather than git. What is denied is a
// PREFIX FAMILY, the form of deny-list that rots least. It also drops variables that cannot redirect
// anything (authorship, paging, formatting): no caller of this helper commits or pages.
//
// Named divergences from the exemplars (CoalFace `scripts/lib/git-test-env.mjs`, CoalTipple
// `scripts/lib/git-env.mjs`): it lives in scripts/, not scripts/lib/, because a scripts/lib file is on
// verify.mjs's LIBS roster and rides into the shipped dist, and this is dev tooling that ships nothing;
// and it is named git-env, not git-test-env, because verify.mjs and link-check.mjs's own PRODUCTION git
// spawns carry the identical exposure whenever the gate runs inside a git hook.
//
// `ceilingDir` is the one directory a spawn is never allowed to walk up past (its own parent,
// ordinarily) -- belt-and-suspenders on top of the strip. It is OPTIONAL, and omitted only where the
// spawn's cwd may legitimately be a SUBDIRECTORY of the repository it has to find (link-check.mjs is run
// from wherever the contributor stands): a ceiling at the cwd's parent would make that repository
// undiscoverable. The strip alone still removes the redirect. An ambient GIT_CEILING_DIRECTORIES is part of
// the family and is dropped with the rest; a spawn that wants one passes it here.
export function gitEnv(ceilingDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^git_/i.test(key)) delete env[key];
  }
  if (ceilingDir) env.GIT_CEILING_DIRECTORIES = ceilingDir;
  return env;
}
