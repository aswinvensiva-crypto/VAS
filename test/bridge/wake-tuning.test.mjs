import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Tuning the wake word on enrollment's "Hey Jarvis" clips, with a stand-in
 * spotter: each fake clip wakes it up to a known threshold (per boost), so
 * what the sweep should pick is known exactly. The real spotter is exercised
 * by speaker-e2e.test.mjs.
 */
let dir
let t
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-tune-'))
  process.env.JARVIS_DATA_DIR = dir
  t = {
    ...(await import('../../bridge/voice/wake-tuning.mjs')),
    ...(await import('../../bridge/store/config.mjs')),
  }
})
after(() => rmSync(dir, { recursive: true, force: true }))

/** A clip that wakes the spotter at thresholds up to `max[boost]`, and at no threshold for any other boost. */
const clip = (max) => ({ max })

/** A stand-in for engine.spotTrial: records every setting it was asked about. */
function fakeSpot() {
  const fn = async (clips, k) => {
    fn.calls.push(k)
    return clips.map((c) => k.threshold <= (c.max[k.boost] ?? -1))
  }
  fn.calls = []
  return fn
}

const keyword = () => structuredClone(t.DEFAULT_WAKE_KEYWORDS[0]) // HEY_JARVIS, boost 1.5, threshold 0.25

test('the sweep keeps the strictest threshold that wakes on every clip, eased one step', async () => {
  const spot = fakeSpot()
  const clips = [clip({ 1.5: 0.55 }), clip({ 1.5: 0.42 }), clip({ 1.5: 0.61 })]
  const found = await t.sweepWake({ keyword: keyword(), clips, spot })
  // 0.42 is the weakest clip's limit: 0.4 is the strictest threshold at which all three wake.
  assert.deepEqual({ ...found, tries: undefined }, { boost: 1.5, threshold: 0.35, strictest: 0.4, tries: undefined })
  // Bisected, not walked: thirteen thresholds take at most five spotters.
  assert.ok(found.tries <= 5, `took ${found.tries} tries`)
  assert.equal(spot.calls.length, found.tries)
  // Every try is the configured keyword with only the setting changed.
  for (const k of spot.calls) assert.deepEqual([k.name, k.phones, k.boost], ['HEY_JARVIS', keyword().phones, 1.5])
})

test('a voice that only wakes it at the lowest threshold gets the lowest, not less', async () => {
  const found = await t.sweepWake({ keyword: keyword(), clips: [clip({ 1.5: 0.12 }), clip({ 1.5: 0.3 })], spot: fakeSpot() })
  assert.deepEqual([found.threshold, found.strictest], [0.1, 0.1])
})

test('when the configured boost wakes on nothing, the other boosts are tried in turn', async () => {
  const spot = fakeSpot()
  const clips = [clip({ 1: 0.33, 2: 0.6 }), clip({ 1: 0.3, 2: 0.6 })]
  const found = await t.sweepWake({ keyword: keyword(), clips, spot })
  // 1.5 first (one try at the lowest threshold), then 1, which works.
  assert.equal(spot.calls[0].boost, 1.5)
  assert.equal(spot.calls.filter((k) => k.boost === 1.5).length, 1)
  assert.deepEqual([found.boost, found.strictest, found.threshold], [1, 0.3, 0.25])
})

test('nothing that wakes on every clip is no result', async () => {
  const spot = fakeSpot()
  assert.equal(await t.sweepWake({ keyword: keyword(), clips: [clip({ 1.5: 0.5 }), clip({})], spot }), null)
  // One try per boost: each fails at its lowest threshold.
  assert.equal(spot.calls.length, 1 + t.BOOSTS.filter((b) => b !== 1.5).length)
})

test('withTuning changes one keyword and leaves the list it was given alone', () => {
  const list = [keyword(), { name: 'COMPUTER', phrases: ['computer'], phones: [], boost: 2, threshold: 0.3, enabled: true }]
  const next = t.withTuning(list, 'HEY_JARVIS', { boost: 1, threshold: 0.45 })
  assert.deepEqual([next[0].boost, next[0].threshold, next[0].phones], [1, 0.45, list[0].phones])
  assert.equal(next[1], list[1])
  assert.deepEqual([list[0].boost, list[0].threshold], [1.5, 0.25])
})

