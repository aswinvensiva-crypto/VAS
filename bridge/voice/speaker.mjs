import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { dataDir, writeJsonAtomic } from '../store/files.mjs'

/**
 * "Only respond to my voice."
 *
 * Enrollment turns a handful of your recordings into speaker embeddings (on
 * this machine, never uploaded), averages them into one voiceprint, and works
 * out from your own clips how similar "you" really scores — separately for
 * short clips (a "yes") and long ones, because a one-second clip carries much
 * less of a voice than a sentence does. After that every segment gets a
 * verdict:
 *
 *   owner   — clearly you.
 *   other   — clearly not you (the TV, someone else in the room).
 *   unknown — too short or too close to call. Given the benefit of the doubt
 *             for listening; not enough on its own to approve an action.
 *
 * The voiceprint is a list of numbers in speaker.json in the data folder.
 * Delete it (or say so in the tray) and JARVIS listens to anyone again.
 */

const SpeakerFile = z.object({
  version: z.literal(1),
  model: z.string(),
  dim: z.number().int().positive(),
  centroid: z.array(z.number()),
  thresholds: z.object({ short: z.number(), long: z.number() }),
  clips: z.number().int(),
  enrolledAt: z.string(),
})

const FILE = 'speaker.json'
/** Below this a clip says too little about a voice to judge at all. */
export const MIN_SECONDS = 0.8
/** Clips shorter than this use the short-clip threshold. */
const SHORT_SECONDS = 2
/** How far below the threshold a score must fall to be called someone else. */
const OTHER_MARGIN = 0.12

export function normalize(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}

export function centroid(vectors) {
  const sum = new Array(vectors[0].length).fill(0)
  for (const v of vectors.map(normalize)) for (let i = 0; i < v.length; i++) sum[i] += v[i]
  return normalize(sum)
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/**
 * Thresholds from the enrollment clips themselves: score each clip against
 * the voiceprint of the others (so no clip grades itself), and set each
 * threshold a little below the lowest such score in its length band. Clamped,
 * so one odd recording cannot make the check meaningless or impossible.
 *
 * @param {{ v: number[], seconds: number }[]} clips
 */
export function calibrate(clips) {
  const scores = { short: [], long: [] }
  for (let i = 0; i < clips.length; i++) {
    const rest = clips.filter((_, j) => j !== i).map((c) => c.v)
    const s = cosine(centroid(rest), clips[i].v)
    scores[clips[i].seconds < SHORT_SECONDS ? 'short' : 'long'].push(s)
  }
  const pick = (xs, fallback) => (xs.length ? clamp(Math.min(...xs) - 0.05, 0.3, 0.7) : fallback)
  const long = pick(scores.long, 0.5)
  const short = pick(scores.short, Math.max(0.3, long - 0.08))
  return { short, long, scores }
}

/**
 * @param {number} score   cosine similarity to the voiceprint
 * @param {number} seconds clip length
 * @param {{ short: number, long: number }} thresholds
 * @returns {'owner' | 'other' | 'unknown'}
 */
export function verdict(score, seconds, thresholds) {
  if (seconds < MIN_SECONDS) return 'unknown'
  const short = seconds < SHORT_SECONDS
  const t = short ? thresholds.short : thresholds.long
  if (score >= t) return 'owner'
  // Calling someone "not you" drops what they said, so it takes a clear
  // margin — and a wider one for short clips, which carry less of a voice.
  if (score < t - (short ? OTHER_MARGIN * 2 : OTHER_MARGIN)) return 'other'
  return 'unknown'
}

/** The saved voiceprint, or null when no voice is enrolled. */
export function loadSpeaker() {
  const path = join(dataDir(), FILE)
  if (!existsSync(path)) return null
  try {
    return SpeakerFile.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    console.warn(`[jarvis] ${FILE} is unreadable (${err.message}); voice check is off`)
    return null
  }
}

export async function saveSpeaker({ model, clips }) {
  const { short, long } = calibrate(clips)
  const data = {
    version: 1,
    model,
    dim: clips[0].v.length,
    centroid: centroid(clips.map((c) => c.v)),
    thresholds: { short, long },
    clips: clips.length,
    enrolledAt: new Date().toISOString(),
  }
  await writeJsonAtomic(FILE, data)
  return data
}

export function forgetSpeaker() {
  rmSync(join(dataDir(), FILE), { force: true })
}
