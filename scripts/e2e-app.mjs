/**
 * End-to-end check of the packaged app (release/win-unpacked/VAS.exe).
 *
 *   npm run e2e:app            # after npm run dist (or dist:dir)
 *   node scripts/e2e-app.mjs [path\to\VAS.exe]
 *
 * Covers the parts of the plan's end-to-end list that need the real app and
 * no human: it starts hidden, listens on loopback only, refuses a request
 * without the session token, answers a local order quickly, does not start
 * Chrome, and leaves no process behind - neither after a normal quit nor after
 * the main process is killed outright (the bridge's watchdog). A last run
 * starts it as on a fresh computer — no saved data, no voice models, no
 * Claude sign-in — and checks it starts, says what is missing, and answers a
 * question meant for Claude with a sentence that says what to do.
 *
 *   npm run e2e:app -- --memory   # also: the memory check (needs the voice models)
 *
 * The memory check starts the app hidden, has the bridge transcribe a few
 * spoken clips so Whisper loads, and then checks that the 3D scene is not
 * drawing while hidden and that Whisper is let go once it has been idle.
 *
 * It drives the window over the Chrome DevTools protocol on a loopback port,
 * so it never needs a click. Speech is not involved: the voice pipeline has
 * its own tests.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)
const EXE = resolve(ARGS.find((a) => !a.startsWith('--')) ?? join(ROOT, 'release', 'win-unpacked', 'VAS.exe'))
const MEMORY = ARGS.includes('--memory')
const APP_DIR = dirname(EXE)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every process whose executable lives under the unpacked app (VAS.exe, its helpers, claude.exe). */
function appProcesses() {
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${APP_DIR.replace(/'/g, "''")}', 'OrdinalIgnoreCase') } | ` +
    `ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, name, ...cmd] = line.split('|')
      return { pid: Number(pid), ppid: Number(ppid), name, cmd: cmd.join('|') }
    })
}

function chromeRunning() {
  const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8' })
  return /chrome\.exe/i.test(out)
}

/** Listening TCP sockets owned by the given pids: [{ address, port, pid }]. */
function listeners(pids) {
  const out = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0] === 'TCP' && f[3] === 'LISTENING' && pids.has(Number(f[4])))
    .map((f) => ({ address: f[1].slice(0, f[1].lastIndexOf(':')), port: Number(f[1].slice(f[1].lastIndexOf(':') + 1)), pid: Number(f[4]) }))
}

const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

/** A tiny DevTools client: evaluate an expression in the VAS window. */
async function devtools(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => ws.once('open', r).once('error', j))
  let id = 0
  const waiting = new Map()
  ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    }
  })
  const evaluate = (expression) =>
    new Promise((r) => {
      const n = ++id
      waiting.set(n, (m) => r(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description))
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  return { url: page.url, evaluate, close: () => ws.terminate() }
}

/** `extraEnv` entries set to undefined are removed from the app's environment. */
async function launch(extraEnv = {}) {
  const port = await freePort()
  const env = { ...process.env, ...extraEnv }
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k]
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', env })
  child.unref()
  const dt = await waitFor(() => devtools(port), 60_000, 'the VAS window')
  // The face boots, probes the bridge and connects before it is useful.
  await waitFor(async () => (await dt.evaluate('Boolean(window.vas?.bridge?.http)')) === true, 30_000, 'window.vas')
  return { port, dt, mainPid: child.pid }
}

