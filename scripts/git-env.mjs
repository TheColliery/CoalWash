// CWK-133 -- gitEnv(): the one place a fixture or gate git spawn gets its environment (the whole GIT_* family stripped, an optional
// GIT_CEILING_DIRECTORIES set). The implementation, and the full reasoning for it, is scripts/lib/git-env.mjs: it moved there when the
// shipped crash recovery gained its one optional `git ls-files` (R14 D3), because a file in the plugin cannot import a file outside
// scripts/lib/. This path stays the import path of every gate and fixture, so there is still exactly one helper (a test pins that
// this export IS that function), and the git-spawn census still requires every git spawn under scripts/ to take `gitEnv()` directly.
export { gitEnv } from './lib/git-env.mjs';
