import { rms } from './wav.mjs'
import { cleanTranscript, isPhantom, stripWake } from './transcript.mjs'

/**
 * One spoken segment in, words out.
 *
 * The face cuts speech into segments with its own voice-activity detector and
 * posts each one here as a 16 kHz WAV, along with what it is listening for:
 *
 *   wake    — JARVIS is dormant. The keyword spotter decides; nothing that
 *             does not open with "Hey Jarvis" is transcribed at all. On a hit,
 *             whatever followed the name in the same breath is the command.
 *   command — he is listening. Every segment is transcribed.
 *   guard   — he is speaking. Transcribed, so the face can tell a barge-in
 *             from his own voice leaking back in.
 *
 * Transcription is local Whisper, or ElevenLabs Scribe when a key exists and
 * the settings allow it — local again if Scribe fails. The wake word is always
 * local: dormant audio never leaves the machine.
 *
 * @returns {Promise<{ text: string, wake?: { keyword: string, trailing: string } | null,
 *                     engine?: string, reason?: string }>}
 */
export async function handleSegment({ samples, wav, mode, engine, config, scribe }) {
  const seconds = samples.length / 16000
  const level = rms(samples)
  const status = engine.status()

  let wake
  if (mode === 'wake' && status.kws) {
    const hit = await engine.spot(samples)
    if (!hit) return { text: '', wake: null, engine: 'kws' }
    wake = hit
  }

  const useScribe = Boolean(scribe) && config.stt.engine !== 'local'
  if (!useScribe && !status.asr) {
    return { text: '', reason: 'models-missing', ...(wake ? { wake: { keyword: wake.keyword, trailing: '' } } : {}) }
  }

  let text = ''
  let used = useScribe ? 'scribe' : status.whisper
  if (seconds >= 0.4) {
    if (useScribe) {
      try {
        text = await scribe(wav)
      } catch (err) {
        if (!status.asr) throw err
        console.warn(`[jarvis] Scribe failed (${err.message}); using local Whisper`)
        used = status.whisper
        text = await engine.transcribe(samples)
      }
    } else {
      text = await engine.transcribe(samples)
    }
  }
  text = cleanTranscript(text)
  if (isPhantom(text, { seconds, rms: level })) text = ''

  if (wake) {
    const trailing = stripWake(text)
    return { text: trailing, wake: { keyword: wake.keyword, trailing }, engine: used }
  }
  return { text, engine: used }
}
