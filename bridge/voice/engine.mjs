import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import { MODELS, modelPath } from './models.mjs'
import { writeKeywordsFile } from './keywords.mjs'
import { dataDir } from '../store/files.mjs'

/**
 * JARVIS's ears, on this machine.
 *
 * Two worker threads, so the cheap, latency-critical work never queues behind
 * the expensive kind: one spots the wake word (and later checks whose voice it
 * is) in tens of milliseconds; the other runs Whisper, which takes a few
 * hundred. A dormant JARVIS only ever touches the first — speech that does not
 * start with "Hey Jarvis" is never transcribed, never leaves the machine.
 */
export function createVoiceEngine({ config }) {
  const threads = Math.max(2, Math.min(4, cpus().length - 2))
  const workers = {}
  const pending = new Map()
  let seq = 0
  let keywords = null

  function worker(name) {
    if (workers[name]) return workers[name]
    const w = new Worker(new URL('./worker.mjs', import.meta.url))
    w.on('message', ({ id, ok, result, error }) => {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      ok ? p.resolve(result) : p.reject(new Error(error))
    })
    const fail = (err) => {
      delete workers[name]
      for (const [id, p] of pending) {
        if (p.worker !== name) continue
        pending.delete(id)
        p.reject(err instanceof Error ? err : new Error(`voice worker exited (${err})`))
      }
    }
    w.on('error', fail)
    w.on('exit', (code) => code !== 0 && fail(code))
    w.unref()
    workers[name] = w
    return w
  }

  function call(name, op, samples, opts) {
    const id = ++seq
    // A copy is transferred, so the caller keeps its samples for the next step.
    const copy = samples.slice()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker: name })
      worker(name).postMessage({ id, op, samples: copy, opts }, [copy.buffer])
    })
  }

  const installed = (name) => existsSync(modelPath(name))
  const whisperName = () => config.stt.model // 'whisper-base' | 'whisper-small'

  /** Rebuild the keywords file from the current config; null if unusable. */
  function refreshKeywords() {
    if (!installed('kws')) return (keywords = null)
    const out = writeKeywordsFile(config.wake.keywords, modelPath('kws'), dataDir())
    for (const e of out.errors) console.warn(`[jarvis] wake word: ${e}`)
    keywords = out.count ? out.path : null
    return keywords
  }
  refreshKeywords()

  return {
    /** What is usable right now. */
    status() {
      return {
        kws: Boolean(keywords),
        asr: installed(whisperName()),
        speaker: installed('speaker'),
        missing: Object.keys(MODELS).filter((m) => (m === 'whisper-small' ? false : !installed(m))),
        whisper: whisperName(),
      }
    },
    setConfig(next) {
      config = next
      refreshKeywords()
    },
    /** @returns {Promise<{keyword: string, start: number|null, end: number|null} | null>} */
    spot(samples) {
      if (!keywords) return Promise.resolve(null)
      return call('fast', 'kws', samples, { modelDir: modelPath('kws'), keywordsFile: keywords })
    },
    /** @returns {Promise<string>} */
    transcribe(samples) {
      const name = whisperName()
      return call('asr', 'asr', samples, {
        modelDir: modelPath(name),
        size: name.replace('whisper-', ''),
        language: config.stt.language,
        threads,
      })
    },
    /** @returns {Promise<number[]>} */
    embed(samples) {
      return call('fast', 'embed', samples, { modelPath: modelPath('speaker') })
    },
    close() {
      for (const w of Object.values(workers)) void w.terminate()
    },
  }
}
