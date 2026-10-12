import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The words behind a question, as the face reports them and as the bridge
 * recorded them: the raw transcript next to the corrected one, and whose voice
 * each segment was in. Units here; the same paths over a real socket are in
 * heard-e2e.test.mjs.
 */
let dir
let heard
let gateMod
let utterancesMod
let localMod
let brainMod
let registryMod
let correctionsMod
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-heard-'))
  process.env.JARVIS_DATA_DIR = dir
  heard = await import('../../bridge/heard.mjs')
  gateMod = await import('../../bridge/gate.mjs')
  utterancesMod = await import('../../bridge/voice/utterances.mjs')
  localMod = await import('../../bridge/neurons/local.mjs')
  brainMod = await import('../../bridge/neurons/brain.mjs')
  registryMod = await import('../../bridge/neurons/registry.mjs')
  correctionsMod = await import('../../bridge/corrections/store.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

/** A store that knows exactly these segments. */
const storeOf = (entries) => ({ get: (id) => entries[id] ?? null })
const SEGMENTS = storeOf({
  me1: { owner: { verdict: 'owner', score: 0.7 }, raw: 'open spot if i', text: 'open spotify' },
  me2: { owner: 'owner', raw: 'yes', text: 'yes' },
  tv1: { owner: { verdict: 'other', score: 0.1 }, raw: 'buy now', text: 'buy now' },
  tv2: { owner: 'other', raw: 'yes', text: 'yes' },
  hmm: { owner: { verdict: 'unknown' }, raw: 'ok', text: 'ok' },
  anon: { raw: 'hello', text: 'hello' },
})

test('heardOf keeps raw and utts, and shrugs off anything malformed', () => {
  assert.deepEqual(heard.heardOf({ type: 'ask', text: 'open spotify', raw: 'open spot if i', utts: ['a', 'b', 'a'] }), {
    raw: 'open spot if i',
    utts: ['a', 'b'],
  })
  assert.deepEqual(heard.heardOf({ type: 'ask', text: 'hi' }), { utts: [] })
  assert.deepEqual(heard.heardOf({ raw: 42, utts: 'nope' }), { utts: [] })
  assert.deepEqual(heard.heardOf({ raw: '   ', utts: [''] }), { utts: [] })
  assert.deepEqual(heard.heardOf(null), { utts: [] })
})

test('voiceOf: other only when every segment is, owner only when every segment is', () => {
  const { voiceOf } = heard
  assert.equal(voiceOf(['tv1', 'tv2'], SEGMENTS), 'other')
  assert.equal(voiceOf(['me1', 'me2'], SEGMENTS), 'owner')
  assert.equal(voiceOf(['me1', 'tv1'], SEGMENTS), 'unknown', 'mixed voices are not anyone in particular')
  assert.equal(voiceOf(['tv1', 'gone'], SEGMENTS), 'unknown', 'a forgotten segment is not evidence')
  assert.equal(voiceOf(['hmm'], SEGMENTS), 'unknown')
  assert.equal(voiceOf(['anon'], SEGMENTS), null, 'no verdict was taken: nothing to judge by')
  assert.equal(voiceOf(['gone'], SEGMENTS), null)
  assert.equal(voiceOf([], SEGMENTS), null)
})

test('an ask is someone else\'s only once a voice is enrolled, and is audited', () => {
  const log = []
  const audit = (e) => log.push(e)
  const tv = { utts: ['tv1', 'tv2'] }
  assert.equal(heard.fromOtherVoice(tv, { enrolled: false, store: SEGMENTS, audit }), false)
  assert.equal(heard.fromOtherVoice({ utts: ['tv1', 'me1'] }, { enrolled: true, store: SEGMENTS, audit }), false)
  assert.equal(heard.fromOtherVoice({ utts: [] }, { enrolled: true, store: SEGMENTS, audit }), false)
  assert.equal(log.length, 0)
  assert.equal(heard.fromOtherVoice(tv, { enrolled: true, store: SEGMENTS, audit }), true)
  assert.equal(log.length, 1)
  assert.equal(log[0].reason, 'other-voice')
  assert.equal(log[0].decision, 'deny')
  assert.equal(JSON.stringify(log[0]).includes('buy now'), false, 'what someone else said is not logged')
})

test('a confirm reply carries the looked-up verdict, never the face\'s claim', () => {
  const claimed = { type: 'reply', id: 'q1', text: 'yes', raw: 'yes', source: 'voice', owner: 'owner' }
  assert.equal(heard.judgedReply({ ...claimed, utts: ['tv2'] }, { enrolled: true, store: SEGMENTS }).owner, 'other')
  assert.equal(heard.judgedReply({ ...claimed, utts: ['me2'] }, { enrolled: true, store: SEGMENTS }).owner, 'owner')
  assert.equal('owner' in heard.judgedReply(claimed, { enrolled: true, store: SEGMENTS }), false)
  assert.equal('owner' in heard.judgedReply({ ...claimed, utts: ['tv2'] }, { enrolled: false, store: SEGMENTS }), false)
  const kept = heard.judgedReply({ ...claimed, utts: ['me2'] }, { enrolled: true, store: SEGMENTS })
  assert.equal(kept.raw, 'yes')
  assert.equal(kept.id, 'q1')
})

test('the utterance store forgets after two minutes', () => {
  let now = 1_000
  const store = utterancesMod.createUtterances({ now: () => now })
  const id = store.put({ owner: { verdict: 'owner' }, raw: 'open spot if i', text: 'open spotify' })
  assert.equal(typeof id, 'string')
  assert.equal(store.get(id).raw, 'open spot if i')
  assert.equal(store.get('nope'), null)
  assert.equal(store.get(undefined), null)
  now += 120_000
  assert.equal(store.get(id).text, 'open spotify')
  now += 1
  assert.equal(store.get(id), null)
})

/** A fake face for the gate: answers from a script, recording what it was asked. */
function face(...answers) {
  const log = []
  return {
    log,
    ask: async () => answers.shift(),
    audit: (e) => log.push(e),
  }
}

test('the gate judges a spoken answer on the raw words, not the corrected ones', async () => {
  // A learned correction has turned "nah" into "yes": the raw "nah" decides.
  const nah = face({ source: 'voice', text: 'yes', raw: 'nah' })
  const r1 = await gateMod.createGate(nah).check('app.close', { prompt: 'Close Notepad?' })
  assert.equal(r1.allowed, false)
  assert.equal(nah.log[0].reason, 'no')

  const yes = face({ source: 'voice', text: 'yes', raw: 'Yes, go ahead.' })
  assert.equal((await gateMod.createGate(yes).check('app.close', { prompt: 'Close Notepad?' })).allowed, true)

  // A face too old to send raw is still understood.
  const old = face({ source: 'voice', text: 'yes' })
  assert.equal((await gateMod.createGate(old).check('app.close', { prompt: 'Close Notepad?' })).allowed, true)
})

test('the gate takes the reply\'s own verdict over whoever spoke last', async () => {
  const lastSpeaker = () => ({ verdict: 'owner', ownerRecently: true })
  const tv = face({ source: 'voice', raw: 'yes', owner: 'other' })
  const r = await gateMod.createGate({ ...tv, owner: lastSpeaker }).check('app.close', { prompt: 'Close Notepad?' })
  assert.equal(r.allowed, false)
  assert.equal(tv.log[0].reason, 'not-owner')
})

test('a local turn remembers the raw words and hands them to neurons as ctx.raw', async () => {
  const brain = brainMod.createBrain({ known: new Set(registryMod.registry.keys()) })
  // Watch what the time neuron is handed, without changing what it does.
  const time = registryMod.registry.get('time')
  const run = time.run
  const seen = []
  time.run = (params, ctx) => {
    seen.push(ctx.raw)
    return run(params, ctx)
  }
  try {
    const prompts = []
    const frames = []
    const toClaude = []
    const local = localMod.createLocal({
      send: (m) => frames.push(m),
      ask: async () => ({ cancelled: true }),
      gate: {
        // Refuses, so nothing is saved; the prompt shows what was learned.
        check: async (_action, { prompt }) => {
          prompts.push(prompt)
          return { allowed: false, reason: 'no' }
        },
      },
      brain,
      corrections: correctionsMod.createCorrections(),
      toClaude: (text, id) => toClaude.push({ text, id }),
    })

    await local.handle('what time is it', 'a1', { raw: 'what tim is it', utts: ['u1'] })
    assert.deepEqual(
      { text: local.memory.lastUser.text, raw: local.memory.lastUser.raw },
      { text: 'what time is it', raw: 'what tim is it' },
    )
    assert.ok(frames.some((f) => f.ask === 'a1' && f.type === 'done' && f.local === 'time'))
    assert.deepEqual(seen, ['what tim is it'])

    // The correction is learned from the RAW previous utterance. Against the
    // routed text the two sentences are identical and nothing could be learned.
    await local.handle('no, I said what time is it', 'a2')
    assert.equal(local.memory.lastUser.raw, 'no, I said what time is it', 'raw defaults to the text')
    assert.match(prompts.at(-1) ?? '', /when I hear "what tim", you mean "what time"/)
    assert.ok(frames.some((f) => f.ask === 'a2' && f.type === 'done'))
    assert.equal(toClaude.length, 0)
    // Refused, so the redo is what was said this time — routed, and run with
    // that utterance's own raw words.
    assert.deepEqual(seen, ['what tim is it', 'no, I said what time is it'])
  } finally {
    time.run = run
    brain.close()
  }
})
