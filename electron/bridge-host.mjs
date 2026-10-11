import { app, utilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { createWriteStream, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../bridge/store/files.mjs'

/**
 * JARVIS's brain, run as an Electron utility process.
 *
 * The bridge is the same Node program `npm run bridge` starts, unchanged. Here
 * it gets a fresh 256-bit token for this launch, a port the OS chooses, and a
 * supervisor: if it dies it is restarted with a short backoff on the same port
 * (so the open window simply reconnects), and its output goes to bridge.log in
 * the data folder rather than vanishing with no console to print to.
 *
 * The window is only created once the bridge says it is listening, so the face
 * never boots against a brain that isn't there yet.
 */
export function startBridgeHost({ root }) {
  const token = randomBytes(32).toString('hex')
  const logPath = join(dataDir(), 'bridge.log')
  try {
    if (statSync(logPath).size > 5 * 1024 * 1024) renameSync(logPath, `${logPath}.1`)
  } catch {
    /* no log yet */
  }
  const log = createWriteStream(logPath, { flags: 'a' })

  // Packaged builds unpack Claude Code's executable out of app.asar; point the
  // SDK at it explicitly. In development the SDK finds its own.
  const claudeExe = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
    : ''

  const state = {
    token,
    port: 0,
    get ws() {
      return `ws://127.0.0.1:${state.port}`
    },
    get http() {
      return `http://127.0.0.1:${state.port}`
    },
  }

  let child = null
  let stopping = false
  let failures = 0
  const listeners = new Set()

  function spawn() {
    return new Promise((resolve, reject) => {
      child = utilityProcess.fork(join(root, 'bridge', 'boot.cjs'), [], {
        serviceName: 'VAS Bridge',
        stdio: 'pipe',
        env: {
          ...process.env,
          JARVIS_BRIDGE_TOKEN: token,
          JARVIS_BRIDGE_PORT: String(state.port || 0),
          ...(claudeExe ? { JARVIS_CLAUDE_EXE: claudeExe } : {}),
        },
      })
      const stamp = () => new Date().toISOString()
      child.stdout?.on('data', (d) => log.write(d))
      child.stderr?.on('data', (d) => log.write(d))
      child.once('spawn', () => log.write(`--- ${stamp()} bridge started (pid ${child.pid})\n`))

      const timer = setTimeout(() => reject(new Error('the bridge did not start within 20 s')), 20_000)
      child.once('message', (m) => {
        if (m?.type !== 'listening') return
        clearTimeout(timer)
        const moved = state.port !== 0 && state.port !== m.port
        state.port = m.port
        failures = 0
        resolve()
        for (const fn of listeners) fn({ moved })
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        log.write(`--- ${stamp()} bridge exited (${code})\n`)
        if (stopping) return
        // A port taken while we were down would fail forever; let the OS pick.
        if (++failures > 1) state.port = 0
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
        setTimeout(() => spawn().catch((err) => log.write(`restart failed: ${err.message}\n`)), delay)
        reject(new Error(`the bridge exited with code ${code}`))
      })
    })
  }

  return {
    state,
    start: spawn,
    /** Called after every (re)start; `moved` means the port changed. */
    onListening: (fn) => listeners.add(fn),
    restart: () => {
      child?.kill()
    },
    stop: () => {
      stopping = true
      child?.kill()
      log.end()
    },
  }
}
