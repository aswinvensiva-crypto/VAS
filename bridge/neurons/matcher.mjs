import { readFileSync } from 'node:fs'

/**
 * Neuron order matching: does what was said fit one of the phrasings a neuron
 * answers to, and if it does, what did the speaker put in the blanks?
 *
 * The idea is Kalliope's — an order is a sentence with {{ variables }} in it,
 * matched on the words it shares with the utterance rather than by a grammar —
 * but the code is not: Kalliope is GPL and VAS is MIT, so this is written from
 * the behaviour alone. The matching is deliberately plain. Someone writing a
 * routine should be able to tell, by reading its order, what it will catch.
 *
 * Everything here works on words, never on characters. Both the template and
 * the utterance go through the same cleaning, so "What's", "what’s" and
 * "WHAT'S?" are one word, and the two sides can only ever disagree about words.
 */

/**
 * @typedef {{ norm: string[], orig: string[] }} Words
 *   An utterance as words: `norm` for comparing, `orig` (same length, same
 *   order) for handing back to a neuron with the speaker's casing intact.
 * @typedef {{ type: 'lit', word: string } | { type: 'var', name: string }} Token
 * @typedef {{ tokens: Token[] }} Template
 * @typedef {'ordered-strict' | 'strict' | 'normal' | 'not-contain'} MatchType
 */

/**
 * Strongest claim first: this is also the tie-break order in rankMatches, and
 * the list a neuron loader should validate `type` against.
 */
export const MATCH_TYPES = ['ordered-strict', 'strict', 'normal', 'not-contain']

