import { randomBytes } from 'node:crypto'
import { parseWav } from './wav.mjs'
import { MIN_SECONDS, SHORT_SECONDS, cosine, forgetSpeaker, loadSpeaker, saveSpeaker, verdict } from './speaker.mjs'
import { MODELS } from './models.mjs'
import { cleanTranscript, opensWithWake } from './transcript.mjs'
import { tuneWake } from './wake-tuning.mjs'

/**
 * The voice-enrollment endpoints the face's "Learn my voice" screen talks to.
 *
 *   GET    /voice/enroll             the lines to read, and how many of each length are needed
 *   POST   /voice/enroll?session=…   one recorded clip (16 kHz WAV)
 *   POST   /voice/enroll/finish?session=…
 *   GET    /voice/status
 *   POST   /voice/test               a clip, scored against the saved voice
 *   DELETE /voice/enroll             forget the voice
 *
 * Clips are held in memory only until the session finishes; what is saved is
 * the averaged voiceprint, not the recordings.
 *
 * A one-word "yes" carries much less of a voice than a sentence, so the
 * speaker check has a threshold for each (speaker.mjs), and each is calibrated
 * on clips of its own length: finishing takes at least MIN_SHORT recordings
 * under two seconds and MIN_LONG longer ones.
 *
 * Finishing also tunes the wake word to the voice (wake-tuning.mjs) on the
 * recordings that said "Hey Jarvis". Which ones those were is asked of
 * Whisper, while the next line is being read: the face sends audio, not which
 * line it showed, and the spotter being tuned cannot be the judge of its own
 * sweep.
 */
const MIN_SHORT = 5
const MIN_LONG = 2
/** A session nobody has added to for this long was abandoned; its clips go. */
const SESSION_MS = 15 * 60_000
/** session id -> { clips, at } */
const sessions = new Map()

function prune(now = Date.now()) {
  for (const [id, s] of sessions) if (now - s.at > SESSION_MS) sessions.delete(id)
}

/**
 * Lines to read, in order, for a face that asks: enough short answers for
 * the short-clip threshold, sentences for the long one, and "Hey Jarvis"
 * three ways for the wake word. The face's own voice detector keeps about a
 * second of quiet around what is said, so a short line is a word or two.
 */
export const PROMPTS = [
  'Hey Jarvis, open Chrome for me.',
  'Yes.',
  'The quick brown fox jumps over the lazy dog while the sun goes down.',
  'No.',
  'Hey Jarvis.',
  'Go ahead.',
  'Could you remind me what I have planned for tomorrow afternoon?',
  'Stop.',
  'Hey Jarvis, what is the weather like today?',
  'Cancel that.',
  'Confirm.',
]

/** How many recordings of each length a session has. */
function bands(clips) {
  const short = clips.filter((c) => c.seconds < SHORT_SECONDS).length
  return { short, long: clips.length - short }
}

/**
 * The clip itself when it opens with "Hey Jarvis", else null — never a
 * rejection, so a session that is abandoned leaves nothing unhandled.
 */
