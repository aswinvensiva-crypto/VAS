import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, synthesize } from './helpers.mjs'
import { status } from '../../bridge/voice/models.mjs'

/**
 * A wake word written in config.json as plain words, with no phones at all:
 * the bridge looks them up in the keyword model's dictionary and the spotter
 * wakes on them, reporting the name made from the words. Real models, speech
 * from a Windows voice; skips cleanly where either is missing.
 */
const models = await status()
const clips =
  models.kws && models['whisper-base']
    ? synthesize({ wake: 'Hey Jarvis, open Spotify.', other: 'The quick brown fox jumps over the lazy dog.' })
    : null
const skip = clips ? false : 'needs the voice models (npm run models) and Windows speech synthesis'

let bridge
let dir
before(async () => {
  if (skip) return
  dir = mkdtempSync(join(tmpdir(), 'vas-phrase-'))
  const data = join(dir, 'data')
  mkdirSync(data)
  writeFileSync(join(data, 'config.json'), JSON.stringify({ wake: { keywords: ['Hey, Jarvis'] } }))
  bridge = await startBridge({ env: { JARVIS_DATA_DIR: data } })
})
after(async () => {
  await bridge?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function stt(file) {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/stt?mode=wake`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-vas-token': bridge.token },
    body: readFileSync(file),
  })
  assert.equal(res.status, 200)
  return res.json()
}

test('a wake word given as words wakes him under the name made from them', { skip }, async () => {
  const out = await stt(clips.wake)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS', JSON.stringify(out))
  assert.match(out.wake.trailing, /^open spo/i)
  assert.equal((await stt(clips.other)).wake, null)
})
