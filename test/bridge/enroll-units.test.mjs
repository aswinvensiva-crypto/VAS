import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Enrollment with a stand-in voice engine: how many recordings of each length
 * it takes, and the wake word tuned on the ones that said "Hey Jarvis" when
 * it finishes. The real models are exercised in speaker-e2e.test.mjs.
 */
let dir
let m
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-enroll-'))
  process.env.JARVIS_DATA_DIR = dir
  m = {
    ...(await import('../../bridge/voice/enroll.mjs')),
    ...(await import('../../bridge/voice/wav.mjs')),
    ...(await import('../../bridge/voice/transcript.mjs')),
    ...(await import('../../bridge/store/config.mjs')),
  }
})
after(() => rmSync(dir, { recursive: true, force: true }))

/** First sample of a clip that "says" Hey Jarvis; the stand-in Whisper reads it back. */
const WAKE = 0.5

/** A recording `seconds` long, as the face would post it. */
function recording(seconds, { wake = false } = {}) {
  const samples = new Float32Array(Math.round(seconds * 16000))
  samples[0] = wake ? WAKE : 0
  samples[1] = Math.random() * 0.25 // so no two clips embed alike
  return m.encodeWav(samples)
}

/** A stand-in engine: embeddings, a Whisper that knows which clips said the name, and a spotter that wakes up to 0.4. */
function fakeEngine() {
  const engine = {
    heard: 0,
    trials: 0,
    applied: [],
    status: () => ({ speaker: true, asr: true, kws: true }),
    embed: async (s) => [1, s[1], 0.1],
    transcribe: async (s) => {
      engine.heard++
      return s[0] === WAKE ? 'Hey Jarvis, open Chrome for me.' : 'Yes.'
    },
    spotTrial: async (clips, [k]) => {
      engine.trials++
      return clips.map(() => k.threshold <= 0.4)
    },
    endTrials: () => {},
    setConfig: (c) => engine.applied.push(c.wake.keywords[0].threshold),
  }
  return engine
}

function client(handle) {
  let session = null
  return {
    get session() {
      return session
    },
    async post(body) {
      const [status, out] = await handle({ method: 'POST' }, '/voice/enroll', new URLSearchParams(session ? { session } : {}), body)
      assert.equal(status, 200)
      session = out.session
      return out
    },
    async finish() {
      return (await handle({ method: 'POST' }, '/voice/enroll/finish', new URLSearchParams({ session }), Buffer.alloc(0)))[1]
    },
  }
}

test('the face can ask what to read: short answers, sentences, and "Hey Jarvis" three times', async () => {
  const handle = m.createEnrollment({ engine: fakeEngine(), onChange: () => {} })
  const [status, out] = await handle({ method: 'GET' }, '/voice/enroll', new URLSearchParams(), Buffer.alloc(0))
  assert.equal(status, 200)
  assert.deepEqual(out.need, { short: 5, long: 2 })
  assert.equal(out.prompts.filter((p) => m.opensWithWake(p)).length, 3)
  // A word or two each: at least five lines short enough for the short-clip band.
  assert.ok(out.prompts.filter((p) => p.split(/\s+/).length <= 2).length >= 5, out.prompts.join(' | '))
})

