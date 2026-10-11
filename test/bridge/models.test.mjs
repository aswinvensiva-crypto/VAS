import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from './helpers.mjs'

/**
 * A fresh install: no voice models. The bridge must say so (for the face's
 * Download button), report the size, and still run — without downloading
 * anything by itself. (The download itself is not exercised: it is a few
 * hundred megabytes.)
 */
let bridge
let empty
before(async () => {
  empty = mkdtempSync(join(tmpdir(), 'vas-nomodels-'))
  bridge = await startBridge({ env: { JARVIS_MODELS_DIR: empty } })
})
after(async () => {
  await bridge?.stop()
  rmSync(empty, { recursive: true, force: true })
})

const get = async (path) =>
  (await fetch(`http://127.0.0.1:${bridge.port}${path}`, { headers: { 'x-vas-token': bridge.token } })).json()

test('with no models the bridge says what is missing and how big it is', async () => {
  const s = await get('/models/status')
  assert.deepEqual(s.missing, ['kws', 'whisper-base', 'speaker'])
  assert.ok(s.bytes > 200 * 1024 * 1024 && s.bytes < 400 * 1024 * 1024, String(s.bytes))
  assert.equal(s.running, false)
})

test('health reports no hearing yet, and nothing starts downloading on its own', async () => {
  const h = await get('/health')
  assert.equal(h.stt, false)
  assert.equal(h.kws, false)
  assert.ok(h.modelsMissing.includes('whisper-base'))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal((await get('/models/status')).running, false)
})
