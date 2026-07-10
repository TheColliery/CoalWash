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
// ZERO size knobs (disk fullness = the SSD/OS's job; bins are KBs) and ZERO
// clock triggers (thinning piggybacks on existing touchpoints; the caller
// passes `now` — age is the measuring stick, never the trigger).
//
// Fail direction on ANY doubt (a non-finite or future timestamp): KEEP — the
// broom asymmetry (precision 1.0 mandatory on destruction; leftover dust
// waits for the next pass, the safe direction).

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

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

// The policy. PURE: (items, now) -> { keep, destroy }; never reads a clock,
// never touches the filesystem, returns the caller's own item objects
// partitioned (order preserved within each list).
//   items     [{ at: <birth timestamp ms>, ... }] — `at` is the ONLY field
//             read; everything else rides along untouched.
//   now       the caller's clock reading (ms) — event-born, passed in.
//   horizonMs per-bin horizon; pick from HORIZON_MS (defaults to the fat
//             bin's — the fast bin is the common caller).
// Slotting is by fixed epoch buckets (floor(at / DAY_MS) days, epoch weeks),
// deterministic and timezone-free: an item's slot identity never changes as
// `now` advances, so the survivor of a slot stays the survivor.
export function retentionPlan(items, now, { horizonMs = HORIZON_MS.fat } = {}) {
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

  return { keep, destroy };
}
