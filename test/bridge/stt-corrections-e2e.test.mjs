import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, synthesize } from './helpers.mjs'
import { status } from '../../bridge/voice/models.mjs'

/**
 * "Next time it is corrected automatically": a correction learned earlier
 * (seeded here into a throwaway data folder, as the "no, I said …" flow saves
 * it) is applied to what /stt returns — `text` corrected, `raw` exactly as
 * Whisper heard it, for learning the next one. Real Whisper on speech from a
 * Windows voice; skips cleanly where either is missing.
 */
const models = await status()
const clips = models['whisper-base']
  ? synthesize({
      command: 'Search Chrome for the weather tomorrow.',
      ...(models.kws ? { wake: 'Hey Jarvis, what is the weather like today?' } : {}),
    })
  : null
const skip = clips ? false : 'needs the local Whisper model (npm run models) and Windows speech synthesis'

let bridge
let dir
before(async () => {
  if (skip) return
  dir = mkdtempSync(join(tmpdir(), 'vas-corr-'))
  const data = join(dir, 'data')
  mkdirSync(data)
  writeFileSync(join(data, 'corrections.json'), JSON.stringify([{ heard: 'weather', meant: 'calendar', source: 'voice' }]))
  bridge = await startBridge({ env: { JARVIS_DATA_DIR: data } })
})
after(async () => {
  await bridge?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function stt(mode, file) {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/stt?mode=${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-vas-token': bridge.token },
    body: readFileSync(file),
  })
  assert.equal(res.status, 200)
  return res.json()
}

test('a learned correction is applied to the next transcript; the raw one rides along', { skip }, async () => {
  const out = await stt('command', clips.command)
  assert.match(out.raw, /weather/i, JSON.stringify(out))
  assert.match(out.text, /calendar/i)
  assert.doesNotMatch(out.text, /weather/i)
  assert.equal(typeof out.utt, 'string')
})

test('the command after the wake word is corrected the same way', { skip: skip || (!models.kws && 'needs the keyword model') }, async () => {
  const out = await stt('wake', clips.wake)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS', JSON.stringify(out))
  assert.match(out.wake.trailing, /calendar/i)
  assert.equal(out.text, out.wake.trailing)
  assert.match(out.raw, /weather/i)
})
