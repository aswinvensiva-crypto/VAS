import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { readJson, writeJsonAtomic } from '../store/files.mjs'

/**
 * Corrections: what the recogniser keeps hearing, and what you actually said.
 *
 * Whisper gets a handful of words wrong for each person — an accent, a product
 * name it never saw in training — and gets them wrong the same way every time:
 * "open spot if i". So when you correct JARVIS ("no, I said open Spotify") he
 * writes the pair down, and every later transcript is fixed before anything
 * acts on it.
 *
 * That makes a correction a rewrite rule over everything you say, which is
 * exactly what an attacker, or an unlucky mishearing, would want. The rules in
 * this file exist so that a correction can fix a word and do nothing else: it
 * can never forge a "yes" for a pending confirmation, say JARVIS's name to
 * wake him, or say — or swallow — the phrase that puts him to sleep.
 *
 * %APPDATA%\VAS\data\corrections.json, an array of entries.
 */

const FILE = 'corrections.json'
const MAX_LENGTH = 60

const aliases = JSON.parse(readFileSync(new URL('../../config/wake-aliases.json', import.meta.url), 'utf8'))

/** Words too common to correct on their own: "the" -> "a" would rewrite every sentence. */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'it', 'is', 'and', 'or', 'i', 'you', 'me', 'my',
])

/**
 * Lowercase words, keeping in-word apostrophes ("don't", "java's") and
 * dropping everything else, so "Go-ahead!" and "go ahead" read the same.
 */
export function words(text) {
  return String(text ?? '').toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []
}

/**
 * What a correction may never contain, on either side, and why.
 *
 * "ok", "okay", "yep" and "yup" go beyond the confirm words the gate is known
 * to accept today: they are how people actually say yes, and refusing a
 * correction costs nothing but saying it again.
 */
const CONFIRM_WORDS = [
  'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'confirm', 'confirmed', 'do it', 'go ahead',
  'no', 'nope', 'cancel', 'stop', 'never mind',
]
const KILL_PHRASES = ['go to sleep', 'shut down', 'stop listening', 'lockdown', 'lock down', 'unlock']

/**
 * Matched on whole words, so "know" is not "no". Each phrase is also matched
 * written as one word — "nevermind", "shutdown", "gotosleep" — because that is
 * a spelling recognisers really produce and the guard must not hinge on a
 * space.
 */
const GUARDS = [
  ...CONFIRM_WORDS.map((phrase) => ({ phrase, why: 'answers a confirmation' })),
  ...aliases.names.map((phrase) => ({ phrase, why: "is JARVIS's name" })),
  ...KILL_PHRASES.map((phrase) => ({ phrase, why: 'is a kill phrase' })),
].flatMap(({ phrase, why }) => {
  const spaced = words(phrase).join(' ')
  const joined = spaced.replace(/ /g, '')
  return [...new Set([spaced, joined])].map((needle) => ({ phrase, why, needle: ` ${needle} ` }))
})

/** Every guarded phrase in `text`, possessives included: "jarvis's" is still his name. */
function guardedIn(text) {
  const tokens = words(text)
  const plain = ` ${tokens.join(' ')} `
  const bare = ` ${tokens.map((t) => t.replace(/'s$/, '')).join(' ')} `
  return GUARDS.filter((g) => plain.includes(g.needle) || bare.includes(g.needle))
}

/** Which guarded phrases a text holds, as one comparable string. */
const guardKey = (text) => [...new Set(guardedIn(text).map((g) => g.phrase))].sort().join('|')

const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')
/** Heard phrases are compared, stored and keyed in this form. */
const key = (s) => tidy(s).toLowerCase()
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Why this correction must not be learned, in words JARVIS can say back — or
 * null when it is fine.
 *
 * @param {{ heard?: unknown, meant?: unknown }} correction
 * @returns {string | null}
 */
export function validateCorrection({ heard, meant } = {}) {
  if (typeof heard !== 'string' || typeof meant !== 'string') return 'a correction needs both what was heard and what was meant'
  const h = tidy(heard)
  const m = tidy(meant)
  if (!h || !m) return 'a correction needs both what was heard and what was meant'
  if (h.length > MAX_LENGTH || m.length > MAX_LENGTH) return `corrections are for short phrases, ${MAX_LENGTH} characters at most`
  if (h.toLowerCase() === m.toLowerCase()) return 'what was heard and what was meant are the same'
  const heardWords = words(h)
  if (!heardWords.length) return 'what was heard has no words in it'
  if (heardWords.every((w) => STOP_WORDS.has(w))) {
    return `"${h}" is only small words like "the" and "to", and correcting it would rewrite half of everything you say`
  }
  for (const text of [h, m]) {
    const hit = guardedIn(text)[0]
    if (hit) return `a correction can't contain "${hit.phrase}", because it ${hit.why}`
  }
  return null
}