async function main() {
  if (!existsSync(EXE)) throw new Error(`${EXE} not found - run npm run dist:dir first`)
  if (appProcesses().length) throw new Error('VAS is already running from this folder; quit it first')
  const chromeBefore = chromeRunning()

  // --- run 1: normal start, checks, normal quit -----------------------------
  let { dt, port } = await launch()
  check('starts hidden and loads the face from app://vas', dt.url.startsWith('app://vas/'), dt.url)

  const procs = appProcesses()
  const own = listeners(new Set(procs.map((p) => p.pid))).filter((l) => l.port !== port)
  check('listens on loopback only', own.length > 0 && own.every((l) => l.address === '127.0.0.1'), own.map((l) => `${l.address}:${l.port}`).join(' '))

  const http = await dt.evaluate('window.vas.bridge.http')
  const noToken = await fetch(`${http}/health`).then((r) => r.status)
  check('a request without the session token is refused', noToken === 401, `HTTP ${noToken}`)

  const timing = await dt.evaluate(`new Promise((resolve) => {
    const b = window.vas.bridge
    const ws = new WebSocket(b.ws, ['vas.v1', 'vas.token.' + b.token])
    let sent = 0
    ws.onopen = () => { sent = performance.now(); ws.send(JSON.stringify({ type: 'ask', text: 'what time is it', id: 'e2e-time' })) }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.ask === 'e2e-time' && m.type === 'done') { ws.close(); resolve(JSON.stringify({ ms: Math.round(performance.now() - sent), text: m.text, local: m.local })) }
    }
    setTimeout(() => resolve('null'), 15000)
  })`)
  const t = JSON.parse(timing ?? 'null')
  check('"what time is it" is answered on this PC in under 300 ms', Boolean(t && t.local === 'time' && t.ms < 300), t ? `${t.ms} ms, "${t.text}"` : 'no answer')

  check('does not start Chrome', chromeBefore || !chromeRunning(), chromeBefore ? 'Chrome was already running' : '')

  await dt.evaluate('window.vas.quit()')
  dt.close()
  const leftAfterQuit = await waitFor(async () => (appProcesses().length === 0 ? [] : null), 15_000, 'a clean exit').catch(() => appProcesses())
  check('a normal quit leaves no process behind', leftAfterQuit.length === 0, leftAfterQuit.map((p) => `${p.name}:${p.pid}`).join(' '))

  // --- run 2: the main process is killed outright ---------------------------
  ;({ dt } = await launch())
  // Let the Claude session prewarm, so claude.exe is part of what must go.
  await sleep(6_000)
  const before = appProcesses()
  const main = before.find((p) => p.name.toLowerCase() === 'vas.exe' && !/--type=/.test(p.cmd))
  dt.close()
  execFileSync('taskkill.exe', ['/F', '/PID', String(main.pid)])
  const leftAfterKill = await waitFor(async () => (appProcesses().length === 0 ? [] : null), 20_000, 'the watchdog').catch(() => appProcesses())
  check(
    'killing VAS outright leaves no bridge or claude.exe behind',
    leftAfterKill.length === 0,
    leftAfterKill.length ? `left: ${leftAfterKill.map((p) => `${p.name}:${p.pid}`).join(' ')}` : `${before.length} processes, all gone`,
  )
  for (const p of leftAfterKill) {
    try {
      execFileSync('taskkill.exe', ['/F', '/PID', String(p.pid)])
    } catch {
      /* already gone */
    }
  }

  // --- run 3: a fresh computer -----------------------------------------------
  const fresh = mkdtempSync(join(tmpdir(), 'vas-e2e-fresh-'))
  ;({ dt } = await launch({
    JARVIS_DATA_DIR: join(fresh, 'data'),
    JARVIS_MODELS_DIR: join(fresh, 'models'),
    CLAUDE_CONFIG_DIR: join(fresh, 'claude'),
    ANTHROPIC_API_KEY: undefined,
  }))
  const health = JSON.parse((await dt.evaluate(`fetch(window.vas.bridge.http + '/health').then((r) => r.text())`)) ?? 'null')
  check(
    'starts on a fresh computer and knows the voice models are missing',
    Boolean(health?.ok && health.modelsMissing?.length),
    health ? `missing: ${health.modelsMissing.join(', ')}` : 'no /health',
  )
  const reply = JSON.parse(
    (await dt.evaluate(`new Promise((resolve) => {
      const b = window.vas.bridge
      const ws = new WebSocket(b.ws, ['vas.v1', 'vas.token.' + b.token])
      let said = ''
      ws.onopen = () => ws.send(JSON.stringify({ type: 'ask', text: 'tell me something fun about octopuses', id: 'e2e-fresh' }))
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.ask !== 'e2e-fresh') return
        if (m.type === 'text') said += m.delta
        if (m.type === 'done' || m.type === 'error') { ws.close(); resolve(JSON.stringify({ type: m.type, said, message: m.message ?? '' })) }
      }
      setTimeout(() => resolve(JSON.stringify({ type: 'timeout', said })), 90000)
    })`)) ?? 'null',
  )
  check(
    'with no Claude sign-in, a question gets a spoken sentence that says what to do',
    Boolean(reply && reply.type === 'done' && /signed in/.test(reply.said)),
    reply ? `${reply.type}: "${(reply.said || reply.message).slice(0, 90)}"` : 'no answer',
  )
  await dt.evaluate('window.vas.quit()')
  dt.close()
  const leftFresh = await waitFor(async () => (appProcesses().length === 0 ? [] : null), 15_000, 'a clean exit').catch(() => appProcesses())
  check('the fresh start quits cleanly too', leftFresh.length === 0, leftFresh.map((p) => `${p.name}:${p.pid}`).join(' '))
  try {
    rmSync(fresh, { recursive: true, force: true })
  } catch {
    /* a file still held for a moment; it is in the temp folder */
  }

  if (MEMORY) await memoryRun()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exitCode = failed.length ? 1 : 0
}

