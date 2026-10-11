/**
 * Feasibility probe for JARVIS's local voice stack (sherpa-onnx).
 *
 *   npm run probe:voice            # synthetic clips from the Windows voices
 *   npm run probe:voice -- a.wav   # plus your own 16 kHz mono recordings
 *
 * Answers, on this machine: does "Hey Jarvis" fire (and not fire on near
 * misses)? How fast are Whisper base and small, and do they get the words
 * right? Do speaker embeddings separate two different voices? It also calls
 * every engine the way Electron requires (no external buffers), so a pass here
 * means the same code will load inside the desktop app.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { modelPath, status } from '../bridge/voice/models.mjs'
import { DEFAULT_WAKE_KEYWORDS } from '../bridge/store/config.mjs'

const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const execFileP = promisify(execFile)
const THREADS = Math.max(2, Math.min(4, cpus().length - 2))

const installed = await status()
const missing = Object.entries(installed).filter(([, ok]) => !ok).map(([n]) => n)
if (missing.length) {
  console.log(`missing models: ${missing.join(', ')} — run npm run models first`)
  process.exit(1)
}
console.log(`sherpa-onnx ${sherpa.version} · onnxruntime ${sherpa.onnxruntimeVersion} · ${THREADS} threads`)

// ---------------------------------------------------------------------------
// Test clips: synthesised by Windows SAPI at 16 kHz mono, two different voices.
// ---------------------------------------------------------------------------
const PHRASES = {
  wake: 'Hey Jarvis.',
  wake_cmd: 'Hey Jarvis, open Spotify.',
  near_miss: 'The service was slow, so Travis went home early.',
  command: 'Search Chrome for the weather in Kochi tomorrow, then open Visual Studio Code.',
}

const dir = mkdtempSync(join(tmpdir(), 'vas-probe-'))
const spec = join(dir, 'spec.json')
writeFileSync(spec, JSON.stringify({ dir, phrases: PHRASES }))
const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$spec = Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 2)
$i = 0
foreach ($v in $voices) {
  $s.SelectVoice($v.VoiceInfo.Name)
  foreach ($p in $spec.phrases.PSObject.Properties) {
    $f = Join-Path $spec.dir ("v$i-" + $p.Name + '.wav')
    $s.SetOutputToWaveFile($f, $fmt); $s.Speak($p.Value); $s.SetOutputToNull()
  }
  Write-Output ("v$i=" + $v.VoiceInfo.Name)
  $i++
}`
const psPath = join(dir, 'make.ps1')
writeFileSync(psPath, ps)
const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, spec], { windowsHide: true })
const voices = Object.fromEntries(stdout.trim().split(/\r?\n/).map((l) => l.split('=')))
console.log('voices:', Object.entries(voices).map(([k, v]) => `${k}=${v}`).join(', '))

const clips = []
for (const v of Object.keys(voices)) {
  for (const name of Object.keys(PHRASES)) clips.push({ voice: v, name, file: join(dir, `${v}-${name}.wav`), truth: PHRASES[name] })
}
for (const f of process.argv.slice(2)) clips.push({ voice: 'you', name: f, file: f, truth: '' })

// Electron (21+) refuses external ArrayBuffers, so read without them.
const read = (file) => sherpa.readWave(file, false)
const seconds = (w) => w.samples.length / w.sampleRate

// ---------------------------------------------------------------------------
// Keyword spotting
// ---------------------------------------------------------------------------
const kwsDir = modelPath('kws')
const kwsFile = join(dir, 'keywords.txt')
writeFileSync(
  kwsFile,
  DEFAULT_WAKE_KEYWORDS.flatMap((k) => k.phones.map((p) => `${p} :${k.boost} #${k.threshold} @${k.name}`)).join('\n') + '\n',
)
let t0 = Date.now()
const kws = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: join(kwsDir, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: join(kwsDir, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
      joiner: join(kwsDir, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
    },
    tokens: join(kwsDir, 'tokens.txt'),
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
  keywordsFile: kwsFile,
})
console.log(`\n== keyword spotting (loaded in ${Date.now() - t0} ms)`)
for (const c of clips) {
  const w = read(c.file)
  const stream = kws.createStream()
  t0 = performance.now()
  stream.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples })
  stream.acceptWaveform({ sampleRate: w.sampleRate, samples: new Float32Array(w.sampleRate * 0.4) })
  const hits = []
  while (kws.isReady(stream)) {
    kws.decode(stream)
    const r = kws.getResult(stream)
    if (r.keyword) {
      hits.push({ keyword: r.keyword, start: r.start_time, ts: r.timestamps?.slice(-1)[0] })
      kws.reset(stream)
    }
  }
  const ms = (performance.now() - t0).toFixed(0)
  const expect = c.name.startsWith('wake') ? 'HIT' : c.voice === 'you' ? '?' : 'none'
  console.log(`  ${c.voice} ${c.name.padEnd(10)} ${seconds(w).toFixed(1)}s ${ms.padStart(4)} ms  expected ${expect.padEnd(4)} got ${hits.length ? JSON.stringify(hits) : 'none'}`)
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------
const wer = (truth, said) => {
  const a = truth.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().split(/\s+/)
  const b = said.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length] / a.length
}

for (const size of ['base', 'small']) {
  for (const language of ['en', '']) {
    const m = modelPath(`whisper-${size}`)
    t0 = Date.now()
    const asr = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: join(m, `${size}-encoder.int8.onnx`),
          decoder: join(m, `${size}-decoder.int8.onnx`),
          language,
          task: 'transcribe',
          tailPaddings: -1,
        },
        tokens: join(m, `${size}-tokens.txt`),
        numThreads: THREADS,
        provider: 'cpu',
        debug: 0,
      },
    })
    console.log(`\n== whisper ${size}, language=${language || 'auto'} (loaded in ${Date.now() - t0} ms, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB)`)
    let total = 0
    let audio = 0
    for (const c of clips.filter((c) => c.voice === 'you' || c.name !== 'wake')) {
      const w = read(c.file)
      const stream = asr.createStream()
      stream.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples })
      const t = performance.now()
      asr.decode(stream)
      const ms = performance.now() - t
      total += ms
      audio += seconds(w)
      const text = asr.getResult(stream).text.trim()
      const score = c.truth ? ` WER ${(wer(c.truth, text) * 100).toFixed(0)}%` : ''
      console.log(`  ${c.voice} ${c.name.padEnd(10)} ${(ms / 1000).toFixed(2)}s${score}  "${text}"`)
    }
    console.log(`  RTF ${(total / 1000 / audio).toFixed(2)} (${(total / 1000).toFixed(1)}s for ${audio.toFixed(1)}s of audio)`)
  }
}

// ---------------------------------------------------------------------------
// Speaker embeddings
// ---------------------------------------------------------------------------
t0 = Date.now()
const spk = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath('speaker'), numThreads: 1, debug: false })
console.log(`\n== speaker embeddings (loaded in ${Date.now() - t0} ms, dim ${spk.dim})`)
const embed = (file) => {
  const w = read(file)
  const s = spk.createStream()
  s.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples })
  s.inputFinished()
  return spk.compute(s, false)
}
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / Math.sqrt(na * nb)
}
const vecs = clips.filter((c) => c.voice !== 'you').map((c) => ({ ...c, v: embed(c.file) }))
const same = []
const diff = []
for (let i = 0; i < vecs.length; i++)
  for (let j = i + 1; j < vecs.length; j++)
    (vecs[i].voice === vecs[j].voice ? same : diff).push(cosine(vecs[i].v, vecs[j].v))
const fmt = (xs) => xs.length ? `min ${Math.min(...xs).toFixed(2)} avg ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} max ${Math.max(...xs).toFixed(2)}` : 'n/a'
console.log(`  same voice, different words: ${fmt(same)}`)
console.log(`  different voices:            ${fmt(diff)}`)
console.log(`\nclips kept in ${dir}`)