/** Anything that is not a letter, digit, combining mark, apostrophe or space. */
const NOT_WORDISH = /[^\p{L}\p{N}\p{M}'\s]/gu
/** An apostrophe with no word character on one side: a quote mark, not a contraction. */
const LOOSE_APOSTROPHE = /(?<![\p{L}\p{N}\p{M}])'|'(?![\p{L}\p{N}])/gu
const DIGIT = /\p{N}/u

/**
 * A point, comma or colon between two digits is part of the number, not
 * punctuation: "volume 0.5" has to hand the neuron "0.5", not "0" and "5".
 */
const isNumberGlue = (ch, i, s) =>
  '.,:'.includes(ch) && DIGIT.test(s[i - 1] ?? '') && DIGIT.test(s[i + 1] ?? '')

/**
 * Text to words, with no opinion about which words matter.
 *
 * The symbol words come first because they are the ones people say aloud:
 * a recogniser that hears "notepad plus plus" may write "Notepad++", and the
 * template author may have written either.
 */
function tokenize(text) {
  const clean = String(text ?? '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, '\'')
    .replace(/\+\+/g, ' plus plus ')
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(NOT_WORDISH, (ch, i, s) => (isNumberGlue(ch, i, s) ? ch : ' '))
    .replace(LOOSE_APOSTROPHE, ' ')
  const orig = clean.split(/\s+/).filter(Boolean)
  return { norm: orig.map((w) => w.toLowerCase()), orig }
}

const words = (text) => tokenize(text).norm

const aliases = JSON.parse(readFileSync(new URL('../../config/wake-aliases.json', import.meta.url), 'utf8'))
const NAMES = aliases.names.map(words).filter((p) => p.length)
const PREFIXES = aliases.prefixes.map(words).filter((p) => p.length)

/**
 * Every way the wake phrase can open an utterance: a name, optionally after a
 * greeting. A greeting with no name after it is left alone — "ok, open
 * notepad" may not have been addressed to JARVIS at all, and an extra word
 * costs a normal match nothing. Longest first, so a multi-word alias is cut
 * whole rather than leaving its tail behind as a stray word.
 */
const WAKE = [...PREFIXES.flatMap((p) => NAMES.map((n) => [...p, ...n])), ...NAMES]
  .sort((a, b) => b.length - a.length)

/**
 * Politeness around a request. Cut only at the edges, where it never changes
 * what is being asked; inside a sentence the same words may be the request.
 */
const LEADING_FILLERS = ['please', 'can you', 'could you', 'would you', 'will you'].map(words)
const TRAILING_FILLERS = ['please', 'for me'].map(words)

/** Does `phrase` sit at words[at…] without leaving the window [lo, hi)? */
const fitsAt = (list, at, phrase, lo, hi) =>
  at >= lo && at + phrase.length <= hi && phrase.every((w, i) => list[at + i] === w)

/**
 * The part of a word list that is the actual request, as [start, end): after
 * the wake phrase and the fillers around it. Both normalize() and
 * parseTemplate() trim with this, so a template written "can you open
 * {{app}} for me" still lines up with an utterance that lost those words.
 * `null` entries (a template's variables) match nothing, so trimming stops at
 * the first blank.
 */
function requestSpan(list) {
  let start = WAKE.find((p) => fitsAt(list, 0, p, 0, list.length))?.length ?? 0
  let end = list.length
  for (;;) {
    const filler = LEADING_FILLERS.find((p) => fitsAt(list, start, p, start, end))
    if (!filler) break
    start += filler.length
  }
  for (;;) {
    const filler = TRAILING_FILLERS.find((p) => fitsAt(list, end - p.length, p, start, end))
    if (!filler) break
    end -= filler.length
  }
  return { start, end }
}

/**
 * An utterance as the words of its request.
 * @param {string} text
 * @returns {Words}
 */
export function normalize(text) {
  const { norm, orig } = tokenize(text)
  const { start, end } = requestSpan(norm)
  return { norm: norm.slice(start, end), orig: orig.slice(start, end) }
}

/**
 * Only the double-brace form is a variable, with or without inner spaces.
 * "{v}" and "{ v}}" are left as text on purpose: a half-written variable should
 * fail visibly by never matching, not quietly become a blank that eats words.
 */
const VARIABLE = /\{\{\s*(\w+)\s*\}\}/

/**
 * An order as a list of literal words and variables.
 *
 * Two variables in a row are refused because nothing marks where one ends and
 * the next begins; the same name twice is refused because the second would
 * silently overwrite the first.
 * @param {string} order
 * @returns {Template}
 */
export function parseTemplate(order) {
  // split() with a capture group interleaves: even parts are text, odd parts are names.
  const tokens = String(order ?? '').split(VARIABLE).flatMap((part, i) =>
    i % 2
      ? [{ type: 'var', name: part }]
      : words(part).map((word) => ({ type: 'lit', word })),
  )
  const { start, end } = requestSpan(tokens.map((t) => (t.type === 'lit' ? t.word : null)))
  const kept = tokens.slice(start, end)
  if (!kept.length) throw new Error(`order template has no words: ${JSON.stringify(order)}`)
  const seen = new Set()
  for (const [i, tok] of kept.entries()) {
    if (tok.type !== 'var') continue
    if (kept[i - 1]?.type === 'var') {
      throw new Error(`order template has adjacent variables {{${kept[i - 1].name}}} {{${tok.name}}}: ${JSON.stringify(order)}`)
    }
    if (seen.has(tok.name)) throw new Error(`order template repeats {{${tok.name}}}: ${JSON.stringify(order)}`)
    seen.add(tok.name)
  }
  return { tokens: kept }
}

/** Every wanted word is in `have`, counting repeats: "the … the" needs two. */
function containsAll(have, wanted) {
  const left = new Map()
  for (const w of have) left.set(w, (left.get(w) ?? 0) + 1)
  for (const w of wanted) {
    const n = left.get(w) ?? 0
    if (!n) return false
    left.set(w, n - 1)
  }
  return true
}

const containsPhrase = (list, phrase) =>
  phrase.length > 0 && list.some((_, i) => fitsAt(list, i, phrase, 0, list.length))

/**
 * Lays the template over the input left to right and returns each variable's
 * [start, end) in the input, or null if it does not fit.
 *
 * A literal is found at its first occurrence from the current position, so
 * words the template does not mention (before its first literal, or between
 * two literals) are passed over. A variable runs from where it starts up to
 * the first occurrence of the literal after it — its stop word — or to the end
 * of the input. First stop word wins, which is predictable rather than clever:
 * "play {{song}} by {{artist}}" hears "stand by me by ben e king" as the song
 * "stand". A variable that captures nothing is a miss, not an empty argument.
 */
function capture(tokens, norm) {
  const spans = {}
  let pos = 0
  for (const [i, tok] of tokens.entries()) {
    if (tok.type === 'lit') {
      const at = norm.indexOf(tok.word, pos)
      if (at < 0) return null
      pos = at + 1
      continue
    }
    const stop = tokens[i + 1]
    const end = stop ? norm.indexOf(stop.word, pos) : norm.length
    if (end <= pos) return null // -1: the stop word never comes; pos: nothing captured
    spans[tok.name] = [pos, end]
    pos = end
  }
  return spans
}

/**
 * Does `input` say `template`, and with what in its blanks?
 *
 *   normal          every literal word is said (repeats counted), anything else too
 *   strict          normal, and nothing was said beyond the template and its values
 *   ordered-strict  the template, filled in, is exactly what was said
 *   not-contain     normal, and none of `excluded` was said
 *
 * Without variables, normal and strict ignore word order: "lights off" and
 * "off lights" are the same request. With variables the literals become
 * positional, because they are what marks where each value starts and stops.
 *
 * A template that is only variables would match every utterance, so it is
 * refused unless the caller asks for it with `allowVarOnly` — a catch-all is
 * a decision, not an accident.
 *
 * `coverage` is the share of what was said that the template accounts for
 * with its own words; it is how rankMatches tells a specific routine from a
 * general one.
 * @param {Template | string} template
 * @param {Words | string} input
 * @param {{ type?: MatchType, excluded?: string[], allowVarOnly?: boolean }} [options]
 * @returns {null | { params: Record<string, string>, literals: number, coverage: number }}
 */
export function match(template, input, { type = 'normal', excluded = [], allowVarOnly = false } = {}) {
  if (!MATCH_TYPES.includes(type)) throw new Error(`unknown match type: ${JSON.stringify(type)}`)
  const { tokens } = typeof template === 'string' ? parseTemplate(template) : template
  const { norm, orig } = typeof input === 'string' ? normalize(input) : input
  if (!norm.length) return null

  const literals = tokens.filter((t) => t.type === 'lit').map((t) => t.word)
  if (!literals.length && !allowVarOnly) return null
  if (!containsAll(norm, literals)) return null
  if (type === 'not-contain' && excluded.some((e) => containsPhrase(norm, words(e)))) return null

  const spans = literals.length < tokens.length ? capture(tokens, norm) : {}
  if (!spans) return null

  if (type === 'strict' || type === 'ordered-strict') {
    const filled = tokens.flatMap((t) => (t.type === 'lit' ? [t.word] : norm.slice(...spans[t.name])))
    if (filled.length !== norm.length) return null
    if (type === 'ordered-strict' && filled.some((w, i) => w !== norm[i])) return null
  }

  const params = Object.fromEntries(
    Object.entries(spans).map(([name, [s, e]]) => [name, orig.slice(s, e).join(' ')]),
  )
  return { params, literals: literals.length, coverage: literals.length / norm.length }
}

const TYPE_RANK = new Map(MATCH_TYPES.map((t, i) => [t, i]))
const SOURCE_RANK = new Map([['user', 0], ['default', 1]])
const rankIn = (table, key) => table.get(key) ?? table.size

/**
 * Best candidate first, as a new array.
 *
 * Coverage leads because the order that explains more of what was said is the
 * more specific one: "work mode" said in full beats "open {{app}}" catching it
 * as an app name. At equal coverage the user's own neuron beats a shipped
 * default — writing one is a deliberate override. Then the stricter match
 * type, which made the stronger claim; then declaration order, so a tie
 * always resolves the same way.
 * @template {{ coverage: number, source: 'user' | 'default', type: MatchType, index: number }} C
 * @param {C[]} cands
 * @returns {C[]}
 */
export function rankMatches(cands) {
  return [...cands].sort((a, b) =>
    b.coverage - a.coverage ||
    rankIn(SOURCE_RANK, a.source) - rankIn(SOURCE_RANK, b.source) ||
    rankIn(TYPE_RANK, a.type) - rankIn(TYPE_RANK, b.type) ||
    a.index - b.index,
  )
}