/** Private MB per kind of VAS process: main, renderer, gpu-process, bridge, claude, other utilities. */
function memoryByKind() {
  const kinds = {}
  for (const p of appProcessDetails()) kinds[p.kind] = (kinds[p.kind] ?? 0) + p.privateMB
  return kinds
}

function appProcessDetails() {
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${APP_DIR.replace(/'/g, "''")}', 'OrdinalIgnoreCase') } | ` +
    `ForEach-Object { [string]$_.ProcessId + '|' + $_.Name + '|' + [math]::Round($_.PrivatePageCount/1MB) + '|' + $_.CommandLine }`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, name, mb, ...cmd] = line.split('|')
      const c = cmd.join('|')
      const type = (c.match(/--type=([a-z-]+)/) ?? [])[1]
      const kind = name.toLowerCase() === 'claude.exe' ? 'claude' : !type ? 'main' : type === 'utility' ? (/node\.mojom/i.test(c) ? 'bridge' : 'utility') : type
      return { pid: Number(pid), kind, privateMB: Number(mb) }
    })
}

async function memoryRun() {
  const { synthesize } = await import('../test/bridge/helpers.mjs')
  const clips = synthesize({
    one: 'Open notepad and then tell me the time.',
    two: 'What is the weather going to be like in Kochi this weekend?',
    three: 'Tell me something interesting about octopuses and how they think.',
  })
  if (!clips) {
    check('memory check', true, 'skipped: Windows speech synthesis is unavailable')
    return
  }
  const IDLE_MS = 20_000
  const { dt } = await launch({ JARVIS_ASR_IDLE_MS: String(IDLE_MS) })
  try {
    const health = JSON.parse((await dt.evaluate(`fetch(window.vas.bridge.http + '/health').then((r) => r.text())`)) ?? 'null')
    if (!health?.stt || health.sttEngine === 'scribe') {
      check('memory check', true, 'skipped: local Whisper is not installed (npm run models)')
      return
    }
    await sleep(8_000)
    const before = memoryByKind()
    check(
      'hidden, the 3D scene is not drawn',
      (before['gpu-process'] ?? 0) < 350,
      `graphics ${before['gpu-process'] ?? 0} MB`,
    )
    for (const path of Object.values(clips)) {
      const b64 = readFileSync(path).toString('base64')
      const said = await dt.evaluate(`(async () => {
        const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0))
        const r = await fetch(window.vas.bridge.http + '/stt?mode=command', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes })
        return (await r.json()).text ?? ''
      })()`)
      if (!said) break
    }
    const loaded = JSON.parse((await dt.evaluate(`fetch(window.vas.bridge.http + '/health').then((r) => r.text())`)) ?? '{}')
    const busy = memoryByKind()
    await sleep(IDLE_MS + 10_000)
    const idle = memoryByKind()
    const after = JSON.parse((await dt.evaluate(`fetch(window.vas.bridge.http + '/health').then((r) => r.text())`)) ?? '{}')
    check(
      'Whisper is let go once idle, and the bridge gives the memory back',
      loaded.whisperLoaded === true && after.whisperLoaded === false && idle.bridge < busy.bridge - 100,
      `bridge ${before.bridge} → ${busy.bridge} MB transcribing → ${idle.bridge} MB idle`,
    )
  } finally {
    await dt.evaluate('window.vas.quit()')
    dt.close()
    await waitFor(async () => (appProcesses().length === 0 ? [] : null), 15_000, 'a clean exit').catch(() => {})
  }
}

main().catch((err) => {
  console.error(`e2e failed: ${err.message}`)
  for (const p of appProcesses()) {
    try {
      execFileSync('taskkill.exe', ['/F', '/PID', String(p.pid)])
    } catch {
      /* already gone */
    }
  }
  process.exitCode = 1
})
