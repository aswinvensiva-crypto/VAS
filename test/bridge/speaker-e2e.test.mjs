import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBridge, synthesize } from './helpers.mjs'
import { status } from '../../bridge/voice/models.mjs'
import { PROMPTS } from '../../bridge/voice/enroll.mjs'
import { THRESHOLDS } from '../../bridge/voice/wake-tuning.mjs'

/**
 * Voice enrollment through a real bridge: recording the lines the bridge asks
 * for, saving the voiceprint, tuning the wake word on the "Hey Jarvis" lines,
 * scoring, and the owner still waking JARVIS afterwards.
 *
 * What this cannot test is how well the model tells two PEOPLE apart: the only
 * voices available to a test are Windows' synthetic ones, which come out of one
 * synthesis engine and score almost alike (measured: 0.50 vs 0.47 on a new
 * sentence). Discrimination is checked with fakes in speaker-units.test.mjs,
 * and on a real voice by the live test on the enrollment screen.
 */
const models = await status()
const ENROLL = Object.fromEntries(PROMPTS.map((p, i) => [`e${i}`, p]))
const clips =
  models.speaker && models.kws && models['whisper-base'] ? synthesize({ ...ENROLL, wake: 'Hey Jarvis, open Spotify.' }) : null
const skip = clips ? false : 'needs the voice models and Windows speech synthesis'
// Synthesised lines are posted as they come: SAPI leaves about 0.12 s of quiet
// before the speech and 0.75 s after, close to the 0.3 s and 0.65 s the face's
// voice detector keeps, so "Yes." arrives at about 1.3 s, as it would live.

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

test('the bridge says what to read', { skip }, async () => {
  const out = await call('GET', '/voice/enroll')
  assert.deepEqual(out.prompts, PROMPTS)
  assert.deepEqual(out.need, { short: 5, long: 2 })
})

test('enrollment refuses to finish early, then saves a voiceprint and tunes the wake word', { skip }, async () => {
  let session
  let last
  for (const [i, key] of Object.keys(ENROLL).entries()) {
    last = await call('POST', `/voice/enroll${session ? `?session=${session}` : ''}`, clips[key])
    assert.equal(last.ok, true, JSON.stringify(last))
    session = last.session
    assert.equal(last.count, i + 1)
    if (i === 2) {
      const early = await call('POST', `/voice/enroll/finish?session=${session}`)
      assert.equal(early.ok, false)
      assert.match(early.reason, /at least 5 short/)
    }
  }
  assert.ok(last.short >= 5 && last.long >= 2, JSON.stringify(last))
  const done = await call('POST', `/voice/enroll/finish?session=${session}`)
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.ok(done.thresholds.long >= 0.3 && done.thresholds.long <= 0.7)
  assert.equal((await call('GET', '/voice/status')).enrolled, true)

  // Whisper picked out the three "Hey Jarvis" lines; the sweep found a setting
  // that wakes on all of them and saved it beside nothing else.
  assert.equal(done.wake?.tuned, true, JSON.stringify(done.wake))
  assert.equal(done.wake.clips, 3)
  assert.ok(THRESHOLDS.includes(done.wake.threshold) && done.wake.threshold <= done.wake.strictest)
  assert.equal(done.wake.saved, true)
  const config = JSON.parse(readFileSync(join(bridge.dataDir, 'config.json'), 'utf8'))
  assert.deepEqual(Object.keys(config), ['wake'])
  const keyword = config.wake.keywords.find((k) => k.name === 'HEY_JARVIS')
  assert.deepEqual([keyword.threshold, keyword.boost], [done.wake.threshold, done.wake.boost])
})

test('the enrolled voice scores as the owner and still wakes JARVIS, on the tuned setting', { skip }, async () => {
  const scored = await call('POST', '/voice/test', clips.wake)
  assert.equal(scored.verdict, 'owner', JSON.stringify(scored))
  const out = await call('POST', '/stt?mode=wake', clips.wake)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS', JSON.stringify(out))
  assert.equal(out.owner?.verdict, 'owner')
})

test('forgetting the voice turns the check off', { skip }, async () => {
  assert.equal((await call('DELETE', '/voice/enroll')).ok, true)
  assert.equal((await call('GET', '/voice/status')).enrolled, false)
  const out = await call('POST', '/stt?mode=wake', clips.wake)
  assert.equal(out.owner, undefined)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS')
})
