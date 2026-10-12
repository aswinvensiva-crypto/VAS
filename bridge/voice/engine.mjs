import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { existsSync, rmSync } from 'node:fs'
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
  let trials = 0

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
      // A worker let go on purpose (endTrials) may exit after its successor
      // has started; that one's calls are none of this exit's business.
      if (workers[name] !== w) return
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

  /** `samples` is one clip, or a list of them for an op that takes several. */
  function call(name, op, samples, opts) {
    const id = ++seq
    // A copy is transferred, so the caller keeps its samples for the next step.
    const copy = Array.isArray(samples) ? samples.map((s) => s.slice()) : samples.slice()
    const buffers = Array.isArray(copy) ? copy.map((s) => s.buffer) : [copy.buffer]
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker: name })
      worker(name).postMessage({ id, op, samples: copy, opts }, buffers)
    })
  }

  const installed = (name) => existsSync(modelPath(name))
  const whisperName = () => config.stt.model // 'whisper-base' | 'whisper-small'

  /**
   * Rebuild the keywords file from the current config; null if unusable.
   * The file keeps its name, so each rebuild gets a new version number: the
   * worker keeps its spotter by (file, version), and a new version is what
   * makes it build one from the new file — wake tuning and hand edits apply
   * at once rather than at the next start.
   */
  let keywordsVersion = 0
  function refreshKeywords() {
    keywordsVersion++
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
      return call('fast', 'kws', samples, { modelDir: modelPath('kws'), keywordsFile: keywords, version: keywordsVersion })
    },
    /**
     * Which of `clips` would wake JARVIS if the wake keywords were `trial`
     * instead of the live ones — one setting of enrollment's sweep. Each try
     * builds its own spotter on a thread of its own, so a sweep never holds
     * up the live spotter or pushes it out of the cache; endTrials() lets the
     * thread go when the sweep is over.
     * @param {Float32Array[]} clips
     * @param {object[]} trial  keywords, shaped like config.wake.keywords
     * @returns {Promise<boolean[]>}
     */
    async spotTrial(clips, trial) {
      if (!installed('kws') || !clips.length) return clips.map(() => false)
      const file = writeKeywordsFile(trial, modelPath('kws'), dataDir(), `keywords.trial-${process.pid}-${++trials}.txt`)
      try {
        if (!file.count) return clips.map(() => false)
        return await call('trial', 'kwsTrial', clips, { modelDir: modelPath('kws'), keywordsFile: file.path })
      } finally {
        rmSync(file.path, { force: true })
      }
    },
    /** Let the sweep's thread go; call once its last spotTrial has settled. */
    endTrials() {
      const w = workers.trial
      delete workers.trial
      void w?.terminate()
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
