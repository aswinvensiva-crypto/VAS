import { OVERRIDE } from './wakeWords'

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
export const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
export const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
export const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
export function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

/**
 * Where a transcript came from, as the bridge reported it: the words exactly
 * as transcribed, before any learned correction, and the bridge's id for the
 * segment. Both are absent on the browser's own recogniser.
 */
export type SegmentSource = { raw?: string; utt?: string }

/**
 * What an assembled utterance carries besides its words: the raw words of
 * every segment in it, joined the same way, and their ids. The bridge judges a
 * spoken "yes" and learns corrections from `raw`, and looks `utts` up to know
 * whose voice it was.
 */
export type Heard = { raw: string; utts: string[] }

export type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean, from?: SegmentSource) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

/** The voice loop's diagnostics, which the assembler keeps current. */
type AssemblerDiag = { holding: string; waitedMs: number }

const join = (a: string, b: string) => `${a} ${b}`.replace(/\s+/g, ' ').trim()

export function makeAssembler(h: {
  emit: (text: string, heard: Heard) => void
  partial: (text: string) => void
  /** Where to publish what is held and how long it waited; optional so a test
   *  can run the assembler on its own. */
  diag?: AssemblerDiag
}): Assembler {
  const diag: AssemblerDiag = h.diag ?? { holding: '', waitedMs: 0 }
  let held = ''
  let heldRaw = ''
  let utts: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const reset = () => {
    held = ''
    heldRaw = ''
    utts = []
    firstAt = 0
  }

  const fire = () => {
    clear()
    const text = held.trim()
    const heard = { raw: heldRaw, utts }
    reset()
    if (text) h.emit(text, heard)
  }

  return {
    feed(text, active, from = {}) {
      if (!text.trim()) return
      held = join(held, text)
      // A segment with no raw words of its own was not corrected: the words
      // are the raw words.
      heldRaw = join(heldRaw, from.raw ?? text)
      if (from.utt) utts = [...utts, from.utt]
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      reset()
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Answering a question
// ---------------------------------------------------------------------------

/**
 * How long after he stops speaking before anything said can answer "shall I?".
 *
 * The speakers falling silent is not the microphone falling silent: the last
 * syllable is still arriving for a moment, through the air and the capture
 * pipeline. A segment that began inside that margin started over him, and the
 * one thing it must never be is his own question approving itself.
 */
export const ANSWER_GAP_MS = 250

/**
 * Can speech that began at `startedAt` be the answer to the open question?
 *
 * Only if it began after the question finished playing (`questionEnd`,
 * Infinity while it still is) and after anything else he was saying at the
 * time (`spokeUntil` — a turn still finishing its own sentence over the
 * question can say "sure" just as well), plus the margin above. All on the
 * Date.now() clock.
 *
 * An answer that clears this is let through without the echo check: it
 * naturally repeats the question ("yes, close Spotify"), and the bag-of-words
 * test would throw exactly that answer away as JARVIS hearing himself.
 */
export function answersQuestion(
  startedAt: number,
  { questionEnd, spokeUntil }: { questionEnd: number; spokeUntil: number },
): boolean {
  return startedAt >= Math.max(questionEnd, spokeUntil) + ANSWER_GAP_MS
}