export const CorrectionSchema = z.object({
  heard: z.string().min(1).max(MAX_LENGTH),
  meant: z.string().min(1).max(MAX_LENGTH),
  /** How many times it has fixed a transcript; for showing and pruning, never for deciding. */
  count: z.number().int().min(0).default(0),
  createdAt: z.string().default(() => new Date().toISOString()),
  /** Who taught it — learned from a spoken "no, I said…", or added by hand. */
  source: z.string().max(40).default('user'),
})

/**
 * The file as stored. One bad entry — hand-edited, or written by an older
 * version with looser rules — is dropped rather than costing every other
 * correction, and validateCorrection runs again here because the file is as
 * editable as the code that wrote it.
 */
export const CorrectionsFileSchema = z
  .array(z.unknown())
  .catch([])
  .transform((items) => {
    const kept = items.flatMap((item) => {
      const parsed = CorrectionSchema.safeParse(item)
      return parsed.success && !validateCorrection(parsed.data) ? [parsed.data] : []
    })
    if (kept.length < items.length) {
      console.warn(`[jarvis] ${FILE}: dropped ${items.length - kept.length} invalid correction(s)`)
    }
    return kept
  })

/**
 * A set of corrections and the one thing they do: rewrite a transcript.
 *
 * Entries that fail validation are skipped rather than thrown on, so a set
 * built from anywhere is a safe set.
 */
export function createCorrections(entries = []) {
  /** Keyed by the lowercased heard phrase, so teaching one again replaces it. */
  const byHeard = new Map()
  /** The compiled matcher; rebuilt on the next apply after any change. */
  let matcher = null

  const put = (raw) => {
    const entry = CorrectionSchema.parse({ ...raw, heard: key(raw.heard), meant: tidy(raw.meant) })
    byHeard.set(entry.heard, entry)
    matcher = null
    return entry
  }

  for (const e of entries) {
    if (!e || validateCorrection(e)) continue
    try {
      put(e)
    } catch {
      // A malformed count or source: skip it, like any other bad entry.
    }
  }

  /**
   * One alternation, longest heard phrase first so "spot if i" wins over
   * "spot" at the same position. A capture group per entry says which one
   * matched without re-deriving it from the matched text, which may differ in
   * case or spacing. The word boundaries count apostrophes as letters, so
   * "cat" never rewrites "category" and "don" never rewrites "don't".
   */
  function compile() {
    const order = [...byHeard.values()].sort((a, b) => b.heard.length - a.heard.length)
    const alternatives = order.map((e) => `(${e.heard.split(' ').map(escape).join('\\s+')})`)
    const regex = new RegExp(`(?<![\\p{L}\\p{N}'])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}'])`, 'giu')
    return { regex, order }
  }

  return {
    /**
     * Fix a transcript in one pass. Replacements are never scanned again, so
     * "a" -> "b" and "b" -> "c" turn "a" into "b", not "c".
     *
     * The whole result is refused if it holds a different set of confirm,
     * wake or kill phrases than what was said: each correction is checked on
     * its own when learned, but "goat" -> "go" is innocent until it meets
     * "goat ahead", and "sleep" -> "sheep" until it meets "go to sleep".
     */
    apply(text) {
      const input = String(text ?? '')
      if (!byHeard.size) return input
      matcher ??= compile()
      const { regex, order } = matcher
      const used = []
      const output = input.replace(regex, (...args) => {
        const entry = order[args.slice(1, 1 + order.length).findIndex((g) => g !== undefined)]
        used.push(entry)
        return entry.meant
      })
      if (!used.length || guardKey(output) !== guardKey(input)) return input
      for (const entry of used) entry.count++
      return output
    },

    /** Learn one; throws with validateCorrection's reason when it must not be. */
    add({ heard, meant, source } = {}) {
      const reason = validateCorrection({ heard, meant })
      if (reason) throw new Error(reason)
      return { ...put({ heard, meant, ...(source ? { source } : {}) }) }
    },

    remove(heard) {
      const removed = byHeard.delete(key(heard))
      if (removed) matcher = null
      return removed
    },

    list() {
      return [...byHeard.values()].map((e) => ({ ...e }))
    },
  }
}

export async function loadCorrections() {
  return createCorrections(await readJson(FILE, CorrectionsFileSchema))
}

export async function saveCorrections(corrections) {
  await writeJsonAtomic(FILE, CorrectionSchema.array().parse(corrections.list()))
}
