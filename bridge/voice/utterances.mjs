import { randomUUID } from 'node:crypto'

/**
 * What the bridge heard, by segment.
 *
 * /stt hands the face an opaque `utt` id with every transcript, and the face
 * sends those ids back with the question or the "yes" they became. That lets
 * the bridge judge an ask on its own record of the speech — whose voice it was,
 * and the words before any learned correction — instead of on whatever the
 * face claims.
 *
 * Kept in memory for two minutes: long enough for the slowest turn to come
 * back, short enough that nothing said in the room lingers.
 *
 * Minimal on purpose; the voice package owns the full store, and this file
 * only fixes the shape the rest of the bridge relies on:
 *   get(id) -> { owner, raw, text, ... } | null
 */
const TTL_MS = 2 * 60_000

export function createUtterances({ ttlMs = TTL_MS, now = Date.now } = {}) {
  const items = new Map()
  const fresh = (entry) => now() - entry.at <= ttlMs

  const sweep = () => {
    for (const [id, entry] of items) if (!fresh(entry)) items.delete(id)
  }

  return {
    /** Remember one segment; returns its id. */
    put(entry) {
      sweep()
      const id = randomUUID()
      items.set(id, { ...entry, at: now() })
      return id
    },
    /** The segment, or null when the id is unknown or has expired. */
    get(id) {
      if (typeof id !== 'string') return null
      const entry = items.get(id)
      if (!entry) return null
      if (!fresh(entry)) {
        items.delete(id)
        return null
      }
      return entry
    },
  }
}

/** The bridge's one store, shared by /stt and the socket. */
export const utterances = createUtterances()
