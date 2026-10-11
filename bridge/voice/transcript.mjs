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

/**
 * Is this transcript something nobody actually said?
 * @param {string} text
 * @param {{ seconds: number, rms: number }} audio
 */
export function isPhantom(text, { seconds, rms }) {
  const t = text.toLowerCase().trim()
  if (!t || /^[\s\p{P}]*$/u.test(t)) return true
  if (seconds < 0.4) return true
  return PHANTOMS.has(t) && rms < QUIET_RMS
}
