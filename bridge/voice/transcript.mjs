import { readFileSync } from 'node:fs'

/**
 * Cleaning what the recogniser returns, before anything acts on it.
 */

const aliases = JSON.parse(readFileSync(new URL('../../config/wake-aliases.json', import.meta.url), 'utf8'))
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAMES = `(?:${aliases.names.map(escape).join('|')})`
const PREFIX = `(?:${aliases.prefixes.map(escape).join('|')})`

/** "Hey Jarvis, …" at the start of an utterance, in any recognised spelling. */
const LEADING_NAME = new RegExp(`^\\s*${PREFIX}?[\\s,]*${NAMES}\\b[\\s,.:;!?-]*`, 'i')
/** Any "hey <word>" opener, for when the spotter heard the name but Whisper spelt it some new way. */
const LEADING_GREETING = new RegExp(`^\\s*${PREFIX}[\\s,]+[\\w'.-]+[\\s,.:;!?-]*`, 'i')

/**
 * The command that followed the wake phrase.
 *
 * Called only after the keyword spotter has confirmed the phrase was said, so
 * the transcript is known to open with it: if the name is spelt one of the
 * known ways it is cut exactly; otherwise the leading "hey <something>" is the
 * wake phrase in a spelling Whisper invented, and goes too.
 */
export function stripWake(text) {
  const t = String(text ?? '').trim()
  if (LEADING_NAME.test(t)) return t.replace(LEADING_NAME, '').trim()
  if (LEADING_GREETING.test(t)) return t.replace(LEADING_GREETING, '').trim()
  return t
}

/**
 * The name alone, in a known spelling, at the start — for audio already cut
 * after the wake phrase, where a leftover "Jarvis" is a near miss of the cut
 * but "hey <word>" is just as likely the command itself.
 */
export function stripName(text) {
  return String(text ?? '').trim().replace(LEADING_NAME, '').trim()
}

/** Does this transcript open with the wake phrase ("Hey Jarvis", any known spelling)? */
const WAKE_PHRASE = new RegExp(`^\\s*${PREFIX}[\\s,]+${NAMES}\\b`, 'i')
export function opensWithWake(text) {
  return WAKE_PHRASE.test(String(text ?? ''))
}

/** Strip the non-speech annotations Whisper sometimes emits. */
export function cleanTranscript(text) {
  return String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Phrases Whisper is known to invent from near-silence: the closing lines of
 * the video subtitles it was trained on. Real when said clearly; invented when
 * the audio behind them is quiet.
 */
const PHANTOMS = new Set([
  'thank you', 'thank you.', 'thanks for watching', 'thank you for watching',
  'thanks for watching!', 'please subscribe', 'you', 'bye', 'bye.', 'okay', 'so',
  'subtitles by the amara.org community', '.', '...',
])

/** Level below which a phantom phrase is assumed invented rather than said. */
const QUIET_RMS = 0.02

/** 20 ms at 16 kHz: the unit speech is counted in. */
const FRAME = 320
/** A frame this many times its segment's noise floor (6 dB up) counts as sound. */
const ABOVE_FLOOR = 2
/** ...and never below about -54 dBFS, so digital silence is not "above" a floor of zero. */
const MIN_FRAME_RMS = 0.002
/**
 * Below this share of sounding frames a segment is mostly silence. The face's
 * own voice detector pads every segment with 300 ms before and 650 ms after,
 * so a real one-word "yes" still measures about 0.25; a knock or a click that
 * tripped the detector measures 0.02-0.1.
 */
const MIN_SPEECH_RATIO = 0.1

/**
 * Share of the segment's 20 ms frames that rise clearly above its own noise
 * floor (the quietest tenth of its frames). Whisper will read a sentence into
 * a second of near-silence with one click in it — and not only the sentences
 * on the phantom list — so how much of the audio is sound at all is the
 * check that does not depend on what it invented.
 * @param {Float32Array} samples 16 kHz mono
 */
export function speechRatio(samples) {
  const n = Math.floor(samples.length / FRAME)
  if (!n) return 0
  const levels = new Float64Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i] * samples[i]
    levels[f] = Math.sqrt(sum / FRAME)
  }
  const floor = Float64Array.from(levels).sort()[Math.floor((n - 1) * 0.1)]
  const bar = Math.max(floor * ABOVE_FLOOR, MIN_FRAME_RMS)
  let sounding = 0
  for (const level of levels) if (level > bar) sounding++
  return sounding / n
}

/**
 * Is this transcript something nobody actually said?
 * @param {string} text
 * @param {{ seconds: number, rms: number, speech?: number }} audio
 *   `speech` is speechRatio() of the audio that was transcribed, when known.
 */
export function isPhantom(text, { seconds, rms, speech }) {
  const t = text.toLowerCase().trim()
  if (!t || /^[\s\p{P}]*$/u.test(t)) return true
  if (seconds < 0.4) return true
  if (speech !== undefined && speech < MIN_SPEECH_RATIO) return true
  return PHANTOMS.has(t) && rms < QUIET_RMS
}
