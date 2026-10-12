/**
 * Which installed system voice JARVIS speaks with.
 *
 * Kept apart from tts.ts, which needs a browser, so the ranking can be tested
 * on its own: it is a list of names and numbers, and the numbers are the part
 * that keeps being wrong on somebody's machine.
 */

/** A voice as the ranking sees it. SpeechSynthesisVoice has more; tests pass less. */
export type VoiceLike = { name: string; lang: string }

/**
 * Rank installed voices by how close they are to the character: a British
 * male, low and level, not a novelty voice.
 *
 * The big win on macOS is the Enhanced/Premium variant of Daniel. The stock
 * "Daniel" is a compact voice from a decade ago and sounds it; the Enhanced
 * download is free (System Settings → Accessibility → Spoken Content → System
 * Voice → Manage Voices) and once installed it appears here automatically.
 */
export function scoreVoice(v: VoiceLike): number {
  const n = v.name.toLowerCase()
  let s = 0

  // The macOS British male, and the closest thing to the character available
  // without leaving the machine.
  if (n.startsWith('daniel')) s += 100
  else if (n.includes('google uk english male')) s += 85
  else if (/\b(oliver|arthur|jamie|malcolm)\b/.test(n)) s += 80
  // Newer macOS en-GB male voices — casual, but serviceable.
  else if (/\b(reed|rocko|eddy)\b/.test(n)) s += 40
  // Windows. The OneCore voices are what Chrome, Edge and Electron expose on
  // Windows 11; the en-GB male is the nearest to the character, the US and
  // en-IN males are clear and well-paced.
  else if (/^microsoft (ryan|thomas)\b/.test(n)) s += 85
  else if (/^microsoft george\b/.test(n)) s += 80
  else if (/^microsoft (mark|david|guy|ravi|prabhat)\b/.test(n)) s += 60
  // The Windows female voices: clear, and on plenty of machines the only
  // English ones installed. Usable — the picker can reach them, and a laptop
  // with nothing else speaks with one rather than an unranked default — but
  // ranked under the male voices, because the character is one.
  else if (/^microsoft (zira|hazel|heera)\b/.test(n)) s += 35

  // Higher-quality variants of whatever matched above.
  if (n.includes('premium')) s += 30
  else if (n.includes('enhanced') || n.includes('(natural)')) s += 20

  if (/en[-_]gb/i.test(v.lang)) s += 25
  else if (/^en/i.test(v.lang)) s += 5

  // Voices that clearly aren't a butler.
  if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/.test(n)) {
    s -= 200
  }
  // Other female-presenting names across the English sets.
  if (/\b(flo|sandy|shelley|kate|serena|fiona|moira|karen|tessa|samantha|zoe|allison|ava|susan)\b/.test(n)) {
    s -= 60
  }

  return s
}

/** Only voices that scored on a name match, not merely on being English —
 *  otherwise the picker cycles through a dozen US novelty voices. */
export const USABLE = 40

/** Best-first list of usable English voices — also what the voice picker cycles. */
export function rankVoices<V extends VoiceLike>(voices: readonly V[]): V[] {
  return voices
    .filter((v) => /^en/i.test(v.lang))
    .map((v) => ({ v, s: scoreVoice(v) }))
    .filter((x) => x.s >= USABLE)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v)
}

/**
 * The voice to speak with: the one named in the settings whenever it is
 * installed, else the best-ranked, else any English voice at all. A preferred
 * voice that is missing is passed over, not forgotten — it is used again the
 * moment it is reinstalled.
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], preferred: string | null): V | null {
  if (preferred) {
    const exact = voices.find((v) => v.name === preferred)
    if (exact) return exact
  }
  return rankVoices(voices)[0] ?? voices.find((v) => /^en/i.test(v.lang)) ?? null
}
