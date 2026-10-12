import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Runs the sherpa-onnx engines off the bridge's main thread, so a two-second
 * transcription never stalls the socket that is streaming JARVIS's answer.
 *
 * Each engine is built on first use and kept: loading Whisper takes most of a
 * second, decoding an utterance a fraction of one. A request names the model
 * it wants; if that changes (a different Whisper size or language in the
 * settings) the old engine is dropped and a new one built.
 *
 * Every call into sherpa passes `enableExternalBuffer = false`: the desktop app
 * runs this inside Electron, whose memory cage rejects external buffers.
 */
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const cache = new Map()

function engine(key, build) {
  if (!cache.has(key)) cache.set(key, build())
  return cache.get(key)
}

/**
 * A keyword spotter for one keywords file. The file is read only here, so a
 * new spotter is the only way to pick up different keywords (or different
 * thresholds) — and building one takes the best part of a second.
 */
function spotter(modelDir, keywordsFile) {
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: join(modelDir, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
        joiner: join(modelDir, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
      },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile,
  })
}

/**
 * First keyword `kws` spots in the clip, or null. `start` and `end` are the
 * times (seconds into the clip) the spotter stamped on its first and last
 * phone — the last one lands at the end of the word, which is where the
 * command after "Hey Jarvis" begins.
 */
function firstKeyword(kws, samples) {
  const stream = kws.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  // Tail padding flushes the last few frames through the streaming model.
  stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000 * 0.4) })
  while (kws.isReady(stream)) {
    kws.decode(stream)
    const r = kws.getResult(stream)
    if (r.keyword) {
      // Phone times count from the stream's (re)start, which is the clip's start here.
      const at = r.start_time ?? 0
      const ts = Array.isArray(r.timestamps) ? r.timestamps : []
      return { keyword: r.keyword, start: ts.length ? at + ts[0] : null, end: ts.length ? at + ts[ts.length - 1] : null }
    }
  }
  return null
}

const ops = {
  /** The live spotter: first keyword in the clip, or null (see firstKeyword). */
  kws(samples, { modelDir, keywordsFile }) {
    const kws = engine(`kws|${modelDir}|${keywordsFile}`, () => {
      // An edited keywords file is a new spotter; the old one is dropped.
      for (const k of cache.keys()) if (k.startsWith('kws|')) cache.delete(k)
      return spotter(modelDir, keywordsFile)
    })
    return firstKeyword(kws, samples)
  },

  /**
   * Which of several clips a spotter built from `keywordsFile` wakes on — one
   * setting of enrollment's sweep. Built for this call and not kept: each
   * setting is tried once, on all its clips together.
   */
  kwsTrial(clips, { modelDir, keywordsFile }) {
    const kws = spotter(modelDir, keywordsFile)
    return clips.map((samples) => Boolean(firstKeyword(kws, samples)))
  },

  /** Whisper transcript of the clip. */
  asr(samples, { modelDir, size, language, threads }) {
    const asr = engine(`asr|${modelDir}|${language}|${threads}`, () => {
      for (const k of cache.keys()) if (k.startsWith('asr|')) cache.delete(k)
      return new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: {
            encoder: join(modelDir, `${size}-encoder.int8.onnx`),
            decoder: join(modelDir, `${size}-decoder.int8.onnx`),
            language: language === 'auto' ? '' : language,
            task: 'transcribe',
            tailPaddings: -1,
          },
          tokens: join(modelDir, `${size}-tokens.txt`),
          numThreads: threads,
          provider: 'cpu',
          debug: 0,
        },
      })
    })
    const stream = asr.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    asr.decode(stream)
    return asr.getResult(stream).text ?? ''
  },

  /** Speaker embedding of the clip (for "only my voice"). */
  embed(samples, { modelPath }) {
    const spk = engine(`spk|${modelPath}`, () => new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false }))
    const stream = spk.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    stream.inputFinished()
    return Array.from(spk.compute(stream, false))
  },
}

parentPort.on('message', ({ id, op, samples, opts }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: ops[op](samples, opts) })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message ?? err) })
  }
})
