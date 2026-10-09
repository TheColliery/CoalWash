# CoalWash input-contract datasheet — the IC pinout (AUTO-LOAD class-B)

> The published input contract for CoalWash's **auto-load prose-wash** lane. Tracked in the repo it specifies, so it cannot silently disagree with the engine. This contract describes CoalWash's shipped behaviour, not a frozen release — the current version is `.claude-plugin/plugin.json` and the git release tag. Origin: TheColliery/CoalWash#5 (Perseus Vault). SCOPE = this lane ONLY — the pin a memory STORE wires to. CoalWash's `.jsonl` session-estate (ULTRA) is CC-session-internal and out of scope for a store integration; a prose store never touches it.

Build against this fixed target; you never have to ask us anything.

## 1. The 4-test input contract (a file is washed only if it passes ALL FOUR)
1. **local file** — on disk, not a remote/streamed resource.
2. **user-owned / authored** — the user's own accreted content, not vendor-installed.
3. **PROSE** — tolerates rewording; **never machine-parsed, never executed as instructions**. A JSON/YAML *body* fails this. A prose markdown file with a thin frontmatter passes (frontmatter KEYS are guarded, see §3).
4. **ACCRETED** — grows by accumulation over time, not deliberate versioned edits.
Fail any one → **never washed** (still safe — it just rides untouched). Excluded by construction: skills/commands/hooks/agent-defs (programs) · configs/state/locks/journals (machine-parsed) · other tools' artifacts.

**These four are NECESSARY, not SUFFICIENT.** Passing all four gets a file *considered* — whether an individual write/delete actually goes through is a separate, code-enforced admission check on the file's bytes. See §6 for that check in full.

## 2. Discovery layout (what CoalWash admits — `.md` only)
CoalWash discovers class-B by structure, admitting `.md` files in exactly four fixed roles — nothing outside them is ever looked at:
- global governance (`CLAUDE.md` + its `@import` closure)
- project governance (the `CLAUDE.md` up-tree walk)
- rules tree (`.claude/rules/**/*.md`, cap 500)
- memory store (`<projects>/<slug>/memory/*.md`; the index is the always-loaded entry)
**Two separate cases for a vault whose file BODY is JSON-in-frontmatter (`{"content":"…"}`):** a vault living in its own directory is in none of the four roles above, so it is never discovered and never touched — no risk, nothing to guard against. If a copy of that same file is placed INSIDE a discovered role (e.g. dropped into the memory store above), it IS discovered — and then refused, not cleaned, at refusal class 6 in §6 (a frontmatter block opening with `{` is a YAML flow-mapping indicator, not a plain key). To be washed at all, an export must present a PROSE `.md` body (the machine layer stripped) and land inside one of the four roles above.

## 3. Fidelity guarantee — the CODE gate (zero STRUCTURED-token loss, proven by mechanical diff)
Every rewrite is diffed; the apply BLOCKS unless every one of these survives (or is named in `approvedDrops`):

wikilinks (keyed by target) · dates (ISO + DD-Mon-YYYY, canonicalized so a reformat of the same day is not a drop) · versions · links (md-link destination / autolink / bare URL) · **frontmatter KEYS** (values may be reworded) · fenced code-block content lines · code-spans (backtick, keyed verbatim) · quotes (curly + straight, keyed by the quoted text) · numbers (ratio / percent / ~Nk-N.N forms / comma-grouped counts, keyed comma-less / bare integers ≥2 digits).

