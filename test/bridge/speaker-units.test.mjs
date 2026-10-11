import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate, centroid, cosine, verdict } from '../../bridge/voice/speaker.mjs'
import { handleSegment } from '../../bridge/voice/stt.mjs'

const unit = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]

test('cosine and centroid', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9)
  const c = centroid([unit(-10), unit(10)])
  assert.ok(Math.abs(c[0] - 1) < 1e-9)
})

test("calibration sits just under the owner's own scores, and is clamped", () => {
  const tight = calibrate([unit(0), unit(5), unit(-5), unit(3), unit(-3)].map((v) => ({ v, seconds: 4 })))
  assert.ok(tight.long > 0.6 && tight.long <= 0.7, String(tight.long))
  const loose = calibrate([unit(0), unit(80), unit(-80), unit(70), unit(-70)].map((v) => ({ v, seconds: 4 })))
  assert.equal(loose.long, 0.3)
})

test('verdicts: owner, other only by a clear margin, short clips forgiven', () => {
  const t = { short: 0.5, long: 0.6 }
  assert.equal(verdict(0.7, 3, t), 'owner')
  assert.equal(verdict(0.55, 3, t), 'unknown')
  assert.equal(verdict(0.4, 3, t), 'other')
  assert.equal(verdict(0.35, 1.2, t), 'unknown') // short clips need < 0.26
  assert.equal(verdict(0.2, 1.2, t), 'other')
  assert.equal(verdict(0.9, 0.5, t), 'unknown') // too short to judge at all
})

/** A stand-in engine: a fixed embedding, a keyword hit, a transcript. */
function fakeEngine(embedding) {
  return {
    status: () => ({ kws: true, asr: true, speaker: true, whisper: 'whisper-base' }),
    spot: async () => ({ keyword: 'HEY_JARVIS', start: 0, end: 0.8 }),
    embed: async () => embedding,
    transcribe: async () => 'Hey Jarvis, open Spotify.',
  }
}
const speaker = { centroid: unit(0), thresholds: { short: 0.5, long: 0.6 } }
const samples = new Float32Array(16000 * 3).fill(0.1)
const config = (require) => ({ stt: { engine: 'local' }, owner: { require } })

test('with "only my voice", someone else is dropped before transcription', async () => {
  let transcribed = false
  const engine = {
    ...fakeEngine(unit(80)),
    transcribe: async () => {
      transcribed = true
      return 'x'
    },
  }
  const out = await handleSegment({ samples, mode: 'wake', engine, config: config('all'), speaker })
  assert.equal(out.wake, null)
  assert.equal(out.reason, 'not-owner')
  assert.equal(out.owner.verdict, 'other')
  assert.equal(transcribed, false)
})

test('the owner gets through; with "actions" others are heard but marked', async () => {
  const mine = await handleSegment({ samples, mode: 'wake', engine: fakeEngine(unit(5)), config: config('all'), speaker })
  assert.equal(mine.wake.keyword, 'HEY_JARVIS')
  assert.equal(mine.owner.verdict, 'owner')
  const theirs = await handleSegment({ samples, mode: 'command', engine: fakeEngine(unit(80)), config: config('actions'), speaker })
  assert.equal(theirs.text, 'Hey Jarvis, open Spotify.')
  assert.equal(theirs.owner.verdict, 'other')
})

test('no enrolled voice: no check at all', async () => {
  const out = await handleSegment({ samples, mode: 'command', engine: fakeEngine(unit(80)), config: config('all'), speaker: null })
  assert.equal(out.owner, undefined)
  assert.ok(out.text)
})
