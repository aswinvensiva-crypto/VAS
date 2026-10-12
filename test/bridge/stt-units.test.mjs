import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleSegment, afterKeyword } from '../../bridge/voice/stt.mjs'
import { parseWav } from '../../bridge/voice/wav.mjs'

/**
 * handleSegment with stand-ins for the models and for Scribe: what is sent
 * where, and which part of the audio is transcribed. The real models are
 * exercised in voice-e2e.test.mjs.
 */

const RATE = 16000

/** Something shaped like speech: deterministic noise in syllable-length bursts. */
function speechLike(seconds) {
  let seed = 7
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const syllable = Math.abs(Math.sin((Math.PI * 4 * i) / RATE))
    out[i] = ((seed / 2147483648) * 2 - 1) * 0.3 * syllable
  }
  return out
}

/** A stand-in engine that records what it was asked to do. */
function fakeEngine({ kws = true, asr = true, hit = null, said = 'Hey Jarvis, open Spotify.' } = {}) {
  const calls = { spot: 0, transcribed: [] }
  return {
    calls,
    status: () => ({ kws, asr, speaker: false, whisper: 'whisper-base' }),
    spot: async () => {
      calls.spot++
      return hit
    },
    embed: async () => [1, 0, 0],
    transcribe: async (samples) => {
      calls.transcribed.push(samples.length)
      return said
    },
  }
}

/** A stand-in for ElevenLabs Scribe that remembers every upload. */
function fakeScribe(said = 'open Spotify') {
  const fn = async (wav) => {
    fn.sent.push(wav)
    return said
  }
  fn.sent = []
  return fn
}

const config = { stt: { engine: 'auto' }, owner: { require: 'all' } }
const samples = speechLike(3)
const wav = Buffer.from('a stand-in for the original upload')
const hit = { keyword: 'HEY_JARVIS', start: 0.1, end: 0.8 }

test('dormant: a segment without the wake word goes nowhere — not to Whisper, not to Scribe', async () => {
  const engine = fakeEngine({ hit: null })
  const scribe = fakeScribe()
  const out = await handleSegment({ samples, wav, mode: 'wake', engine, config, scribe })
  assert.deepEqual(out, { text: '', wake: null, engine: 'kws' })
  assert.equal(engine.calls.spot, 1)
  assert.deepEqual(engine.calls.transcribed, [])
  assert.equal(scribe.sent.length, 0)
})

test('dormant without the keyword model: local Whisper for the name fallback, never Scribe', async () => {
  const engine = fakeEngine({ kws: false, said: 'Hey Jarvis, what time is it?' })
  const scribe = fakeScribe()
  const out = await handleSegment({ samples, wav, mode: 'wake', engine, config, scribe })
  assert.equal(scribe.sent.length, 0)
  assert.equal(engine.calls.spot, 0)
  assert.deepEqual(engine.calls.transcribed, [samples.length])
  // No `wake` field: the face matches the name in the transcript itself.
  assert.equal(out.wake, undefined)
  assert.equal(out.text, 'Hey Jarvis, what time is it?')
  assert.equal(out.engine, 'whisper-base')
})

test('dormant with no local models at all: models-missing, and still nothing uploaded', async () => {
  const engine = fakeEngine({ kws: false, asr: false })
  const scribe = fakeScribe()
  const out = await handleSegment({ samples, wav, mode: 'wake', engine, config, scribe })
  assert.equal(out.reason, 'models-missing')
  assert.equal(out.text, '')
  assert.equal(scribe.sent.length, 0)
  assert.deepEqual(engine.calls.transcribed, [])
})

test('a wake hit is transcribed locally, from where the wake phrase ended', async () => {
  const engine = fakeEngine({ hit, said: 'open Spotify.' })
  const scribe = fakeScribe()
  const out = await handleSegment({ samples, wav, mode: 'wake', engine, config, scribe })
  assert.equal(scribe.sent.length, 0)
  assert.deepEqual(engine.calls.transcribed, [samples.length - 0.8 * RATE])
  assert.deepEqual(out.wake, { keyword: 'HEY_JARVIS', trailing: 'open Spotify.' })
  assert.equal(out.text, 'open Spotify.')
})

