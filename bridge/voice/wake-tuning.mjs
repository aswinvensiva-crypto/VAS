import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema, DEFAULT_WAKE_KEYWORDS } from '../store/config.mjs'
import { dataDir, writeJsonAtomic } from '../store/files.mjs'

/**
 * "Hey Jarvis", tuned to your voice from the lines you read while enrolling.
 *
 * The spotter fires when it is sure enough of the phrase — the keyword's
 * threshold, 0 to 1. Too low and the television wakes JARVIS; too high and you
 * have to say it twice. The default, 0.25, is a guess made for every voice at
 * once. Enrollment records you saying "Hey Jarvis" a few times, so it can find
 * where yours lands: the clips are tried at rising thresholds, the highest at
 * which every one of them still wakes him is found, and one step below that
 * is kept — so a "Hey Jarvis" said a little differently next week still
 * lands. It is written into config.wake and used at once.
 *
 * The boost is swept only when the configured one wakes on the clips at no
 * threshold at all. It changes what a threshold means (on Windows voices a
 * lower boost let the same clips through at higher thresholds), so thresholds
 * are only ever compared at one boost: the first that works, the configured
 * one first.
 *
 * Every setting tried is a new spotter, about a second to build, so the
 * thresholds are bisected rather than walked: a clip that wakes at one
 * threshold wakes at every lower one too.
 */

/** The keyword the enrollment prompts say. */
export const WAKE_NAME = DEFAULT_WAKE_KEYWORDS[0].name
/** Thresholds tried, lowest first. */
export const THRESHOLDS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]
/** Boosts tried, after the configured one, when it wakes on nothing. */
export const BOOSTS = [1, 1.5, 2, 0.5, 3]
/** Fewer "Hey Jarvis" clips than this say too little about a voice to tune on. */
export const MIN_WAKE_CLIPS = 2
/** How many threshold steps below the strictest that worked the saved one is. */
const EASE = 1

/**
 * The highest index i in [0, n) for which ok(i) holds — ok being true up to
 * some index and false above it — or -1 when ok(0) is false. About log2(n)
 * calls to ok.
 */
async function highest(n, ok) {
  if (!n || !(await ok(0))) return -1
  let lo = 0 // known to hold
  let hi = n // known not to (or past the end)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (await ok(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * The strictest setting at which every clip wakes, eased one step; null when
 * no setting tried wakes on all of them.
 *
 * @param {object} p
 * @param {{ boost: number, threshold: number }} p.keyword  the keyword being tuned, as configured
 * @param {Float32Array[]} p.clips  recordings of it being said
 * @param {(clips: Float32Array[], keyword: object) => Promise<boolean[]>} p.spot
 *   which of the clips wake with the keyword set up as given
 * @returns {Promise<{ boost: number, threshold: number, strictest: number, tries: number } | null>}
 */
export async function sweepWake({ keyword, clips, spot, thresholds = THRESHOLDS, boosts = BOOSTS }) {
  let tries = 0
  const wakesOnAll = async (boost, threshold) => {
    tries++
    return (await spot(clips, { ...keyword, boost, threshold })).every(Boolean)
  }
  for (const boost of [keyword.boost, ...boosts.filter((b) => b !== keyword.boost)]) {
    const i = await highest(thresholds.length, (j) => wakesOnAll(boost, thresholds[j]))
    if (i >= 0) return { boost, threshold: thresholds[Math.max(0, i - EASE)], strictest: thresholds[i], tries }
  }
  return null
}

/** The wake keywords with one of them set to a new boost and threshold. */
export function withTuning(keywords, name, { boost, threshold }) {
  return keywords.map((k) => (k.name === name ? { ...k, boost, threshold } : k))
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Write the wake keywords into config.json, leaving the rest of the file as
 * the user wrote it: the loaded config has every default filled in, and
 * writing that back would pin them all. Throws, writing nothing, when the
 * file is not valid JSON or the result would not be a valid config — better
 * an untuned wake word next start than a hand edit thrown away.
 */
export async function saveWakeKeywords(keywords) {
  let written = {}
  try {
    written = JSON.parse(await readFile(join(dataDir(), 'config.json'), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json is not valid JSON (${err.message})`)
  }
  if (!isPlain(written)) throw new Error('config.json is not a settings object')
  const next = { ...written, wake: { ...(isPlain(written.wake) ? written.wake : {}), keywords } }
  ConfigSchema.parse(next)
  await writeJsonAtomic('config.json', next)
}

/**
 * Enrollment's last step: tune "Hey Jarvis" on the clips it was heard in, then
 * use the result at once and keep it. `config` is the bridge's live settings
 * object; its wake keywords are replaced and the engine rebuilds its spotter.
 *
 * @param {object} p
 * @param {Float32Array[]} p.clips  the enrollment recordings that said "Hey Jarvis"
 * @param {ReturnType<typeof import('./engine.mjs').createVoiceEngine>} p.engine
 * @param {{ wake: { keywords: object[] } }} p.config
 * @returns {Promise<{ tuned: true, boost: number, threshold: number, strictest: number, clips: number, saved: boolean }
 *                 | { tuned: false, reason: string, clips: number }>}
 */
export async function tuneWake({ clips, engine, config }) {
  const skip = (reason) => ({ tuned: false, reason, clips: clips.length })
  const keyword = config.wake.keywords.find((k) => k.name === WAKE_NAME && k.enabled !== false)
  if (!keyword) return skip('there is no "Hey Jarvis" wake word to tune')
  if (!engine.status().kws) return skip('the wake-word model is not installed')
  if (clips.length < MIN_WAKE_CLIPS) {
    return skip(`"Hey Jarvis" was heard in ${clips.length} recording(s); tuning needs ${MIN_WAKE_CLIPS}`)
  }

  let found
  try {
    found = await sweepWake({ keyword, clips, spot: (c, k) => engine.spotTrial(c, [k]) })
  } finally {
    engine.endTrials()
  }
  if (!found) return skip('no setting woke on every "Hey Jarvis" — the defaults stay')

  const keywords = withTuning(config.wake.keywords, WAKE_NAME, found)
  config.wake = { ...config.wake, keywords }
  engine.setConfig(config)
  let saved = true
  try {
    await saveWakeKeywords(keywords)
  } catch (err) {
    console.warn(`[jarvis] wake word tuned but not saved: ${err.message}`)
    saved = false
  }
  const { boost, threshold, strictest } = found
  console.log(`[jarvis] wake word tuned to your voice: threshold ${threshold} (strictest ${strictest}), boost ${boost}`)
  return { tuned: true, boost, threshold, strictest, clips: clips.length, saved }
}
