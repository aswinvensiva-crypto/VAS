import { execFile as execFileCb, spawn as spawnCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { PS_FLAGS, defaultSystemRoot, powershellPath } from './catalog.mjs'

/**
 * Opening and closing Start menu apps.
 *
 * Every launch goes through one of two doors, both with the program and its
 * arguments passed as a list, never through a shell and never as a command
 * string: a plain .exe that exists on disk is started directly, and
 * everything else is handed to Explorer as `shell:AppsFolder\<AppID>` — the
 * same thing clicking the Start menu tile does, which is the only reliable way
 * to start Store apps and Office's shell IDs.
 *
 * The AppID comes from the catalog, never from speech, but it is still
 * checked here, because this is the last place a forged one could be stopped.
 */

const execFileP = promisify(execFileCb)

/**
 * No quotes, control characters or redirection — nothing that could end the
 * argument early or mean something to a command line further down.
 */
const SAFE_APP_ID = /^[^"\r\n\t<>|]{1,300}$/

/**
 * A process name as Get-Process -Name takes it. Narrower than it looks on
 * purpose: no wildcards (`*`, `?`, `[`) so one name cannot close every app,
 * no comma since names travel comma-joined, and no leading '-' so a name can
 * never be read by PowerShell as a parameter.
 */
const SAFE_PROCESS = /^\w[\w.+ -]{0,63}$/

/** Most apps close-app.ps1 is asked about at once: one app's processes, rarely more. */
const MAX_PROCESS_NAMES = 8

export const CLOSE_SCRIPT = fileURLToPath(new URL('./close-app.ps1', import.meta.url))

/** Start the program and stop waiting once Windows has it, or has refused it. */
function started(child) {
  return new Promise((resolve, reject) => {
    // A listener must stay attached for the child's whole life: an 'error'
    // nobody listens for would take the bridge down with it.
    child.on('error', (err) => reject(err))
    child.once('spawn', () => resolve())
  })
}

/**
 * Open an app from the catalog.
 *
 * Scripts and web links are refused outright: the first would run whatever
 * the file says, the second is the browser's job. Explorer exits with code 1
 * even when the launch worked, so 1 counts as success.
 *
 * @param {{ name?: string, appId: string, kind: string }} app
 * @param {{ execFile?: Function, spawn?: Function, exists?: (p: string) => boolean | Promise<boolean>,
 *           systemRoot?: string }} [deps]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function launchApp(app, {
  execFile = execFileP,
  spawn = spawnCb,
  exists = existsSync,
  systemRoot = defaultSystemRoot(),
} = {}) {
  if (!app || typeof app.appId !== 'string' || typeof app.kind !== 'string') {
    return { ok: false, reason: "I don't have a Start menu entry for that." }
  }
  if (app.kind === 'script') {
    return { ok: false, reason: "That Start menu entry is a script, not an app, and I don't run scripts." }
  }
  if (app.kind === 'url') {
    return { ok: false, reason: 'That Start menu entry is a web link, not an app. I can open it in the browser instead.' }
  }
  if (!SAFE_APP_ID.test(app.appId)) {
    return { ok: false, reason: "That app's ID has characters in it I won't pass to Windows." }
  }

  const { appId } = app
  if (app.kind === 'exe' && /^[a-z]:\\/i.test(appId) && (await exists(appId))) {
    try {
      const child = spawn(appId, [], { detached: true, stdio: 'ignore', cwd: win32.dirname(appId), windowsHide: false })
      await started(child)
      child.unref()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `Windows wouldn't start it (${err.code ?? err.message}).` }
    }
  }

  try {
    await execFile(win32.join(systemRoot, 'explorer.exe'), [`shell:AppsFolder\\${appId}`], { windowsHide: true })
    return { ok: true }
  } catch (err) {
    if (err?.code === 1) return { ok: true }
    return { ok: false, reason: `Windows wouldn't open it (${err?.code ?? err?.message ?? 'unknown error'}).` }
  }
}

/**
 * Image names of well-known apps, by a fragment of their AppID. Store and
 * shell AppIDs say nothing about the process they start, so these are learned
 * by hand. Order matters: the Insiders entry must be tried before the plain
 * VS Code one, whose AppID is a prefix of it.
 */
const KNOWN_PROCESSES = [
  ['Chrome', 'chrome'],
  ['MSEdge', 'msedge'],
  ['Spotify', 'Spotify'],
  ['WhatsApp', 'WhatsApp'],
  ['VisualStudioCodeInsiders', 'Code - Insiders'],
  ['VisualStudioCode', 'Code'],
  ['WindowsNotepad', 'Notepad'],
  ['WindowsCalculator', 'CalculatorApp'],
  ['WindowsTerminal', 'WindowsTerminal'],
  ['OutlookForWindows', 'olk'],
  ['WINWORD', 'WINWORD'],
  ['EXCEL', 'EXCEL'],
  ['POWERPNT', 'POWERPNT'],
  ['Claude', 'claude'],
  ['Zoom', 'Zoom'],
  ['Explorer', 'explorer'],
]

/**
 * The process names an app runs as, for closing it. Empty when unknown: the
 * caller then says so instead of guessing, since a wrong guess closes the
 * wrong program.
 *
 * @param {{ appId: string, kind: string }} app
 * @returns {string[]}
 */
export function processNamesFor(app) {
  if (!app || typeof app.appId !== 'string') return []
  if (app.kind === 'exe') return [win32.basename(app.appId).replace(/\.exe$/i, '')]
  const known = KNOWN_PROCESSES.find(([fragment]) => app.appId.includes(fragment))
  return known ? [known[1]] : []
}

/**
 * Ask an app's windows to close, the way clicking X does: unsaved work gets
 * its "save changes?" prompt, and nothing is ever killed.
 *
 * Names travel to close-app.ps1 as a single comma-joined argument, because
 * `powershell -File` binds only one value to an array parameter and treats
 * the rest as stray positional arguments.
 *
 * @param {string[]} names  process names, from processNamesFor or apps.json
 * @param {{ execFile?: Function, systemRoot?: string }} [deps]
 * @returns {Promise<{ ok: boolean, closed: number, reason?: string }>}
 *   `closed` is how many windows were asked to close.
 */
export async function closeApp(names, { execFile = execFileP, systemRoot = defaultSystemRoot() } = {}) {
  const list = [...new Set(Array.isArray(names) ? names : [names])]
  if (!list.length) return { ok: false, closed: 0, reason: "I don't know which program that app runs as." }
  if (list.length > MAX_PROCESS_NAMES || !list.every((n) => typeof n === 'string' && SAFE_PROCESS.test(n))) {
    return { ok: false, closed: 0, reason: "That isn't a process name I'll pass to Windows." }
  }
  try {
    const { stdout } = await execFile(
      powershellPath(systemRoot),
      [...PS_FLAGS, '-File', CLOSE_SCRIPT, '-ProcessName', list.join(',')],
      { windowsHide: true, timeout: 15000, maxBuffer: 1 << 16 },
    )
    const last = String(stdout ?? '').trim().split(/\r?\n/).pop()
    const closed = /^\d+$/.test(last ?? '') ? Number(last) : NaN
    if (!Number.isInteger(closed)) return { ok: false, closed: 0, reason: "Windows didn't say whether it closed." }
    return { ok: true, closed }
  } catch (err) {
    return { ok: false, closed: 0, reason: `I couldn't ask it to close (${err?.code ?? err?.message ?? 'unknown error'}).` }
  }
}
