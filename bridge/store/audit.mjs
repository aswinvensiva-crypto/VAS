import { appendFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './files.mjs'

/**
 * A plain record of everything JARVIS did on your behalf: which app it opened,
 * what it clicked, which confirmations you gave or refused, and whose voice
 * gave them. One JSON object per line in %APPDATA%\VAS\data\audit.log, so it
 * reads in any text editor and greps cleanly.
 *
 * Text JARVIS typed for you is logged as its length only — the log is for
 * seeing what happened, not a second copy of your messages.
 */
const MAX_BYTES = 5 * 1024 * 1024

const path = () => join(dataDir(), 'audit.log')

/** Strip anything that would copy typed or dictated content into the log. */
export function redact(args) {
  if (!args || typeof args !== 'object') return args
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    out[k] = (k === 'text' || k === 'value') && typeof v === 'string' ? { length: v.length } : v
  }
  return out
}

let chain = Promise.resolve()

/**
 * Append one entry. Writes are queued so lines never interleave, and a failure
 * to log never fails the action it describes.
 *
 * @param {{ kind: string, name?: string, args?: object, tier?: string,
 *           decision?: string, reason?: string, owner?: object, ok?: boolean }} entry
 */
export function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, args: redact(entry.args) }) + '\n'
  chain = chain
    .then(async () => {
      try {
        if ((await stat(path())).size > MAX_BYTES) await rename(path(), `${path()}.1`)
      } catch {
        /* no log yet */
      }
      await appendFile(path(), line)
    })
    .catch((err) => console.warn('[jarvis] audit write failed:', err.message))
  return chain
}
