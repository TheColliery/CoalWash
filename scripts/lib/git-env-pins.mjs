// This room's git-spawn census PINS (09a). The census is the canon's (scripts/lib/git-env-census.mjs, adopted by blob id from TheColliery/.github
// templates/overlay-coal-skill/scripts/lib/, never edited here) and ships no pin; a room passes its own rows to scanGitSpawns(files, pins). A row
// matches only while the file's git blob id (line endings normalised to LF) equals `blob`, so any edit, or a new source blob, re-arms the census on
// that file. scripts/lib/git-env-pins.test.mjs holds that every row is live, names how it ends, hides a real finding, and that the real tree passes
// with exactly these files exempt and no other. A pinned file is an org carrier this room never edits.
// 09a: scripts/secret-gate.test.mjs left this list when the canon rewrote it to named keys (2f066650); the room's own census file left with it.
// 09b: scripts/secret-scan.test.mjs left it when the room adopted the house source a0319dcd (Bankfire bd328f2), which the canon census reads safe.
export const CENSUS_PINS = [
  { rel: 'scripts/secret-gate.mjs', blob: '856956a1cca6f716e5507f6c23ac90ed34cbbe5f', why: "canon gate, byte-equal to the published-code template; its gitEnv() copies process.env minus GIT_* but keeps GIT_INDEX_FILE (commit mode must read the index the commit is made from) and GIT_CEILING_DIRECTORIES by design, so the census reads 'holds process.env without gitEnv()' at lines 57 and 60; DELETE when the census rule accepts a GIT_*-stripping copy of process.env or the canon builds its env from named keys" },
];
