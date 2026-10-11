import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startBridge } from './helpers.mjs'

/**
 * When Claude Code starts. Spawning it freezes the bridge for a couple of
 * seconds on Windows, so it must not happen in the connection handler: a
 * local answer never waits for it, a question for Claude starts it at once,
 * and an idle face gets it prewarmed shortly after connecting. (The fake SDK
 * writes its dump file at the moment query() is called — that is the spawn.)
 */
const WebSocket = createRequire(import.meta.url)('ws')

let lazy // prewarm far in the future: only a question can start the session
let eager // prewarm quickly
before(async () => {
  ;[lazy, eager] = await Promise.all([
    startBridge({ env: { JARVIS_PREWARM_MS: '60000' } }),
    startBridge({ env: { JARVIS_PREWARM_MS: '300' } }),
  ])
})
after(async () => {
  await Promise.all([lazy?.stop(), eager?.stop()])
})

async function connect(bridge) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  return ws
}

function ask(ws, text, id) {
  return new Promise((resolve, reject) => {
    let said = ''
    const timer = setTimeout(() => reject(new Error(`no answer to "${text}"`)), 10_000)
    ws.on('message', function on(raw) {
      const m = JSON.parse(raw.toString())
      if (m.ask !== id) return
      if (m.type === 'text') said += m.delta
      if (m.type === 'done' || m.type === 'error') {
        clearTimeout(timer)
        ws.off('message', on)
        resolve({ said: said.trim(), done: m })
      }
    })
    ws.send(JSON.stringify({ type: 'ask', text, id }))
  })
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('a local answer does not start Claude Code', async () => {
  const ws = await connect(lazy)
  try {
    const r = await ask(ws, 'what time is it', 'a1')
    assert.equal(r.done.local, 'time')
    assert.equal(existsSync(lazy.dump), false, 'the session started for a question it was never asked')
  } finally {
    ws.close()
  }
})

test('a question for Claude starts it at once', async () => {
  const ws = await connect(lazy)
  try {
    const r = await ask(ws, 'tell me something fun', 'c1')
    assert.match(r.said, /^echo: /)
    assert.equal(existsSync(lazy.dump), true)
  } finally {
    ws.close()
  }
})

test('a face that disconnects before the prewarm starts nothing', async () => {
  const ws = await connect(eager)
  ws.close()
  await pause(800)
  assert.equal(existsSync(eager.dump), false)
})

test('an idle face gets the session prewarmed shortly after connecting', async () => {
  const ws = await connect(eager)
  try {
    assert.equal(existsSync(eager.dump), false, 'started inside the connection handler')
    await pause(800)
    assert.equal(existsSync(eager.dump), true)
  } finally {
    ws.close()
  }
})
