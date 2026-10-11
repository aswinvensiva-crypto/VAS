import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startBridge, synthesize } from './helpers.mjs'
import { status } from '../../bridge/voice/models.mjs'

/**
 * Voice enrollment through a real bridge: recording, saving the voiceprint,
 * scoring, and the owner still waking JARVIS afterwards.
 *
 * What this cannot test is how well the model tells two PEOPLE apart: the only
 * voices available to a test are Windows' synthetic ones, which come out of one
 * synthesis engine and score almost alike (measured: 0.50 vs 0.47 on a new
 * sentence). Discrimination is checked with fakes in speaker-units.test.mjs,
 * and on a real voice by the live test on the enrollment screen.
 */
const models = await status()
const ENROLL = {
  e1: 'Hey Jarvis, open Chrome for me.',
  e2: 'Hey Jarvis, what is the weather like today?',
  e3: 'Yes, confirm it.',
  e4: 'The quick brown fox jumps over the lazy dog while the sun goes down.',
  e5: 'I usually start my day with a coffee and a look at my calendar.',
  e6: 'Hey Jarvis, play some music.',
}
const clips = models.speaker && models.kws ? synthesize({ ...ENROLL, wake: 'Hey Jarvis, open Spotify.' }) : null
const skip = clips ? false : 'needs the voice models and Windows speech synthesis'

let bridge
before(async () => {
  if (!skip) bridge = await startBridge()
})
after(async () => {
  await bridge?.stop()
})

const call = async (method, path, file) => {
  const res = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method,
    headers: { 'content-type': 'audio/wav', 'x-vas-token': bridge.token },
    body: file ? readFileSync(file) : undefined,
  })
  return res.json()
}

test('enrollment refuses to finish early, then saves a voiceprint', { skip }, async () => {
  let session
  for (const [i, key] of Object.keys(ENROLL).entries()) {
    const r = await call('POST', `/voice/enroll${session ? `?session=${session}` : ''}`, clips[key])
    assert.equal(r.ok, true, JSON.stringify(r))
    session = r.session
    assert.equal(r.count, i + 1)
    if (i === 2) {
      const early = await call('POST', `/voice/enroll/finish?session=${session}`)
      assert.equal(early.ok, false)
      assert.match(early.reason, /at least 5/)
    }
  }
  const done = await call('POST', `/voice/enroll/finish?session=${session}`)
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.ok(done.thresholds.long >= 0.3 && done.thresholds.long <= 0.7)
  assert.equal((await call('GET', '/voice/status')).enrolled, true)
})

test('the enrolled voice scores as the owner and still wakes JARVIS', { skip }, async () => {
  const scored = await call('POST', '/voice/test', clips.wake)
  assert.equal(scored.verdict, 'owner', JSON.stringify(scored))
  const out = await call('POST', '/stt?mode=wake', clips.wake)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS')
  assert.equal(out.owner?.verdict, 'owner')
})

test('forgetting the voice turns the check off', { skip }, async () => {
  assert.equal((await call('DELETE', '/voice/enroll')).ok, true)
  assert.equal((await call('GET', '/voice/status')).enrolled, false)
  const out = await call('POST', '/stt?mode=wake', clips.wake)
  assert.equal(out.owner, undefined)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS')
})
