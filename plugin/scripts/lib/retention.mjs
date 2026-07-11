// retention.mjs — bin-destruction policy: Time-Machine density thinning
// (MEMORY.md "BIN DESTRUCTION = TIME-MACHINE DENSITY THINNING" + "THE
// DESTRUCTION LAW CRYSTALLIZED", beta.12 spec — FINAL SHAPE).
//
// The law, layer by layer (each names its parent + the downside it closes):
//   birth   = EVENT-only (TRIM parent; no clocks — the caller passes every
//             timestamp; this module never reads a clock).
//   life    = DUAL-AXIS thinning:
//             density axis — new-replaces-old WITHIN a slot (the user's own
//               contribution, = Time Machine's intra-slot rule; closes
//               "replacement-alone = depth-1", the rejected proposal whose
//               fatal case is wash-on-wash data loss);
//             age axis — keep-ALL until 48h -> LAST-per-day until 14d ->
//               LAST-per-week until the horizon (closes "kept-N =
//               busy-collapse": a busy afternoon must not evict the only
//               pre-surgery restore point).
//   horizon = burst-gap-derived, per bin (closes "time-alone = overflow" and
//             "size-alone = rot" — the failure couplet, verbatim from the
//             owner as the layman doc:
//             "เอาเวลาไปกำหนดถังโตไว -> ขยะล้นหน้าบ้าน ·
//              เอาไซส์ไปกำหนดถังโตช้า -> ขยะเน่าก่อนที่จะทิ้ง"
//             — each single axis is correct on one growth regime and
//             pathological on the opposite; the complete law holds both by
//             construction: density = overflow control for fast bins, horizon
//             = rot control for slow bins).
//   death   = the CALLER's job (verify + journal death-certificate); this
//             module only PARTITIONS — it is a pure function with no fs, no
//             clock, no side effects, so its guarantees are hermetic-testable
//             at zero lab cost (the USER's testing ruling: "retention = a
//             PURE FUNCTION -> hermetic code tests, zero lab tokens").
//
// SIZE-CAP ∧ TIME-HORIZON, whichever binds first (0i, MEMORY.md — the
// journald SystemMaxUse+MaxRetentionSec model; SUPERSEDES this module's
// original "ZERO size knobs" line): speed is not a property of the bin, it
// is the USER's behavior — a fixed horizon alone is wrong on the fast-growth
// regime (ขยะล้น) exactly as a size cap alone is wrong on the slow one
// (ขยะเน่า). So BOTH limits run on EVERY bin: the horizon ages out the
// quiet-user case; the size cap density-thins from the OLDEST first when the
// bin outgrows its budget — catching overflow before items even age. The
// budget is measured against the STORE's own bytes (0i V2: "ฉันไม่มีวันรู้
// ความจุ SSD ของผู้ใช้" — CW is a guest and can never reference the disk;
// the one capacity always known is the store measured every session, so the
// bin — the store's shadow — is capped as a MULTIPLE of it, growable with
// real growth like the snapshot-kept-3 precedent). Still ZERO clock
// triggers (run-gated per 0h-GUARD: the caller invokes this at applyPlan,
// never a daemon; the caller passes `now` — age is the measuring stick,
// never the trigger).
//
// Fail direction on ANY doubt (a non-finite or future timestamp, an item
// with no measurable weight): KEEP — the broom asymmetry (precision 1.0
// mandatory on destruction; leftover dust waits for the next pass, the safe
// direction).

// --- tier boundaries (birth certificates — derivation, not convention) -----
// 48h: the same/next-session noticing window — damage caught while the
// session (or its immediate successor) still remembers what changed keeps
// EVERY restore point (full undo depth; the wash-on-wash case lives here).
export const TIER1_KEEP_ALL_MS = 48 * 3600 * 1000;
// 14 days: the "เอ๊ะ อาทิตย์ก่อน" band — the human-recall window where damage
// is noticed as "something from last week is off"; one restore point per day
// is the granularity that recall can actually name.
export const TIER2_LAST_PER_DAY_MS = 14 * 86400000;
// Horizons: derived from the OWNER'S measured working cadence, not copied
// from a vendor — the user works in ~monthly BURSTS, so damage may only be
// noticed at the NEXT burst; a horizon must span >= 1 burst gap.
//   fat bin   30d = 1 burst gap (normal-mode per-cut records, high churn);
//   store.old 60d = 2 burst gaps (whole-store pre-surgery images —
//                   surgery-grade caution, the slow/rare/gold bin).
export const HORIZON_MS = Object.freeze({
  fat: 30 * 86400000,
  'store.old': 60 * 86400000,
});
// Size-cap budget = this multiple of the MEASURED STORE's bytes, per bin
// (0i V2 — never the disk). Birth certificate: 2x is a REASONED PLACEHOLDER,
// not a measured figure (same convention as caliper's CAPACITY_TOKENS) — a
// bin holding cut records can plausibly accumulate up to a couple of full
// store-images' worth (a whole-store wizard delete ~ 1x; leave headroom for
// a second era) before density pressure should bind ahead of the horizon;
// calibrate at the fidelity benchmark once real bin-growth data exists.
// ponytail: constant-only this round — promote to a .coalwash.json key when
// a real user needs a different multiple, not before.
export const BIN_BUDGET_STORE_MULTIPLE = 2;

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

