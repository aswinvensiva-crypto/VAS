import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startBridge } from './helpers.mjs'

/**
 * Which question a frame belongs to. Two questions can reach Claude before the
 * first is answered (the user asks again while it is still talking, or a local
 * neuron hands two on). Each answer must arrive tagged with its own id, or the
 * face speaks the first answer as the reply to the second.
 */
const WebSocket = createRequire(import.meta.url)('ws')

let bridge
before(async () => {
  bridge = await startBridge({ env: { JARVIS_PREWARM_MS: '60000', JARVIS_FAKE_SDK_DELAY_MS: '300' } })
})
after(async () => {
  await bridge?.stop()
})

test('back-to-back questions to Claude each get their own answer, in order', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  const frames = []
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; frames: ${JSON.stringify(frames)}`)), 15_000)
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (!['text', 'done', 'error'].includes(m.type)) return
      frames.push(m)
      if (frames.filter((f) => f.type === 'done' || f.type === 'error').length === 2) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  // Sent in the same tick, so the second arrives while the first is in flight.
  ws.send(JSON.stringify({ type: 'ask', text: 'tell me something fun', id: 'first' }))
  ws.send(JSON.stringify({ type: 'ask', text: 'tell me a story about the sea', id: 'second' }))
  await done
  ws.close()

  const forId = (id) => frames.filter((f) => f.ask === id)
  const textOf = (id) => forId(id).filter((f) => f.type === 'text').map((f) => f.delta).join('')
  assert.match(textOf('first'), /something fun/, JSON.stringify(frames))
  assert.doesNotMatch(textOf('first'), /story about the sea/)
  assert.match(textOf('second'), /story about the sea/)
  assert.doesNotMatch(textOf('second'), /something fun/)
  assert.equal(forId('first').at(-1).type, 'done')
  assert.equal(forId('second').at(-1).type, 'done')
  // The first question's answer finishes before the second's begins.
  const order = frames.map((f) => f.ask)
  assert.ok(order.lastIndexOf('first') < order.indexOf('second'), order.join(','))
  assert.ok(frames.every((f) => f.ask === 'first' || f.ask === 'second'), 'no untagged frames')
})
