import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdleRelease } from '../../bridge/voice/idle.mjs'

/** A clock the test moves by hand. */
function clock() {
  let now = 0
  const timers = new Set()
  return {
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn }
      timers.add(t)
      return t
    },
    clearTimer: (t) => timers.delete(t),
    advance(ms) {
      now += ms
      for (const t of [...timers]) if (t.at <= now) (timers.delete(t), t.fn())
    },
  }
}

test('Whisper is let go after the quiet period, never during a use, and the clock restarts with each use', async () => {
  const c = clock()
  let released = 0
  const idle = createIdleRelease({ ms: 1000, release: () => released++, setTimer: c.setTimer, clearTimer: c.clearTimer })
  c.advance(5000)
  assert.equal(released, 0, 'nothing to let go before the first use')

  let finish
  const running = idle.use(() => new Promise((r) => (finish = r)))
  c.advance(5000)
  assert.equal(released, 0, 'not while a transcription is running')
  finish('text')
  assert.equal(await running, 'text')

  c.advance(999)
  assert.equal(released, 0)
  await idle.use(async () => 'again') // a use resets the clock
  c.advance(999)
  assert.equal(released, 0)
  c.advance(1)
  assert.equal(released, 1)

  await idle.use(async () => {})
  idle.cancel()
  c.advance(10_000)
  assert.equal(released, 1, 'cancelled on close')
})
