import { STOP_WORDS, validateCorrection, words } from './store.mjs'

/**
 * Working out, from "no, I said open Spotify", which words were misheard.
 *
 * People repeat themselves in one of two ways, and each needs its own reading:
 *
 *   whole   — the command again: "open spotify" after "open spot if i". Most
 *             words line up, and the misheard part is wherever they don't.
 *   fragment — just the word that went wrong: "Spotify". Nothing lines up, so
 *             the misheard part is whichever stretch of the last utterance is
 *             spelt most like it.
 *
 * Which one it was is decided first, by how much of the new sentence was in
 * the old one. Order matters: aligned word by word, "Spotify" against "open
 * spot if i" is one clean substitution of all four words, and JARVIS would
 * learn to rewrite "open" as well.
 *
 * Either way the answer has to be narrow or it is refused. A correction runs
 * over everything you say from then on, so learning too much is worse than
 * learning nothing — you can always say it again.
 */

const MAX_HEARD_WORDS = 4
/** Below this share of familiar words, the user repeated a fragment, not the command. */
const FRAGMENT_OVERLAP = 0.3
/** How alike, by spelling, a fragment must be to the words it replaces. */
const MIN_SIMILARITY = 0.6

/**
 * @param {string} previous  what JARVIS heard last time
 * @param {string} intended  what the user says they said
 * @returns {{ heard: string, meant: string } | null}
 */
export function learnCorrection(previous, intended) {
  const before = words(previous)
  const after = words(intended)
  if (!before.length || !after.length) return null
  const seen = new Set(before)
  const overlap = after.filter((w) => seen.has(w)).length / after.length
  const candidate =
    overlap < FRAGMENT_OVERLAP ? fromFragment(before, after, said(intended)) : fromWhole(before, after)
  if (!candidate || validateCorrection(candidate)) return null
  return candidate
}

/**
 * The one stretch where the two sentences disagree. Two stretches mean the
 * user rephrased rather than repeated, and a pure insertion or deletion has
 * nothing misheard to key on; both are refused.
 *
 * A single misheard word takes its left neighbour along when that neighbour
 * is a real word: "open vs cold" teaches "vs cold" -> "vs code", because
 * "cold" -> "code" on its own would rewrite every cold day.
 */
function fromWhole(before, after) {
  const regions = []
  let region = null
  let i = 0
  let j = 0
  for (const op of align(before, after)) {
    if (op === 'same') {
      if (region) regions.push(region)
      region = null
    } else {
      region ??= { from: i, intoFrom: j }
    }
    if (op !== 'insert') i++
    if (op !== 'delete') j++
    if (region) Object.assign(region, { to: i, intoTo: j })
  }
  if (region) regions.push(region)
  if (regions.length !== 1) return null

  const { from, to, intoFrom, intoTo } = regions[0]
  if (to - from < 1 || to - from > MAX_HEARD_WORDS || intoTo === intoFrom) return null
  // Checked before widening: "open a" -> "open the" passes as a phrase, but
  // what was misheard is still only "a".
  if (before.slice(from, to).every((w) => STOP_WORDS.has(w))) return null
  // Everything before a lone region lined up, so before[from - 1] and
  // after[intoFrom - 1] are the same word.
  const widen = to - from === 1 && from > 0 && !STOP_WORDS.has(before[from - 1]) ? 1 : 0
  return {
    heard: before.slice(from - widen, to).join(' '),
    meant: after.slice(intoFrom - widen, intoTo).join(' '),
  }
}

/**
 * The run of up to four heard words spelt most like the fragment, spaces
 * ignored — "spot if i" is "spotifi", one letter from "spotify". Ties go to
 * the run closest in length, then the longer one, so the stray "i" is
 * swallowed rather than left behind as "spotify i".
 */
function fromFragment(before, after, meant) {
  const target = after.join('')
  let best = null
  for (let n = 1; n <= MAX_HEARD_WORDS; n++) {
    for (let s = 0; s + n <= before.length; s++) {
      const run = before.slice(s, s + n)
      const joined = run.join('')
      const score = similarity(joined, target)
      const gap = Math.abs(joined.length - target.length)
      const better =
        !best || score > best.score || (score === best.score && (gap < best.gap || (gap === best.gap && n > best.n)))
      if (better) best = { score, gap, n, heard: run.join(' ') }
    }
  }
  if (!best || best.score < MIN_SIMILARITY) return null
  return { heard: best.heard, meant }
}

/** The fragment as the user said it — their capitals — minus the recogniser's full stop. */
const said = (text) =>
  String(text ?? '')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .replace(/\s+/g, ' ')

/** Levenshtein table over any two sequences — words or letters. */
function table(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array.from({ length: b.length }, () => 0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d
}

/**
 * The cheapest edit script from `a` to `b`, one op per step: same, change,
 * delete (a word only in `a`) or insert (a word only in `b`). Ties prefer
 * keeping a word, so a coincidental match is not invented inside a change.
 */
function align(a, b) {
  const d = table(a, b)
  const ops = []
  let i = a.length
  let j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      ops.push('same')
      i--
      j--
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      ops.push('change')
      i--
      j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push('delete')
      i--
    } else {
      ops.push('insert')
      j--
    }
  }
  return ops.reverse()
}

/** 1 for the same letters, 0 for nothing in common. */
function similarity(a, b) {
  const x = Array.from(a)
  const y = Array.from(b)
  const longest = Math.max(x.length, y.length)
  return longest ? 1 - table(x, y)[x.length][y.length] / longest : 0
}
