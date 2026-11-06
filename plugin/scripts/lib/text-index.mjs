// Shared prefix index for exact substring counting. One pass over a text
// records, for every k-character prefix, the ascending start positions where
// it occurs. A needle of length >= k then walks only the positions of its own
// prefix, instead of rescanning the whole text: the cost of a count follows
// the number of prefix hits, not the text length. Zero-dep, pure functions.
//
// The contract, identical to a loop of indexOf(needle, i + needle.length):
// occurrences are counted left to right and an overlap is skipped, so 'aaa'
// in 'aaaaa' counts once. A needle shorter than k takes the indexOf loop.

export const PREFIX_K = 4;

// Build the index. `counter`, when given, accrues `positions`: one per
// position recorded, so a test can see the build's work.
export function buildPrefixIndex(text, k = PREFIX_K, counter = null) {
  const index = new Map();
  const last = text.length - k;
  for (let i = 0; i <= last; i++) {
    const key = text.slice(i, i + k);
    const list = index.get(key);
    if (list) list.push(i);
    else index.set(key, [i]);
  }
  index.k = k; // the prefix length this index was built with
  if (counter) counter.positions = (counter.positions || 0) + Math.max(0, last + 1);
  return index;
}

function indexOfCount(text, needle) {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
  return n;
}

// Non-overlapping occurrences of `needle` in `text`. `index` may be null: the
// indexOf loop then answers, as it does for a needle shorter than the index's k.
// `counter`, when given, accrues `visits`: one per candidate position examined.
export function countNonOverlapping(index, text, needle, counter = null) {
  const n = needle.length;
  if (!n) return 0;
  if (!index || n < index.k) return indexOfCount(text, needle);
  const list = index.get(needle.slice(0, index.k));
  if (!list) return 0;
  let count = 0;
  let next = 0; // the first position a match may start at, after the last counted one
  for (const pos of list) {
    if (counter) counter.visits = (counter.visits || 0) + 1;
    if (pos < next) continue;
    if (text.startsWith(needle, pos)) { count++; next = pos + n; }
  }
  return count;
}

// Whether `needle` occurs at all, as String#includes answers. An empty needle
// is found, as includes('') finds it.
export function hasNeedle(index, text, needle, counter = null) {
  const n = needle.length;
  if (!n) return true;
  if (!index || n < index.k) return text.includes(needle);
  const list = index.get(needle.slice(0, index.k));
  if (!list) return false;
  for (const pos of list) {
    if (counter) counter.visits = (counter.visits || 0) + 1;
    if (text.startsWith(needle, pos)) return true;
  }
  return false;
}
