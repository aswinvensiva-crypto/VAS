import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startBridge, synthesize } from './helpers.mjs'
import { status } from '../../bridge/voice/models.mjs'

/**
 * The whole listening path through a real bridge: WAV in over HTTP, local
 * keyword spotting and Whisper, words out. Uses speech synthesised by a
 * Windows voice, so it runs wherever the models are installed and SAPI exists,
 * and skips cleanly anywhere else.
 */
const models = await status()
const clips =
  models.kws && models['whisper-base']
    ? synthesize({
        wake_cmd: 'Hey Jarvis, open Spotify.',
        wake_only: 'Hey Jarvis.',
        near_miss: 'The service was slow, so Travis went home early.',
        command: 'Search Chrome for the weather tomorrow.',
      })
    : null
const skip = clips ? false : 'needs the voice models (npm run models) and Windows speech synthesis'

let bridge
before(async () => {
  if (!skip) bridge = await startBridge()
})
after(async () => {
  await bridge?.stop()
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

test('health reports local hearing and the on-device wake word', { skip }, async () => {
  const h = await (await fetch(`http://127.0.0.1:${bridge.port}/health`, { headers: { 'x-vas-token': bridge.token } })).json()
  assert.equal(h.stt, true)
  assert.equal(h.kws, true)
  assert.match(h.sttEngine, /^whisper-|^scribe$/)
})

test('"Hey Jarvis, open Spotify" wakes him and hands over the command', { skip }, async () => {
  const out = await stt('wake', clips.wake_cmd)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS')
  assert.match(out.wake.trailing, /^open spo/i)
  assert.equal(out.text, out.wake.trailing)
})

test('"Hey Jarvis" alone wakes him with nothing to do yet', { skip }, async () => {
  const out = await stt('wake', clips.wake_only)
  assert.equal(out.wake?.keyword, 'HEY_JARVIS')
  assert.equal(out.wake.trailing, '')
})

test('a near miss while dormant is neither a wake nor transcribed', { skip }, async () => {
  const out = await stt('wake', clips.near_miss)
  assert.equal(out.wake, null)
  assert.equal(out.text, '')
})

test('in command mode everything is transcribed', { skip }, async () => {
  const out = await stt('command', clips.command)
  assert.match(out.text, /weather/i)
  assert.equal(out.wake, undefined)
})

test('anything but 16 kHz WAV is refused clearly', { skip }, async () => {
  const wav = readFileSync(clips.command)
  const wrongRate = Buffer.from(wav)
  wrongRate.writeUInt32LE(44100, 24)
  const res = await fetch(`http://127.0.0.1:${bridge.port}/stt?mode=command`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav', 'x-vas-token': bridge.token },
    body: wrongRate,
  })
  assert.equal(res.status, 415)
})