test('finishing takes five short recordings and two long ones, then tunes the wake word', async () => {
  const engine = fakeEngine()
  const config = m.ConfigSchema.parse({})
  let changed = 0
  const c = client(m.createEnrollment({ engine, config, onChange: () => changed++ }))

  for (const r of [recording(3, { wake: true }), recording(3.5), recording(1.8, { wake: true })]) await c.post(r)
  for (let i = 0; i < 3; i++) await c.post(recording(1.2))
  const posted = await c.post(recording(2.6, { wake: true }))
  assert.deepEqual([posted.count, posted.short, posted.long], [7, 4, 3])

  const early = await c.finish()
  assert.equal(early.ok, false)
  assert.match(early.reason, /at least 5 short recordings .* 2 longer ones; I have 4 short and 3 long/)
  assert.deepEqual(early.need, { short: 1, long: 0 })
  assert.equal(changed, 0)

  await c.post(recording(1.1))
  const done = await c.finish()
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.clips, 8)
  assert.equal(changed, 1)
  assert.ok(existsSync(join(dir, 'speaker.json')))
  // Every recording went past Whisper; three said the name, and the sweep used those.
  assert.equal(engine.heard, 8)
  assert.deepEqual(done.wake, { tuned: true, boost: 1.5, threshold: 0.35, strictest: 0.4, clips: 3, saved: true })
  assert.ok(engine.trials > 0)
  assert.deepEqual(engine.applied, [0.35])
  assert.equal(config.wake.keywords[0].threshold, 0.35)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).wake.keywords[0].threshold, 0.35)
  // The session is gone once it has been saved.
  assert.equal((await c.finish()).ok, false)
})

test('long recordings are counted too, and without settings the wake word is left alone', async () => {
  const c = client(m.createEnrollment({ engine: fakeEngine(), onChange: () => {} }))
  for (let i = 0; i < 6; i++) await c.post(recording(1.3, { wake: i < 2 }))
  await c.post(recording(4))
  const early = await c.finish()
  assert.match(early.reason, /I have 6 short and 1 long/)
  assert.deepEqual(early.need, { short: 0, long: 1 })
  await c.post(recording(4))
  const done = await c.finish()
  assert.equal(done.ok, true)
  assert.equal(done.wake.tuned, false)
  assert.equal(done.wake.clips, 2)
})

test('a clip too short to say anything about a voice is refused', async () => {
  const c = client(m.createEnrollment({ engine: fakeEngine(), onChange: () => {} }))
  const out = await c.post(recording(0.5))
  assert.equal(out.ok, false)
  assert.match(out.reason, /too short/)
})

test('forgetting or replacing a saved voice goes through the guard first', async () => {
  // The tests above saved a voice.
  assert.ok(existsSync(join(dir, 'speaker.json')))
  const asked = []
  const guard = async (action) => {
    asked.push(action)
    throw Object.assign(new Error('Only your voice can approve that.'), { status: 403 })
  }
  const handle = m.createEnrollment({ engine: fakeEngine(), onChange: () => {}, guard })
  const [status, out] = await handle({ method: 'DELETE' }, '/voice/enroll', new URLSearchParams(), Buffer.alloc(0))
  assert.equal(status, 403)
  assert.match(out.reason, /Only your voice/)
  assert.ok(existsSync(join(dir, 'speaker.json')), 'the voice is still there')

  const c = client(handle)
  for (let i = 0; i < 5; i++) await c.post(recording(1.2))
  for (let i = 0; i < 2; i++) await c.post(recording(3))
  const before = readFileSync(join(dir, 'speaker.json'), 'utf8')
  const [finishStatus] = await handle({ method: 'POST' }, '/voice/enroll/finish', new URLSearchParams({ session: c.session }), Buffer.alloc(0))
  assert.equal(finishStatus, 403)
  assert.equal(readFileSync(join(dir, 'speaker.json'), 'utf8'), before, 'not replaced')
  assert.deepEqual(asked, ['voice.forget', 'settings.weaken'])
})

test('a wake tuning that fails does not fail an enrollment already saved', async () => {
  const engine = fakeEngine()
  engine.spotTrial = async () => {
    throw new Error('trial spotter failed')
  }
  const c = client(m.createEnrollment({ engine, config: m.ConfigSchema.parse({}), onChange: () => {} }))
  for (let i = 0; i < 5; i++) await c.post(recording(1.2, { wake: i < 3 }))
  for (let i = 0; i < 2; i++) await c.post(recording(3))
  const done = await c.finish()
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.wake.tuned, false)
  assert.match(done.wake.reason, /trial spotter failed/)
})