test('a leftover name after the cut is dropped; a command that starts with a greeting is not', async () => {
  const name = await handleSegment({ samples, mode: 'wake', engine: fakeEngine({ hit, said: 'Jarvis, open Spotify.' }), config })
  assert.equal(name.text, 'open Spotify.')
  const greeting = await handleSegment({ samples, mode: 'wake', engine: fakeEngine({ hit, said: 'Hey Siri is worse than you.' }), config })
  assert.equal(greeting.text, 'Hey Siri is worse than you.')
})

test('without a usable cut the whole segment is transcribed and the phrase stripped from the text', async () => {
  for (const h of [{ ...hit, end: null }, { ...hit, end: 2.9 }]) {
    const engine = fakeEngine({ hit: h, said: 'Hey Charvis, open Spotify.' })
    const out = await handleSegment({ samples, mode: 'wake', engine, config })
    assert.deepEqual(engine.calls.transcribed, [samples.length], JSON.stringify(h))
    assert.equal(out.wake.trailing, 'open Spotify.')
  }
  assert.equal(afterKeyword(samples, { end: 2.7 }), null) // 0.3 s left: too little
  assert.equal(afterKeyword(samples, { end: 2.5 }).length, 0.5 * RATE)
})

test('command mode: a leading "Hey Jarvis" is cut off the audio before Scribe hears it', async () => {
  const engine = fakeEngine({ hit })
  const scribe = fakeScribe('open Spotify')
  const out = await handleSegment({ samples, wav, mode: 'command', engine, config, scribe })
  assert.equal(engine.calls.spot, 1)
  assert.equal(scribe.sent.length, 1)
  assert.equal(parseWav(scribe.sent[0]).samples.length, samples.length - 0.8 * RATE)
  assert.equal(out.text, 'open Spotify')
  assert.equal(out.engine, 'scribe')
  assert.equal(out.wake, undefined)
})

test('command mode: a wake phrase later in the sentence is left alone', async () => {
  const engine = fakeEngine({ hit: { ...hit, start: 1.6, end: 2.1 }, said: 'Open Spotify, hey Jarvis.' })
  const scribe = fakeScribe('Open Spotify, hey Jarvis.')
  const out = await handleSegment({ samples, wav, mode: 'command', engine, config, scribe })
  assert.equal(scribe.sent[0], wav) // the original upload, uncut
  assert.equal(out.text, 'Open Spotify, hey Jarvis.')
  const local = fakeEngine({ hit: { ...hit, start: 1.6, end: 2.1 }, said: 'Open Spotify, hey Jarvis.' })
  await handleSegment({ samples, mode: 'command', engine: local, config: { ...config, stt: { engine: 'local' } } })
  assert.deepEqual(local.calls.transcribed, [samples.length])
})

test('guard mode is transcribed as it is, without spotting', async () => {
  const engine = fakeEngine({ hit })
  const out = await handleSegment({ samples, mode: 'guard', engine, config })
  assert.equal(engine.calls.spot, 0)
  assert.equal(out.text, 'Hey Jarvis, open Spotify.')
})

test('a mostly silent segment yields no words, whatever Whisper read into it', async () => {
  const quiet = new Float32Array(2.5 * RATE)
  for (let i = 0; i < quiet.length; i++) quiet[i] = (i % 7) * 0.0002 // a faint, even hiss
  quiet.fill(0.4, RATE, RATE + 0.06 * RATE) // and one click
  const engine = fakeEngine({ kws: false, said: 'I will see you in the next video.' })
  const out = await handleSegment({ samples: quiet, mode: 'command', engine, config })
  assert.deepEqual(engine.calls.transcribed, [quiet.length])
  assert.equal(out.text, '')
})
