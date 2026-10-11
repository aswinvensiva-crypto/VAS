import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

/**
 * The voice models JARVIS runs locally, and how they get onto this machine.
 *
 * Nothing here downloads on its own: the app asks first, and `npm run models`
 * is the developer's explicit version of that click. Every file is checked
 * against its published byte size, and against a pinned sha256 — taken from
 * GitHub's own asset digest where the release carries one, and otherwise
 * recorded on the first verified download into models.lock.json, so a later
 * download that differs is refused rather than silently trusted.
 */

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

export const MODELS = {
  kws: {
    file: 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2',
    url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2`,
    size: 32885699,
    dir: 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20',
  },
  'whisper-base': {
    file: 'sherpa-onnx-whisper-base.tar.bz2',
    url: `${RELEASES}/asr-models/sherpa-onnx-whisper-base.tar.bz2`,
    size: 207557382,
    dir: 'sherpa-onnx-whisper-base',
  },
  'whisper-small': {
    file: 'sherpa-onnx-whisper-small.tar.bz2',
    url: `${RELEASES}/asr-models/sherpa-onnx-whisper-small.tar.bz2`,
    size: 639387718,
    dir: 'sherpa-onnx-whisper-small',
  },
  speaker: {
    // The release tag really is spelled this way upstream.
    file: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
    url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`,
    size: 29596978,
  },
}

const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'models.lock.json')

/** %LOCALAPPDATA%\VAS\models — local, not roaming: these are large and per-machine. */
export function modelsDir() {
  if (process.env.JARVIS_MODELS_DIR) return process.env.JARVIS_MODELS_DIR
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(base, 'VAS', 'models')
}

async function readLock() {
  try {
    return JSON.parse(await readFile(LOCK_PATH, 'utf8'))
  } catch {
    return {}
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Where a model's usable files end up once installed. */
export function modelPath(name) {
  const m = MODELS[name]
  return join(modelsDir(), m.dir ?? m.file)
}

/** Which models are installed, by name. */
export async function status() {
  const out = {}
  for (const name of Object.keys(MODELS)) out[name] = await exists(modelPath(name))
  return out
}

/** Stream one file to `<dest>.part`, hashing as it goes, then verify and rename. */
async function download(model, dest, expectedSha, onProgress) {
  const part = `${dest}.part`
  const res = await fetch(model.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${model.file}: HTTP ${res.status}`)
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    if (received - lastReport > 8 * 1024 * 1024 || received === model.size) {
      lastReport = received
      onProgress?.({ file: model.file, received, total: model.size })
    }
  })
  await pipeline(body, createWriteStream(part))
  const sha256 = hash.digest('hex')
  if (received !== model.size) {
    await rm(part, { force: true })
    throw new Error(`${model.file}: expected ${model.size} bytes, got ${received}`)
  }
  if (expectedSha && expectedSha !== sha256) {
    await rm(part, { force: true })
    throw new Error(`${model.file}: sha256 mismatch (expected ${expectedSha}, got ${sha256})`)
  }
  await rename(part, dest)
  return sha256
}

const execFileP = promisify(execFile)

/** Windows ships bsdtar, which reads .tar.bz2 natively. */
async function extract(archive, into) {
  const tar = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  await execFileP(tar, ['-xjf', archive, '-C', into], { windowsHide: true, maxBuffer: 1 << 20 })
}

/**
 * Drop full-precision weights wherever an int8 twin exists — they double the
 * disk use and the int8 ones are what the engines load. A file with no int8
 * twin (the keyword spotter's decoder) is kept.
 */
async function pruneFp32(dir) {
  const names = await readdir(dir)
  const set = new Set(names)
  let freed = 0
  for (const name of names) {
    if (!name.endsWith('.onnx') || name.endsWith('.int8.onnx')) continue
    if (!set.has(name.replace(/\.onnx$/, '.int8.onnx'))) continue
    const path = join(dir, name)
    freed += (await stat(path)).size
    await rm(path)
  }
  return freed
}

/**
 * Install the named models (default: all). Already-installed ones are skipped.
 * Returns the sha256 values recorded so the caller can report them.
 */
export async function fetchModels(names = Object.keys(MODELS), onProgress) {
  const root = modelsDir()
  await mkdir(root, { recursive: true })
  const lock = await readLock()
  let lockChanged = false
  const results = {}

  for (const name of names) {
    const model = MODELS[name]
    if (!model) throw new Error(`unknown model "${name}"`)
    if (await exists(modelPath(name))) {
      results[name] = { status: 'present' }
      continue
    }
    const expected = lock[model.file]?.sha256
    const dest = join(root, model.file)
    const sha256 = await download(model, dest, expected, onProgress)
    if (!expected) {
      lock[model.file] = { size: model.size, sha256 }
      lockChanged = true
    }
    if (model.dir) {
      await extract(dest, root)
      await rm(dest)
      const freed = await pruneFp32(join(root, model.dir))
      results[name] = { status: 'installed', sha256, prunedBytes: freed }
    } else {
      results[name] = { status: 'installed', sha256 }
    }
  }

  if (lockChanged) await writeFile(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n')
  return results
}
