import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, parseWav, rms, WavError } from '../../bridge/voice/wav.mjs'
import { keywordLines, phonesFor, writeKeywordsFile } from '../../bridge/voice/keywords.mjs'
import { cleanTranscript, isPhantom, opensWithWake, speechRatio, stripName, stripWake } from '../../bridge/voice/transcript.mjs'
import { ConfigSchema, DEFAULT_WAKE_KEYWORDS } from '../../bridge/store/config.mjs'
import { modelPath, status } from '../../bridge/voice/models.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

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

/** A few lines of en.phone, as readLexicon would hold them. */
const LEXICON = new Map([
  ['HEY', 'HH EY1'],
  ['JARVIS', 'JH AA1 R V AH0 S'],
  ['FRIDAY', 'F R AY1 D IY0'],
  ["WHAT'S", 'W AH1 T S'],
  ['UP', 'AH1 P'],
])
const TOKENS = new Set('HH EY1 JH AA1 R V AH0 IH0 S F AY1 D IY0 W AH1 T P'.split(' '))

test('phonesFor: a phrase is its words looked up in the dictionary, or null', () => {
  assert.equal(phonesFor('Hey Jarvis', null, LEXICON), 'HH EY1 JH AA1 R V AH0 S')
  assert.equal(phonesFor('  hey,   FRIDAY! ', null, LEXICON), 'HH EY1 F R AY1 D IY0')
  assert.equal(phonesFor('What’s up', null, LEXICON), 'W AH1 T S AH1 P') // a typographic apostrophe too
  assert.equal(phonesFor('hey jarvo', null, LEXICON), null) // one unknown word spoils the phrase
  assert.equal(phonesFor('...', null, LEXICON), null)
})

test('keywords: a keyword given as words is written as its phones; a phrase that cannot be said is reported', () => {
  const { lines, errors } = keywordLines(
    [
      { name: 'HEY_FRIDAY', phrases: ['hey friday'], boost: 1.5, threshold: 0.3 },
      // Phones and a phrase that says the same thing make one line, not two.
      { name: 'HEY_JARVIS', phones: ['HH EY1 JH AA1 R V AH0 S'], phrases: ['Hey, Jarvis', 'hey jarvo'], boost: 1, threshold: 0.4 },
    ],
    TOKENS,
    LEXICON,
  )
  assert.deepEqual(lines, ['HH EY1 F R AY1 D IY0 :1.5 #0.3 @HEY_FRIDAY', 'HH EY1 JH AA1 R V AH0 S :1 #0.4 @HEY_JARVIS'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /HEY_JARVIS: cannot say "hey jarvo" — no pronunciation for JARVO/)
  // Without the dictionary a phrase cannot be looked up; phones still work.
  const bare = keywordLines([{ name: 'HEY_FRIDAY', phrases: ['hey friday'], boost: 1.5, threshold: 0.3 }], TOKENS)
  assert.deepEqual(bare.lines, [])
  assert.match(bare.errors[0], /en\.phone/)
})

test('config: a wake keyword may be written as just the words', () => {
  const wake = (keywords) => ConfigSchema.parse({ wake: { keywords } }).wake.keywords
  assert.deepEqual(wake(['hey friday']), [
    { name: 'HEY_FRIDAY', phones: [], phrases: ['hey friday'], boost: 1.5, threshold: 0.25, enabled: true },
  ])
  assert.equal(wake(['  2001, a space odyssey ']).at(0).name, 'WAKE_2001_A_SPACE_ODYSSEY')
  const full = wake([{ name: 'COMPUTER', phrases: ['computer'], threshold: 0.4 }]).at(0)
  assert.deepEqual([full.phones, full.phrases, full.threshold], [[], ['computer'], 0.4])
  // The default keeps working unchanged, and a keyword with nothing to say is refused.
  assert.equal(ConfigSchema.parse({}).wake.keywords[0].phones[0], 'HH EY1 JH AA1 R V AH0 S')
  assert.equal(ConfigSchema.safeParse({ wake: { keywords: [{ name: 'X' }] } }).success, false)
  assert.equal(ConfigSchema.safeParse({ wake: { keywords: [''] } }).success, false)
})

const kwsModel = (await status()).kws ? modelPath('kws') : null

test('keywords: phrases are looked up in the real model dictionary', { skip: !kwsModel && 'needs the keyword model' }, () => {
  assert.equal(phonesFor('hey jarvis', kwsModel), 'HH EY1 JH AA1 R V AH0 S')
  const dir = mkdtempSync(joinPath(tmpdir(), 'vas-kw-'))
  try {
    const out = writeKeywordsFile(ConfigSchema.parse({ wake: { keywords: ['hey jarvis', 'computer'] } }).wake.keywords, kwsModel, dir)
    assert.deepEqual(out.errors, [])
    assert.deepEqual(readFileSync(out.path, 'utf8').trim().split('\n'), [
      'HH EY1 JH AA1 R V AH0 S :1.5 #0.25 @HEY_JARVIS',
      'K AH0 M P Y UW1 T ER0 :1.5 #0.25 @COMPUTER',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
