import { randomBytes } from 'node:crypto'

/**
 * What was just said, segment by segment, for two minutes.
 *
 * Every /stt result carries an opaque id for its segment. The face hands the
 * ids back with whatever the words turned into — the ask a command became,
 * the spoken yes to "shall I?" — and the bridge looks the segment up here,
 * rather than trusting the face's copy, for two things only it knows: whose
 * voice it was (the speaker verdict the permission gate weighs) and exactly
 * what the recogniser heard before corrections were applied (what a new
 * correction is learned from).
 *
 * In memory only, and short-lived: an id is worth something while the turn
 * it belongs to is still going, and nothing said to JARVIS is kept longer
 * than that. Capped, so a stream of segments nobody asks about cannot grow it.
 */

const TTL_MS = 2 * 60_000
const MAX = 256
const VERDICTS = new Set(['owner', 'other', 'unknown', 'unenrolled'])

/**
 * @typedef {{ text: string, raw: string, owner: 'owner'|'other'|'unknown'|'unenrolled',
 *             score?: number, durationMs: number|null, mode: string|null, at: number }} Utterance
 */

export function createUtterances({ ttlMs = TTL_MS, max = MAX, now = Date.now } = {}) {
  /** id -> utterance, oldest first (a Map keeps insertion order). */
  const byId = new Map()

  function prune() {
    const cutoff = now() - ttlMs
    for (const [id, u] of byId) {
      if (u.at > cutoff) break
      byId.delete(id)
    }
  }

  return {
    /**
     * Keep one segment; returns its id. `at` is always now, so the oldest
     * entry is always the first one.
     * @param {{ text?: string, raw?: string, owner?: string, score?: number,
     *           durationMs?: number|null, mode?: string|null }} entry
     */
    put(entry) {
      prune()
      const text = String(entry.text ?? '')
      const id = randomBytes(9).toString('base64url')
      byId.set(id, {
        ...entry,
        text,
        raw: String(entry.raw ?? text),
        owner: VERDICTS.has(entry.owner) ? entry.owner : 'unknown',
        durationMs: entry.durationMs ?? null,
        mode: entry.mode ?? null,
        at: now(),
      })
      while (byId.size > max) byId.delete(byId.keys().next().value)
      return id
    },
    /** @returns {Utterance | null} a copy, or null for an unknown or expired id. */
    get(id) {
      if (typeof id !== 'string') return null
      prune()
      const u = byId.get(id)
      return u ? { ...u } : null
    },
    get size() {
      prune()
      return byId.size
    },
  }
}

/** The bridge's one store: /stt writes it, asks and confirm replies read it. */
export const utterances = createUtterances()