**MULTISET, not set, semantics:** losing a value entirely is a drop, and a value surviving on **fewer distinct lines than it occupied** is a drop too — an exact-duplicate line is free to remove (it is the mechanical broom's own charter), but three distinct occurrences collapsing to one is caught.

Two named sub-classes ride the same gate: **number-precision** — an exact numeric token (≥2 significant digits) whose quantity survives only as a strictly coarser rounded/approximated form is reported named (`44,192` surviving only as `~44k`), not treated as a silent match. **evidence-anchor** — an evidence token (issue ref, hex id, filename) sitting near a proof-marker ("proven"/"verified"/"measured"/"confirmed"/"100%") in the original must not vanish while the marker still stands in the new text.

Plus encoding-corruption tripwires on the rewritten text: a rewrite must never *introduce* a decomposed Thai sara-am, a BOM, a zero-width space, or a bidi/zero-width control character. Pre-existing occurrences in the original are warnings, not failures — the gate blocks NEW corruption, it does not punish inherited state.

**THE CEILING, stated plainly:** the gate is a positionless mention-grain compare. It cannot see two surviving values **trading places** — a file whose structured tokens read `pass 878 / fail 0` rewritten to `pass 0 / fail 878` reports **zero drops**, because nothing vanished and nothing lost a line. Re-pairing/value-swap is out of this gate's reach by construction; it is the semantic layer's job (a human/reviewer read), never something a mechanical diff can catch. Do not read "the gate passed" as "nothing changed meaning."

## 4. Safety / transactional model
snapshot (verified-at-creation) → external-writer re-read (any foreign change aborts + rolls back) → atomic writes → verify → **deletes LAST** → commit. Whole-run rollback on any failure.

**The pin gate is two-tier**, and both tiers refuse — they differ only in blast radius:
- **MARKER** — `pinned: true` is actually present and read (matched directly in the block, or as a parsed top-level key — either is enough). This refuses the file **and aborts the whole plan** (a plan containing an action against an explicit pin is malformed; nothing else in it runs either).
- **INCAPACITY** — the file's bytes cannot be certified safe to read or rewrite: a NUL byte or a byte that fails the whole-file UTF-8 round trip past the first 64 characters (REWRITE-DOOR ONLY — a delete is not refused by either), an unclean 64-character head, an unclosed or malformed opening fence line, the frontmatter block failing one of §6's six block-readability classes, or the read itself failing. This refuses **that file only**; the rest of the plan proceeds unaffected. **No pin needs to be present for this to fire** — an ordinary file can be incapacity-refused purely on the shape of its bytes.

Either way the refused file is left untouched and safe; nothing is silently degraded. Recovery is by REFERENCE (a bin id / snapshot restores byte-exact; content is never re-authored from memory). Per-project, session-exclusive (`.coalwash.lock`).

## 5. Never-do
CoalWash rewrites no program, reads no `.jsonl`/config/state as wash input, makes no network call, and never reaches into your schema. Store-neutral by construction — it reads THIS pinout, it does not read your internals.

## 6. What a prose-export mode must present (your side of the bridge)
A `--prose` export that meets this contract:

- **`.md` file, human-accreted PROSE body** (machine/JSON layer stripped). **One file per unit you may ever want to pin independently or diagnose precisely** — because pin, rewrite, delete and diagnosis are all *file-scoped* operations in this engine, with no sub-file address anywhere in it: `pinned: true` is read from exactly ONE frontmatter block per physical file (pin is whole-file or nothing), every mutation targets a whole file (a merge is composite — a delete of the source plus a rewrite of the destination — never a partial in-file edit), and §3's gate diffs at file scope, so a drop inside a 400-entry concatenated file is still CAUGHT but reported as "a drop happened in this file," not which entry. **A single concatenated file is contract-valid** — it passes all four tests in §1 and washes correctly; pin and diagnostics then simply apply to the whole file rather than to one entry inside it. Split only where you want that finer grain.
- **No NUL bytes anywhere in the file.** Refused outright as binary content — flagged, not rewritten. Named for completeness; not a realistic risk for a text export.
- **Valid UTF-8, whole file.** CoalWash decodes a rewrite target as text, re-encodes, and compares bytes; any byte that does not round trip refuses the WHOLE FILE from rewriting (Thai, CJK and emoji pass by construction — this is a validity check, not a script restriction).
- **The file's first 64 characters must be clean — regardless of whether the file has frontmatter at all.** CoalWash always reads a fixed 64-character head looking for a frontmatter fence, and refuses the whole file if that head contains a NUL byte or a **U+FFFD replacement character** — the exact marker a lossy re-encode from another source encoding leaves behind, and the most likely byte a flattener converting FROM another format emits — or a second U+FEFF (byte-order-mark) sitting right after a first, legal one is stripped.
- **If the file opens with `---`, the opening fence line itself is checked before any block content.** It is refused if the tail after `---` contains a byte that is neither whitespace nor a printable-ASCII glyph (an invisible or stray byte, such as a non-breaking space — a plain trailing space or tab is fine), if that line ends in a bare CR, or if no matching closing `---` is ever found anywhere in the file. **A single, unclosed `---` at the top of a file is refused HERE, at the fence — it never reaches the six block checks below.**
- **If the frontmatter block DOES close cleanly, its content is then checked against six readability classes** (per-file refusal, §4 INCAPACITY tier):
  1. a **bare CR** anywhere in the block (mixed line endings)
  2. a **TAB** in the indentation
  3. a line readable as **neither a key, a comment, nor a list item** — for example, TWO `---` lines with colon-less prose between them (a single UNCLOSED `---` is the earlier, fence-level refusal above — not this one)
  4. a key indented **less than the block's first line** (mixed indentation)
  5. a top-level key containing a character **outside printable ASCII**
  6. a top-level key **opening with a YAML indicator** (`` , [ ] { } & * ! | > % @ ` ? ``) — a JSON body wrapped as frontmatter (`{"content": "..."}`) fails here immediately, since the opening `{` is a flow-mapping indicator, not a plain key
- **A file that never opens with `---` at all skips every frontmatter check above** — but NOT the NUL / UTF-8 / 64-character-head requirements above, which apply to every file regardless of frontmatter.
- Keys present in a passing frontmatter block are preserved verbatim (see §3); values are free prose.

Then CoalWash washes it with **zero special-casing on our side**.

## 7. Encrypt-on-export (if your store encrypts at rest)
CoalWash washes plaintext prose. If your vault is encrypted at rest, decrypt on export → hand CoalWash plaintext inside the trust zone → re-encrypt on the way back. The key never enters CoalWash; we hold no key, no ciphertext.

## 8. Report channel — if CoalWash breaks against your export
File an issue immediately — a wrong skip, a false gate block, anything. No ceremony, no waiting on a release. A partner store's integration report is first-class input.
