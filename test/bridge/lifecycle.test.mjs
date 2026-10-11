import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Starting and stopping the bridge: it refuses to run unauthenticated unless
 * told to by name, and it leaves on its own when the app that started it dies.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER = join(ROOT, 'bridge', 'server.mjs')

function bridge({ env = {}, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vas-life-'))
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    env: { ...process.env, JARVIS_FAKE_SDK: '1', JARVIS_BRIDGE_PORT: '0', JARVIS_DATA_DIR: join(dir, 'data'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  // The token line is logged just after "listening", possibly in a later chunk;
  // waiting for it means the whole startup report is in.
  const listening = new Promise((resolve) => {
    const check = () => /session token required|INSECURE DEV MODE/.test(log) && resolve()
    child.stdout.on('data', check)
  })
  const cleanup = async () => {
    if (child.exitCode === null) child.kill()
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
  return { child, exited, listening, log: () => log, cleanup }
}

const within = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms))])

test('refuses to start without a session token', async () => {
  const b = bridge({ env: { JARVIS_BRIDGE_TOKEN: '' } })
  try {
    const code = await within(b.exited, 20_000, 'refusing')
    assert.equal(code, 1)
    assert.match(b.log(), /refusing to start: JARVIS_BRIDGE_TOKEN is not set/)
  } finally {
    await b.cleanup()
  }
})

test('--insecure-dev runs without one, and says so loudly', async () => {
  const b = bridge({ env: { JARVIS_BRIDGE_TOKEN: '' }, args: ['--insecure-dev'] })
  try {
    await within(b.listening, 20_000, 'starting')
    assert.match(b.log(), /INSECURE DEV MODE/)
  } finally {
    await b.cleanup()
  }
})

test('exits on its own when the app that started it is gone', async () => {
  // Stand-in for the VAS main process: alive for a few seconds, then gone.
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' })
  const b = bridge({ env: { JARVIS_BRIDGE_TOKEN: 'test-token-lifecycle', JARVIS_PARENT_PID: String(parent.pid) } })
  try {
    await within(b.listening, 20_000, 'starting')
    assert.equal(b.child.exitCode, null, 'running while the parent lives')
    await new Promise((r) => parent.once('exit', r))
    const code = await within(b.exited, 12_000, 'noticing the parent is gone')
    assert.equal(code, 0)
    assert.match(b.log(), /shutting down: parent \d+ is gone/)
  } finally {
    parent.kill()
    await b.cleanup()
  }
})
