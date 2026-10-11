import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let store
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-store-'))
  process.env.JARVIS_DATA_DIR = dir
  store = {
    ...(await import('../../bridge/store/config.mjs')),
    ...(await import('../../bridge/store/files.mjs')),
    ...(await import('../../bridge/store/audit.mjs')),
  }
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('a missing config is a full set of defaults', async () => {
  const cfg = await store.loadConfig()
  assert.equal(cfg.hotkey, 'Control+Alt+Space')
  assert.equal(cfg.stt.engine, 'auto')
  assert.equal(cfg.stt.model, 'whisper-base')
  assert.equal(cfg.owner.require, 'all')
  assert.equal(cfg.wake.keywords[0].name, 'HEY_JARVIS')
  assert.ok(cfg.userName.length > 0)
})

test('a partial config keeps what was written and defaults the rest', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ userName: 'Aswin', stt: { model: 'whisper-small' } }))
  const cfg = await store.loadConfig()
  assert.equal(cfg.userName, 'Aswin')
  assert.equal(cfg.stt.model, 'whisper-small')
  assert.equal(cfg.stt.language, 'en')
})

test('a broken config falls back to defaults instead of crashing', async () => {
  writeFileSync(join(dir, 'config.json'), '{ not json')
  const cfg = await store.loadConfig()
  assert.equal(cfg.hotkey, 'Control+Alt+Space')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ stt: { engine: 'telepathy' } }))
  assert.equal((await store.loadConfig()).stt.engine, 'auto')
})

test('saveConfig round-trips and writes atomically', async () => {
  await store.saveConfig({ userName: 'Aswin', hotkey: 'Control+Alt+J' })
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(raw.hotkey, 'Control+Alt+J')
  assert.equal((await store.loadConfig()).hotkey, 'Control+Alt+J')
})

test('the audit log records actions but not what was typed', async () => {
  await store.audit({ kind: 'tool', name: 'chrome_type', args: { text: 'my secret message', tabId: 7 }, ok: true })
  const line = JSON.parse(readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n').pop())
  assert.equal(line.name, 'chrome_type')
  assert.deepEqual(line.args.text, { length: 17 })
  assert.equal(line.args.tabId, 7)
  assert.ok(!JSON.stringify(line).includes('secret'))
})