function wakeClip(engine, samples) {
  if (!engine.status().asr) return Promise.resolve(null)
  return engine.transcribe(samples).then(
    (text) => (opensWithWake(cleanTranscript(text)) ? samples : null),
    () => null,
  )
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./engine.mjs').createVoiceEngine>} deps.engine
 * @param {() => void} deps.onChange  the saved voice changed (enrolled or forgotten)
 * @param {{ wake: { keywords: object[] } } | null} [deps.config]
 *   the bridge's live settings, whose wake word finishing tunes; without them it is left alone
 * @param {(action: string, prompt: string) => Promise<void>} [deps.guard]
 *   puts forgetting or replacing the voiceprint to the permission gate while
 *   the owner has asked for more than a click (settings.mjs guard); throws
 *   an error with an HTTP status to refuse
 */
export function createEnrollment({ engine, onChange, config = null, guard = async () => {} }) {
  /**
   * The voiceprint is what makes "only my voice" mean anything: with none,
   * every yes counts. So the drawer's Forget and Learn-again buttons are
   * safeguards coming off, and go through the same rule as the rest of it.
   */
  const refused = async (action, prompt) => {
    try {
      await guard(action, prompt)
      return null
    } catch (err) {
      if (err?.status) return [err.status, { ok: false, reason: err.message }]
      throw err
    }
  }

  return async function handle(req, pathname, query, body) {
    if (pathname === '/voice/status' && req.method === 'GET') {
      const s = loadSpeaker()
      return [200, { enrolled: Boolean(s), clips: s?.clips ?? 0, enrolledAt: s?.enrolledAt ?? null, thresholds: s?.thresholds ?? null, available: engine.status().speaker }]
    }
    if (pathname === '/voice/enroll' && req.method === 'GET') {
      return [200, { prompts: PROMPTS, need: { short: MIN_SHORT, long: MIN_LONG }, shortSeconds: SHORT_SECONDS }]
    }
    if (pathname === '/voice/enroll' && req.method === 'DELETE') {
      const no = loadSpeaker() ? await refused('voice.forget', 'Forget your voice?') : null
      if (no) return no
      forgetSpeaker()
      onChange()
      return [200, { ok: true }]
    }
    if (!engine.status().speaker) return [503, { ok: false, reason: 'The voice model is not installed — run npm run models.' }]

    const clip = () => {
      const wav = parseWav(body)
      if (wav.sampleRate !== 16000) throw Object.assign(new Error('expected 16 kHz audio'), { status: 415 })
      return { samples: wav.samples, seconds: wav.samples.length / 16000 }
    }

    if (pathname === '/voice/enroll' && req.method === 'POST') {
      const id = query.get('session') || randomBytes(6).toString('hex')
      const { samples, seconds } = clip()
      if (seconds < MIN_SECONDS) return [200, { ok: false, session: id, reason: 'That was too short — say the whole phrase.' }]
      const v = await engine.embed(samples)
      prune()
      const list = sessions.get(id)?.clips ?? []
      list.push({ v, seconds, wake: wakeClip(engine, samples) })
      sessions.set(id, { clips: list, at: Date.now() })
      return [200, { ok: true, session: id, count: list.length, seconds: Math.round(seconds * 10) / 10, ...bands(list) }]
    }
    if (pathname === '/voice/enroll/finish' && req.method === 'POST') {
      const id = query.get('session')
      prune()
      const clips = sessions.get(id)?.clips ?? []
      const have = bands(clips)
      if (have.short < MIN_SHORT || have.long < MIN_LONG) {
        return [
          200,
          {
            ok: false,
            reason:
              `I need at least ${MIN_SHORT} short recordings (a word or two) and ${MIN_LONG} longer ones; ` +
              `I have ${have.short} short and ${have.long} long.`,
            need: { short: Math.max(0, MIN_SHORT - have.short), long: Math.max(0, MIN_LONG - have.long) },
          },
        ]
      }
      // Replacing a voice is judged by the voice being replaced.
      const no = loadSpeaker() ? await refused('settings.weaken', 'Replace your saved voice with this one?') : null
      if (no) return no
      sessions.delete(id)
      const saved = await saveSpeaker({ model: MODELS.speaker.file, clips })
      onChange()
      const said = (await Promise.all(clips.map((c) => c.wake))).filter(Boolean)
      let wake
      try {
        wake = config ? await tuneWake({ clips: said, engine, config }) : { tuned: false, reason: 'no settings to tune', clips: said.length }
      } catch (err) {
        // Best effort: the voice is saved, and a wake word left as it was is
        // no reason to tell the user enrolling failed.
        console.warn(`[jarvis] wake word not tuned: ${err?.message ?? err}`)
        wake = { tuned: false, reason: String(err?.message ?? err), clips: said.length }
      }
      return [200, { ok: true, clips: saved.clips, thresholds: saved.thresholds, wake }]
    }
    if (pathname === '/voice/test' && req.method === 'POST') {
      const s = loadSpeaker()
      if (!s) return [200, { ok: false, reason: 'No voice is enrolled yet.' }]
      const { samples, seconds } = clip()
      const score = cosine(await engine.embed(samples), s.centroid)
      return [200, { ok: true, score: Math.round(score * 1000) / 1000, verdict: verdict(score, seconds, s.thresholds), seconds }]
    }
    return null
  }
}
