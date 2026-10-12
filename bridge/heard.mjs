import { z } from 'zod'
import { audit as defaultAudit } from './store/audit.mjs'
import { utterances } from './voice/utterances.mjs'

/**
 * What the face says about the speech behind a question or a spoken answer,
 * and what the bridge's own record says about it.
 *
 * An ask or a confirmation reply arrives with the words twice: `text`, after
 * any learned correction, which is what neurons route on, and `raw`, exactly
 * as transcribed, which is what a "yes" is judged on and what a correction is
 * learned from. With them come `utts`, the ids /stt gave each segment the words
 * were heard in, so the bridge can look up whose voice they were in rather
 * than take the face's word for it.
 *
 * Both are optional: typed text, the browser's own recogniser and an older
 * face send neither, and those questions are handled exactly as before.
 */
const HeardSchema = z.object({
  raw: z.string().max(4000).optional().catch(undefined),
  utts: z.array(z.string().min(1).max(128)).max(64).optional().catch(undefined),
})

/**
 * The `raw` and `utts` of a frame. Anything malformed is ignored rather than
 * fatal: a question with a broken id list is still a question.
 *
 * @returns {{ raw?: string, utts: string[] }}
 */
export function heardOf(frame) {
  const parsed = HeardSchema.safeParse(frame ?? {})
  const { raw, utts } = parsed.success ? parsed.data : {}
  return { ...(raw?.trim() ? { raw } : {}), utts: [...new Set(utts ?? [])] }
}

/** One segment's speaker verdict, whether the store keeps it bare or with its score. */
const verdictOf = (entry) => (typeof entry?.owner === 'string' ? entry.owner : entry?.owner?.verdict)

/**
 * Whose voice a run of segments was in, on the bridge's own record.
 *
 * 'other' only when every segment was judged someone else's — one segment in
 * the owner's voice is enough to make the words theirs to act on, and one the
 * store no longer remembers is not evidence of anything. 'owner' only when
 * every segment was. Anything mixed is 'unknown', which the permission gate
 * treats as too close to call on its own.
 *
 * @param {string[]} utts
 * @param {{ get: (id: string) => object | null }} [store]
 * @returns {'owner' | 'other' | 'unknown' | null}  null: nothing to judge by
 */
export function voiceOf(utts, store = utterances) {
  if (!utts?.length) return null
  const verdicts = utts.map((id) => verdictOf(store.get(id)))
  const known = verdicts.filter(Boolean)
  if (!known.length) return null
  const all = (v) => known.length === verdicts.length && known.every((k) => k === v)
  if (all('other')) return 'other'
  if (all('owner')) return 'owner'
  return 'unknown'
}

/**
 * Is this question someone else's — the TV, a visitor — and so not one to
 * answer at all?
 *
 * Only when config.json's owner.require is 'all' ("only my voice"), only once
 * a voice is enrolled, and only on the bridge's record of every segment it was
 * spoken in. /stt already refuses to transcribe such speech under 'all'; this
 * catches what reaches the face another way (Scribe, compressed audio), before
 * any neuron, remembered app or Claude turn can act on it. Under 'actions'
 * ("anyone can talk") and 'off' other voices are answered — only the gate,
 * judging a yes, still cares whose voice it was. Audited, so a JARVIS that
 * ignored you can be explained.
 */
export function fromOtherVoice(heard, { enrolled, require = 'all', store = utterances, audit = defaultAudit } = {}) {
  if (require !== 'all' || !enrolled || voiceOf(heard?.utts, store) !== 'other') return false
  audit({
    kind: 'ask',
    name: 'ignored',
    args: { segments: heard.utts.length },
    decision: 'deny',
    reason: 'other-voice',
    owner: { verdict: 'other' },
  })
  return true
}

/**
 * A confirmation reply, with whose voice it was in decided here.
 *
 * Whatever `owner` the face put on the reply is dropped. In its place goes the
 * verdict looked up for the answer's own segments, so a "yes" from the TV
 * counts as not the owner's even if it was the last thing said; with no
 * segments to go on (a click, the browser's recogniser) the gate falls back to
 * whoever spoke last.
 */
export function judgedReply(reply, { enrolled, store = utterances } = {}) {
  const rest = { ...reply }
  delete rest.owner
  const verdict = enrolled ? voiceOf(heardOf(reply).utts, store) : null
  return verdict ? { ...rest, owner: verdict } : rest
}