const configFile = () => join(dir, 'config.json')

test('saving writes only the wake keywords into config.json, beside what the user wrote', async () => {
  writeFileSync(configFile(), JSON.stringify({ userName: 'Aswin', wake: {}, stt: { model: 'whisper-small' } }))
  const keywords = t.withTuning([keyword()], 'HEY_JARVIS', { boost: 1.5, threshold: 0.4 })
  await t.saveWakeKeywords(keywords)
  const written = JSON.parse(readFileSync(configFile(), 'utf8'))
  assert.deepEqual(Object.keys(written).sort(), ['stt', 'userName', 'wake'])
  assert.deepEqual(written.stt, { model: 'whisper-small' }) // no defaults pinned
  assert.equal(written.wake.keywords[0].threshold, 0.4)
  assert.equal((await t.loadConfig()).wake.keywords[0].threshold, 0.4)
})

test('a config.json that is not valid JSON is left alone', async () => {
  writeFileSync(configFile(), '{ "userName": "Aswin", ')
  await assert.rejects(t.saveWakeKeywords([keyword()]), /not valid JSON/)
  assert.equal(readFileSync(configFile(), 'utf8'), '{ "userName": "Aswin", ')
  rmSync(configFile())
  await t.saveWakeKeywords([keyword()]) // no file yet: one with just the wake word
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(configFile(), 'utf8'))), ['wake'])
})

/** A stand-in voice engine for tuneWake: a fake spotter, and a record of what was applied. */
function fakeEngine({ kws = true, clipsMax = 0.5 } = {}) {
  const engine = {
    applied: [],
    ended: 0,
    status: () => ({ kws }),
    spotTrial: async (clips, [k]) => clips.map(() => k.threshold <= clipsMax),
    endTrials: () => engine.ended++,
    setConfig: (c) => engine.applied.push(structuredClone(c.wake.keywords)),
  }
  return engine
}
const samples = () => [new Float32Array(16000), new Float32Array(16000), new Float32Array(16000)]

test('tuneWake applies the result at once and keeps it', async () => {
  rmSync(configFile(), { force: true })
  const config = t.ConfigSchema.parse({})
  const engine = fakeEngine({ clipsMax: 0.5 })
  const out = await t.tuneWake({ clips: samples(), engine, config })
  assert.deepEqual(out, { tuned: true, boost: 1.5, threshold: 0.45, strictest: 0.5, clips: 3, saved: true })
  assert.equal(config.wake.keywords[0].threshold, 0.45)
  assert.equal(engine.applied.length, 1)
  assert.equal(engine.applied[0][0].threshold, 0.45)
  assert.equal(engine.ended, 1) // the sweep's thread is let go
  assert.equal(JSON.parse(readFileSync(configFile(), 'utf8')).wake.keywords[0].threshold, 0.45)
  // The shared default was copied, not changed.
  assert.equal(t.DEFAULT_WAKE_KEYWORDS[0].threshold, 0.25)
})

test('tuneWake leaves the wake word alone when it has nothing to go on', async () => {
  const config = t.ConfigSchema.parse({})
  const untouched = (out, reason) => {
    assert.equal(out.tuned, false)
    assert.match(out.reason, reason)
    assert.equal(config.wake.keywords[0].threshold, 0.25)
  }
  untouched(await t.tuneWake({ clips: samples().slice(0, 1), engine: fakeEngine(), config }), /needs 2/)
  untouched(await t.tuneWake({ clips: samples(), engine: fakeEngine({ kws: false }), config }), /not installed/)
  untouched(await t.tuneWake({ clips: samples(), engine: fakeEngine({ clipsMax: 0 }), config }), /defaults stay/)
  const other = t.ConfigSchema.parse({ wake: { keywords: ['hey friday'] } })
  const out = await t.tuneWake({ clips: samples(), engine: fakeEngine(), config: other })
  assert.match(out.reason, /no "Hey Jarvis"/)
})
