import { mkdirSync, watch } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where VAS keeps what it learns about you: settings, which apps you have
 * allowed, corrections, taught routines, the audit log.
 *
 * %APPDATA%\VAS\data on Windows. A `data` subfolder rather than the app folder
 * itself, because Electron fills its userData folder (%APPDATA%\VAS) with
 * Chromium caches, and these few small files should be easy to find, back up
 * or delete by hand.
 */
export function dataDir() {
  const dir =
    process.env.JARVIS_DATA_DIR ??
    (process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'VAS', 'data')
      : join(homedir(), '.config', 'VAS', 'data'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Read one JSON file and validate it.
 *
 * A missing file is normal (first run) and yields the defaults. A file that is
 * there but broken — hand-edited, half-written by a crash — also yields the
 * defaults, loudly, rather than taking the assistant down: the user can fix
 * the file, but only if the app is running to tell them which one.
 *
 * @template T
 * @param {string} name   file name inside dataDir()
 * @param {import('zod').ZodType<T>} schema
 * @returns {Promise<T>}
 */
export async function readJson(name, schema) {
  const path = join(dataDir(), name)
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[jarvis] ${name} is unreadable (${err.message}); using defaults`)
    raw = undefined
  }
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  console.warn(`[jarvis] ${name} is invalid; using defaults:`, parsed.error.issues[0]?.message)
  return schema.parse({})
}

/**
 * Write a file so it is never seen half-written: to a temp name first, then
 * renamed over the real one, which is atomic on the same volume.
 */
export async function writeJsonAtomic(name, value) {
  const path = join(dataDir(), name)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
  await rename(tmp, path)
}

/**
 * Call `onChange` when the named file is edited by hand, debounced because
 * editors save in several writes. Returns a function that stops watching.
 */
export function watchData(name, onChange, debounceMs = 200) {
  let timer = null
  const watcher = watch(dataDir(), (_event, file) => {
    if (file !== name) return
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
