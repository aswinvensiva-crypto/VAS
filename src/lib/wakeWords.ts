import aliases from '../../config/wake-aliases.json'

/**
 * JARVIS's name, in every spelling a transcriber hands back.
 *
 * One list, shared with the bridge (config/wake-aliases.json), so the wake
 * regex, the barge-in override and the vocative stripping cannot drift apart —
 * they used to be three hand-copied lists in two files, and had already
 * diverged.
 */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAMES = `(?:${aliases.names.map(escape).join('|')})`
const PREFIX = `(?:${aliases.prefixes.map(escape).join('|')})`

/** The canonical spelling, for the few places that want just the one. */
export const NAME = aliases.names[0]

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and recognisers routinely return Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
export const WAKE = new RegExp(`\\b${PREFIX}?\\s*${NAMES}\\b(?!'s)`, 'i')

/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
export const BARE_NAME = new RegExp(`^${PREFIX}?\\s*${NAMES}[\\s,.!?]*$`, 'i')

/** A leading vocative on a real command: "Jarvis, what's the weather". */
export const LEADING_NAME = new RegExp(`^${PREFIX}?\\s*${NAMES}\\b[\\s,.:!?-]*`, 'i')

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
export const OVERRIDE = new RegExp(
  `\\b(stop|wait|${escape(NAME)}|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\\b`,
  'i',
)

/** Everything after the wake phrase, which is usually the actual command. */
export function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}
