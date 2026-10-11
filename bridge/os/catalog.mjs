import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

/**
 * What can be opened on this PC: the Start menu, as Windows itself lists it.
 *
 * Get-StartApps is the one list that covers every kind of app — classic .exe
 * installs, Store packages, Office's odd shell IDs, the admin consoles — with
 * the exact AppID that `shell:AppsFolder\<AppID>` launches. It is also slow
 * (measured 3.6 s from a cold PowerShell on this machine), so the result is
 * cached on disk and refreshed at most once a day.
 *
 * Each entry is tagged with a `kind` (how it would be launched) and a `risk`.
 * "High" marks the things that hand whoever is speaking a shell, the registry
 * or the machine's settings: they are never opened on a voice command alone.
 */

const execFileP = promisify(execFile)

/** One day: the Start menu changes when something is installed, which is rare. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The only command this module ever runs. It is a constant on purpose: nothing
 * anybody says reaches it. OutputEncoding is forced to UTF-8 because Windows
 * PowerShell otherwise writes in the console's legacy code page, which mangles
 * any app name outside ASCII.
 */
export const START_APPS_SCRIPT =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'

/** Flags for every PowerShell VAS starts: no profile, no prompts, no policy surprises. */
export const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

export const defaultSystemRoot = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows'

/**
 * Windows PowerShell by absolute path. Bare `powershell` would be looked up on
 * PATH, and anything earlier on PATH would be run in its place.
 */
export const powershellPath = (systemRoot = defaultSystemRoot()) =>
  win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const defaultExec = (file, args) =>
  execFileP(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 })

/** A drive path (`D:\Notepad++\notepad++.exe`) or a known-folder one (`{1AC14E77-…}\cmd.exe`). */
const PATH_LIKE = /^(?:[a-z]:\\|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\)/i

/**
 * Script hosts, not apps. A Start menu entry can point at any of these, and
 * launching one runs whatever it says — so they are classed together and
 * never opened by voice.
 */
const SCRIPT_EXT = /\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta)$/i

/**
 * Executables that are a shell or the registry in all but name. pwsh, wt and
 * regedt32 are not on this PC today, but they are the same doors.
 */
const HIGH_RISK_EXE = new Set([
  'cmd.exe', 'powershell.exe', 'powershell_ise.exe', 'pwsh.exe',
  'regedit.exe', 'regedt32.exe', 'wt.exe',
])

/** How an AppID would be launched. */
export function kindOf(appId) {
  if (/^https?:\/\//i.test(appId)) return 'url'
  if (SCRIPT_EXT.test(appId)) return 'script'
  if (/\.msc$/i.test(appId)) return 'msc'
  if (PATH_LIKE.test(appId) && /\.exe$/i.test(appId)) return 'exe'
  if (appId.includes('!')) return 'store'
  return 'shell'
}

/** 'high' for anything that hands over a shell, the registry or the system's settings. */
export function riskOf({ name, appId, kind }) {
  const file = win32.basename(appId).toLowerCase()
  const label = name.trim().toLowerCase()
  if (kind === 'script' || kind === 'msc') return 'high'
  if (HIGH_RISK_EXE.has(file)) return 'high'
  if (appId.includes('WindowsTerminal')) return 'high'
  if (appId === 'Microsoft.Windows.Shell.RunDialog') return 'high'
  if (appId === 'Microsoft.Windows.ControlPanel' || label === 'control panel') return 'high'
  if (label === 'task manager') return 'high'
  return 'normal'
}

const Row = z.object({ Name: z.string().trim().min(1), AppID: z.string().trim().min(1) })

/**
 * Get-StartApps JSON in, tagged entries out.
 *
 * ConvertTo-Json emits a bare object rather than a one-element array when
 * there is exactly one app, so both are accepted. Rows without a name or an
 * AppID are dropped rather than failing the whole list.
 *
 * @param {unknown} rows
 * @returns {Array<{ name: string, appId: string, kind: string, risk: 'high' | 'normal' }>}
 */
export function parseStartApps(rows) {
  const list = Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? [rows] : []
  const apps = []
  for (const row of list) {
    const parsed = Row.safeParse(row)
    if (!parsed.success) continue
    const name = parsed.data.Name
    const appId = parsed.data.AppID
    const kind = kindOf(appId)
    apps.push({ name, appId, kind, risk: riskOf({ name, appId, kind }) })
  }
  return apps
}

const CacheFile = z.object({
  fetchedAt: z.number(),
  apps: z.array(z.object({ name: z.string(), appId: z.string() }).passthrough()),
})

/**
 * The cached catalog, or null when there is none worth reading.
 *
 * Only names and AppIDs are trusted from the file. Kind and risk are worked
 * out again on every read, so a safety rule tightened in a newer VAS applies
 * at once, not after the cache next expires.
 */
async function readCache(cachePath) {
  if (!cachePath) return null
  let raw
  try {
    raw = JSON.parse(await readFile(cachePath, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[jarvis] app catalog cache is unreadable (${err.message}); refetching`)
    return null
  }
  const parsed = CacheFile.safeParse(raw)
  if (!parsed.success) {
    console.warn('[jarvis] app catalog cache is invalid; refetching')
    return null
  }
  const apps = parseStartApps(parsed.data.apps.map((a) => ({ Name: a.name, AppID: a.appId })))
  return { fetchedAt: parsed.data.fetchedAt, apps }
}

/** Written to a temp name and renamed, so a crash mid-write never leaves half a file. */
async function writeCache(cachePath, catalog) {
  if (!cachePath) return
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    const tmp = `${cachePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(catalog, null, 2) + '\n')
    await rename(tmp, cachePath)
  } catch (err) {
    console.warn(`[jarvis] could not save the app catalog (${err.message})`)
  }
}

/**
 * Ask Windows for the Start menu.
 *
 * An empty answer is treated as a failure, not as "no apps": every Windows
 * install has a Start menu, so nothing back means PowerShell misbehaved, and
 * an empty list must not overwrite a good cache.
 */
async function fetchStartApps(exec) {
  const out = await exec(powershellPath(), [...PS_FLAGS, '-Command', START_APPS_SCRIPT])
  const text = String(typeof out === 'string' ? out : out?.stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('Get-StartApps returned nothing')
  const apps = parseStartApps(JSON.parse(text))
  if (!apps.length) throw new Error('Get-StartApps listed no apps')
  return apps
}

/**
 * The app catalog: from the cache while it is fresh, from Windows otherwise.
 *
 * If Windows cannot be asked — PowerShell timed out, policy blocked it — a
 * stale cache is still far better than no apps at all, so it is returned
 * (marked `stale`) and the next call tries again.
 *
 * @param {{ exec?: (file: string, args: string[]) => Promise<{ stdout: string } | string>,
 *           cachePath?: string, maxAgeMs?: number, now?: () => number }} [opts]
 * @returns {Promise<{ fetchedAt: number, apps: ReturnType<typeof parseStartApps>, stale?: true }>}
 */
export async function loadCatalog({ exec = defaultExec, cachePath, maxAgeMs = DAY_MS, now = Date.now } = {}) {
  const cached = await readCache(cachePath)
  const t = now()
  if (cached && cached.fetchedAt <= t && t - cached.fetchedAt < maxAgeMs) return cached

  try {
    const catalog = { fetchedAt: t, apps: await fetchStartApps(exec) }
    await writeCache(cachePath, catalog)
    return catalog
  } catch (err) {
    if (!cached) throw err
    console.warn(`[jarvis] could not refresh the app catalog (${err.message}); using the saved one`)
    return { ...cached, stale: true }
  }
}
