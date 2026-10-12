import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startBridge } from './helpers.mjs'

/**
 * Standing JARVIS down through a real bridge (fake SDK): "mute yourself"
 * tells the face to stop listening for the wake word, and "shut down VAS"
 * asks first, then sends the quit frame only after the goodbye has had time
 * to be spoken. A no leaves VAS running.
 */
const WebSocket = createRequire(import.meta.url)('ws')

let bridge
let ws
let seq = 0
/** Every frame the face received, in order, with when it arrived. */
const frames = []
/** Answers for the gate's questions, in order. */
const answers = []

before(async () => {
  bridge = await startBridge()
  ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    frames.push({ ...m, at: Date.now() })
    if (m.type === 'confirm') {
      ws.send(JSON.stringify({ type: 'reply', id: m.id, text: answers.shift() ?? 'no', source: 'voice' }))
    }
  })
})
after(async () => {
  ws?.close()
  await bridge?.stop()
})

/** Ask one question; resolves with what was said and the done frame. */
function ask(text) {
  const id = `k${++seq}`
  const from = frames.length
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to "${text}"`)), 20_000)
    const poll = setInterval(() => {
      const mine = frames.slice(from).filter((f) => f.ask === id)
      const done = mine.find((f) => f.type === 'done' || f.type === 'error')
      if (!done) return
      clearTimeout(timer)
      clearInterval(poll)
      resolve({ said: mine.filter((f) => f.type === 'text').map((f) => f.delta).join('').trim(), done, from })
    }, 20)
    ws.send(JSON.stringify({ type: 'ask', text, id }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const since = (from, type) => frames.slice(from).filter((f) => f.type === type)

test('"mute yourself" tells the face to stop listening, without asking', async () => {
  const r = await ask('mute yourself')
  assert.equal(r.done.local, 'mute')
  assert.equal(r.done.after, 'dormant')
  assert.match(r.said, /stopped listening for my name/)
  const app = since(r.from, 'app')
  assert.deepEqual(app.map((f) => f.op), ['mute'])
  assert.ok(app[0].at <= r.done.at, 'the face is muted before the turn ends')
  assert.equal(since(r.from, 'confirm').length, 0)
})

test('"shut down VAS" asks, and a no leaves VAS running', async () => {
  answers.push('no')
  const r = await ask('shut down VAS')
  assert.equal(r.done.local, 'quit')
  assert.deepEqual(since(r.from, 'confirm').map((f) => f.prompt), ['Shut down VAS completely?'])
  assert.match(r.said, /won't/i)
  // Longer than the pause before a quit would have been sent.
  await sleep(2500)
  assert.equal(since(r.from, 'app').length, 0, 'no quit frame after a no')
})

test('"shut down VAS" with a yes says goodbye, then sends the quit frame', async () => {
  answers.push('yes')
  const r = await ask('shut down VAS')
  assert.equal(since(r.from, 'confirm').length, 1)
  assert.match(r.said, /Shutting down/)
  assert.equal(since(r.from, 'app').length, 0, 'not while the goodbye is still being spoken')
  for (let i = 0; i < 50 && !since(r.from, 'app').length; i++) await sleep(100)
  const app = since(r.from, 'app')
  assert.deepEqual(app.map((f) => f.op), ['quit'])
  assert.ok(app[0].at - r.done.at >= 1500, `quit came ${app[0].at - r.done.at} ms after the reply`)
})
