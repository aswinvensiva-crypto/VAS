import { encodeWav, rms } from './wav.mjs'
import { cleanTranscript, isPhantom, speechRatio, stripName, stripWake } from './transcript.mjs'
import { cosine, verdict as speakerVerdict } from './speaker.mjs'

const RATE = 16000
/** Less audio than this, and anything Whisper returns is invented. */
const MIN_SECONDS = 0.4
/** In command mode, a wake phrase that starts this early is a leading "Hey Jarvis," to cut off. */
const LEADING_SECONDS = 1

/**
 * One spoken segment in, words out.
 *
 * The face cuts speech into segments with its own voice-activity detector and
 * posts each one here as a 16 kHz WAV, along with what it is listening for:
 *
 *   wake    — JARVIS is dormant. The keyword spotter decides; nothing that
 *             does not open with "Hey Jarvis" is transcribed at all. On a hit,
 *             whatever followed the name in the same breath is the command.
 *   command — he is listening. Every segment is transcribed; a "Hey Jarvis"
 *             in front of it is cut off first, the same way.
 *   guard   — he is speaking. Transcribed, so the face can tell a barge-in
 *             from his own voice leaking back in.
 *
 * Transcription is local Whisper, or ElevenLabs Scribe when a key exists and
 * the settings allow it — local again if Scribe fails. Dormant audio never
 * leaves the machine: a wake-mode segment is only ever heard locally, by the
 * spotter or (when its model is missing, so the face falls back to matching
 * the name in a transcript) by Whisper — never Scribe.
 *
 * Once a voice is enrolled, each segment is also checked against it (on-device,
 * tens of milliseconds) before any transcription: with "only my voice" on,
 * someone else's speech is dropped right there — never transcribed, never sent
 * anywhere. The verdict comes back either way, for the permission gate.
 *
 * @returns {Promise<{ text: string, wake?: { keyword: string, trailing: string } | null,
 *                     engine?: string, reason?: string }>}
 */
export async function handleSegment({ samples, wav, mode, engine, config, scribe, speaker = null }) {
  const seconds = samples.length / RATE
  const status = engine.status()

  // The spotter decides every dormant segment. It also runs on commands, so a
  // "Hey Jarvis," said to a JARVIS who is already listening is cut off the
  // audio — not left for Whisper to spell some new way the face cannot strip.
  let hit = null
  if (status.kws && (mode === 'wake' || mode === 'command')) {
    hit = await engine.spot(samples)
    if (mode === 'wake' && !hit) return { text: '', wake: null, engine: 'kws' }
    if (mode === 'command' && !(typeof hit?.start === 'number' && hit.start <= LEADING_SECONDS)) hit = null
  }
  const wake = mode === 'wake' ? hit : null

  let owner
  if (speaker && status.speaker) {
    const score = cosine(await engine.embed(samples), speaker.centroid)
    owner = { verdict: speakerVerdict(score, seconds, speaker.thresholds), score: Math.round(score * 1000) / 1000 }
    if (owner.verdict === 'other' && config.owner.require === 'all') {
      return { text: '', ...(mode === 'wake' ? { wake: null } : {}), owner, reason: 'not-owner' }
    }
  }

  const useScribe = Boolean(scribe) && config.stt.engine !== 'local' && mode !== 'wake'
  if (!useScribe && !status.asr) {
    return { text: '', reason: 'models-missing', owner, ...(wake ? { wake: { keyword: wake.keyword, trailing: '' } } : {}) }
  }

  // After a spotted wake phrase only the rest of the audio is transcribed;
  // without a usable cut, all of it, and the phrase is stripped from the text.
  const rest = hit ? afterKeyword(samples, hit) : null
  const heard = rest ?? samples
  let text = ''
  let used = useScribe ? 'scribe' : status.whisper
  if (heard.length / RATE >= MIN_SECONDS) {
    if (useScribe) {
      try {
        text = await scribe(rest ? encodeWav(rest) : wav)
      } catch (err) {
        if (!status.asr) throw err
        console.warn(`[jarvis] Scribe failed (${err.message}); using local Whisper`)
        used = status.whisper
        text = await engine.transcribe(heard)
      }
    } else {
      text = await engine.transcribe(heard)
    }
  }
  text = cleanTranscript(text)
  if (isPhantom(text, { seconds: heard.length / RATE, rms: rms(heard), speech: speechRatio(heard) })) text = ''
  if (hit) text = rest ? stripName(text) : stripWake(text)

  if (wake) return { text, wake: { keyword: wake.keyword, trailing: text }, engine: used, owner }
  return { text, engine: used, owner }
}

/**
 * The audio after a spotted wake phrase, or null when there is no usable cut
 * (no timestamp, or too little left to transcribe).
 *
 * The cut is exactly where the spotter stamped the phrase's last phone. The
 * plan called for keeping 200 ms before it, so a command said in the same
 * breath is not clipped; measured on this spotter (Windows voices, eleven
 * phrases), its stamp already sits at the end of the word, and any overlap —
 * even 100 ms — hands Whisper the tail of "Jarvis", which it turns into words
 * nobody said: "Service, open Notepad", "This is the first time I" from a
 * bare "Hey Jarvis". Cutting at the stamp clipped no command in the same set.
 *
 * @param {Float32Array} samples
 * @param {{ end: number | null }} hit
 */
export function afterKeyword(samples, hit) {
  if (typeof hit?.end !== 'number') return null
  const rest = samples.subarray(Math.min(samples.length, Math.max(0, Math.round(hit.end * RATE))))
  return rest.length / RATE >= MIN_SECONDS ? rest : null
}