// The policy. PURE: (items, now) -> { keep, destroy }; never reads a clock,
// never touches the filesystem, returns the caller's own item objects
// partitioned (order preserved within each list).
//   items       [{ at: <birth timestamp ms>, bytes?, ... }] — `at` drives the
//               time layers; `bytes` (0i) is read ONLY by the size-cap layer;
//               everything else rides along untouched.
//   now         the caller's clock reading (ms) — event-born, passed in.
//   horizonMs   per-bin horizon; pick from HORIZON_MS (defaults to the fat
//               bin's — the fast bin is the common caller).
//   budgetBytes (0i) the bin's size budget — the caller derives it from the
//               MEASURED STORE (storeBytes x BIN_BUDGET_STORE_MULTIPLE).
//               Default Infinity = the cap layer inert (pre-0i behavior,
//               byte-identical) — also the fail direction when the store
//               was never measured (keep, never destroy on a missing base).
// Slotting is by fixed epoch buckets (floor(at / DAY_MS) days, epoch weeks),
// deterministic and timezone-free: an item's slot identity never changes as
// `now` advances, so the survivor of a slot stays the survivor.
export function retentionPlan(items, now, { horizonMs = HORIZON_MS.fat, budgetBytes = Infinity } = {}) {
  const keep = [];
  const destroy = [];
  const tier2 = []; // (48h, 14d]  — last-per-day candidates
  const tier3 = []; // (14d, horizon] — last-per-week candidates

  for (const item of Array.isArray(items) ? items : []) {
    const at = Number(item && item.at);
    if (!Number.isFinite(at) || at > now) { keep.push(item); continue; } // doubt (corrupt/future) -> keep, never destroy
    const age = now - at;
    if (age > horizonMs) { destroy.push(item); continue; } // nothing outlives its horizon
    if (age <= TIER1_KEEP_ALL_MS) { keep.push(item); continue; } // keep-all: full undo depth
    (age <= TIER2_LAST_PER_DAY_MS ? tier2 : tier3).push(item);
  }

  // Density axis: new-replaces-old WITHIN a slot — keep the newest item per
  // slot, destroy the rest. Tie on `at` (same millisecond): the later-listed
  // item wins (deterministic; callers list in append order, so "later" is the
  // newer write).
  const thin = (list, slotMs) => {
    const bySlot = new Map();
    for (const item of list) {
      const slot = Math.floor(Number(item.at) / slotMs);
      const cur = bySlot.get(slot);
      if (!cur || Number(item.at) >= Number(cur.at)) {
        if (cur) destroy.push(cur);
        bySlot.set(slot, item);
      } else {
        destroy.push(item);
      }
    }
    for (const survivor of bySlot.values()) keep.push(survivor);
  };
  thin(tier2, DAY_MS);
  thin(tier3, WEEK_MS);

  // SIZE-CAP layer (0i — journald SystemMaxUse; runs ALONGSIDE the horizon,
  // whichever binds first): the time-thinned survivors over budget are
  // density-thinned FROM THE OLDEST until under — this is what catches the
  // fast-growth overflow "before items even age" (a heavy loop's items are
  // all young keep-all; size pressure is the only thing that can bind there).
  // Doubt items (corrupt/future `at`) and weightless items (no finite
  // `bytes` — destroying them frees nothing and legacy pre-0i index entries
  // land here) are NEVER size-evicted: keep on doubt, the broom asymmetry.
  if (Number.isFinite(budgetBytes)) {
    const weight = (i) => { const b = Number(i && i.bytes); return Number.isFinite(b) && b > 0 ? b : 0; };
    let total = 0;
    for (const i of keep) total += weight(i);
    if (total > budgetBytes) {
      const evictable = keep
        .filter((i) => Number.isFinite(Number(i && i.at)) && Number(i.at) <= now && weight(i) > 0)
        .sort((a, b) => Number(a.at) - Number(b.at)); // oldest first (stable: same-ms keeps append order)
      const newest = evictable[evictable.length - 1]; // the most recent cut ALWAYS survives — a bin never self-empties to zero retrievability
      const weekOf = (i) => Math.floor(Number(i.at) / WEEK_MS);
      const perWeek = new Map();
      for (const i of evictable) perWeek.set(weekOf(i), (perWeek.get(weekOf(i)) || 0) + 1);
      const evicted = new Set();
      // Phase 1 — era-preserving thin (0i V1 "old eras thin but stay
      // recoverable"): evict oldest-first but leave >= 1 survivor per epoch
      // week, so every era with content stays retrievable while it slims.
      for (const i of evictable) {
        if (total <= budgetBytes) break;
        if (i === newest || (perWeek.get(weekOf(i)) || 0) <= 1) continue;
        evicted.add(i);
        perWeek.set(weekOf(i), perWeek.get(weekOf(i)) - 1);
        total -= weight(i);
      }
      // Phase 2 — the cap is a hard promise (journald deletes whole archives
      // oldest-first when the budget still binds): era protection yields,
      // oldest goes first, only the newest overall stays untouchable.
      for (const i of evictable) {
        if (total <= budgetBytes) break;
        if (i === newest || evicted.has(i)) continue;
        evicted.add(i);
        total -= weight(i);
      }
      if (evicted.size) {
        for (let k = keep.length - 1; k >= 0; k--) {
          if (evicted.has(keep[k])) { destroy.push(keep[k]); keep.splice(k, 1); }
        }
      }
    }
  }

  return { keep, destroy };
}
