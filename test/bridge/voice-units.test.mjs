import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, parseWav, rms, WavError } from '../../bridge/voice/wav.mjs'
import { keywordLines } from '../../bridge/voice/keywords.mjs'
import { cleanTranscript, isPhantom, opensWithWake, speechRatio, stripName, stripWake } from '../../bridge/voice/transcript.mjs'
import { DEFAULT_WAKE_KEYWORDS } from '../../bridge/store/config.mjs'

test('WAV: 16-bit mono round trip', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])
  const { sampleRate, samples: back } = parseWav(encodeWav(samples, 16000))
  assert.equal(sampleRate, 16000)
  assert.equal(back.length, samples.length)
  for (let i = 0; i < samples.length; i++) assert.ok(Math.abs(back[i] - samples[i]) < 1e-3, `sample ${i}`)
})

test('WAV: stereo is mixed down, garbage is refused', () => {
  const stereo = encodeWav(new Float32Array([0.5, -0.5, 0.2, 0.4]), 16000)
  stereo.writeUInt16LE(2, 22) // claim two channels
  const { samples } = parseWav(stereo)
  assert.equal(samples.length, 2)
  assert.ok(Math.abs(samples[0]) < 1e-3 && Math.abs(samples[1] - 0.3) < 1e-3)
  assert.throws(() => parseWav(Buffer.from('not audio at all, honestly, not at all. no.')), WavError)
  assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5)
})

test('keywords: lines are written in the spotter format; unknown phones are skipped, not fatal', () => {
  const tokens = new Set(['HH', 'EY1', 'JH', 'AA1', 'R', 'V', 'AH0', 'S', 'IH0'])
  const { lines, errors } = keywordLines(DEFAULT_WAKE_KEYWORDS, tokens)
  assert.deepEqual(lines, ['HH EY1 JH AA1 R V AH0 S :1.5 #0.25 @HEY_JARVIS', 'HH EY1 JH AA1 R V IH0 S :1.5 #0.25 @HEY_JARVIS'])
  assert.deepEqual(errors, [])
  const bad = keywordLines([{ name: 'X', phones: ['HH QQ9'], boost: 1, threshold: 0.3 }], tokens)
  assert.equal(bad.lines.length, 0)
  assert.match(bad.errors[0], /QQ9/)
  assert.equal(keywordLines([{ ...DEFAULT_WAKE_KEYWORDS[0], enabled: false }], tokens).lines.length, 0)
})

test('stripWake leaves just the command', () => {
  assert.equal(stripWake('Hey Jarvis, open Spotify.'), 'open Spotify.')
  assert.equal(stripWake('Hey Travis open notepad'), 'open notepad')
  assert.equal(stripWake('Hey Charvis, what time is it?'), 'what time is it?') // unknown spelling, known opener
  assert.equal(stripWake('Hey Jarvis.'), '')
  assert.equal(stripWake('jarvis'), '')
})

test('transcripts: annotations removed, invented phrases dropped only when quiet', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] hello (music) there ♪ '), 'hello there')
  assert.equal(isPhantom('Thank you.', { seconds: 1.2, rms: 0.004 }), true)
  assert.equal(isPhantom('Thank you.', { seconds: 1.2, rms: 0.08 }), false)
  assert.equal(isPhantom('...', { seconds: 2, rms: 0.1 }), true)
  assert.equal(isPhantom('open chrome', { seconds: 0.3, rms: 0.1 }), true)
  assert.equal(isPhantom('open chrome', { seconds: 1.0, rms: 0.1 }), false)
})

/** A stretch of audio: deterministic noise at `level`, in syllable bursts when `voiced`. */
function audio(seconds, level, { voiced = false } = {}) {
  let seed = 3
  return Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const noise = (seed / 2147483648) * 2 - 1
    return noise * level * (voiced ? Math.abs(Math.sin((Math.PI * 4 * i) / 16000)) : 1)
  })
}
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

test('speech ratio: how much of a segment is sound at all', () => {
  const room = 0.002
  // What the face's detector sends for a one-word answer: 300 ms before, 650 ms after.
  const yes = join(audio(0.3, room), audio(0.35, 0.2, { voiced: true }), audio(0.65, room))
  const sentence = join(audio(0.3, room), audio(2.5, 0.2, { voiced: true }), audio(0.65, room))
  const click = join(audio(1, room), audio(0.06, 0.5), audio(1.5, room))
  assert.ok(speechRatio(yes) > 0.2, String(speechRatio(yes)))
  assert.ok(speechRatio(sentence) > 0.6, String(speechRatio(sentence)))
  assert.ok(speechRatio(click) < 0.05, String(speechRatio(click)))
  assert.equal(speechRatio(new Float32Array(32000)), 0) // digital silence
  assert.ok(speechRatio(audio(2, 0.05)) < 0.05) // a steady hiss, however loud, is not speech
  assert.equal(speechRatio(new Float32Array(100)), 0) // shorter than one frame
})

test('a mostly silent segment cannot produce text, on the phantom list or off it', () => {
  const click = join(audio(1, 0.002), audio(0.06, 0.5), audio(1.5, 0.002))
  const said = { seconds: 2.56, rms: 0.05, speech: speechRatio(click) }
  assert.equal(isPhantom('Please remember to like and share.', said), true)
  assert.equal(isPhantom('Please remember to like and share.', { ...said, speech: 0.4 }), false)
  // Without a measurement the other checks still apply on their own.
  assert.equal(isPhantom('open chrome', { seconds: 1.0, rms: 0.1 }), false)
})

test('stripName drops only a known name; opensWithWake needs the greeting too', () => {
  assert.equal(stripName('Jarvis, open Spotify.'), 'open Spotify.')
  assert.equal(stripName('Hey Siri is worse.'), 'Hey Siri is worse.')
  assert.equal(opensWithWake('Hey Jarvis, play some music.'), true)
  assert.equal(opensWithWake('ok travis what time is it'), true)
  assert.equal(opensWithWake('Jarvis, play some music.'), false)
  assert.equal(opensWithWake('Yes, confirm it.'), false)
})
