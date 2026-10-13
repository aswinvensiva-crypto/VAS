import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One owner setting: config.json's owner.require, changed in place without
 * losing what else the user wrote, carried over once from the old
 * permissions.json requireOwner, and read by the gate on every question.
 */
let dir
let config
let gateMod
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-owner-'))
  process.env.JARVIS_DATA_DIR = dir
  config = await import('../../bridge/store/config.mjs')
  gateMod = await import('../../bridge/gate.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of ['config.json', 'permissions.json', 'apps.json']) rmSync(join(dir, f), { force: true })
})

const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value))

test('updateConfig writes only what changed, never the defaults', async () => {
  write('config.json', { userName: 'Aswin', stt: { language: 'auto' } })
  const cfg = await config.updateConfig({ owner: { require: 'actions' }, stt: { engine: 'local' } })
  assert.equal(cfg.owner.require, 'actions')
  assert.equal(cfg.stt.language, 'auto', 'a sibling setting is kept')
  assert.deepEqual(read('config.json'), { userName: 'Aswin', stt: { language: 'auto', engine: 'local' }, owner: { require: 'actions' } })
})

test('a null puts a setting back to its default', async () => {
  write('config.json', { tts: { voice: 'Microsoft Ryan' }, owner: { require: 'off' } })
  const cfg = await config.updateConfig({ tts: { voice: null }, owner: null })
  assert.equal(cfg.tts.voice, undefined)
  assert.equal(cfg.owner.require, 'all')
  assert.deepEqual(read('config.json'), { tts: {} })
})

test('an invalid change throws and leaves the file as it was', async () => {
  write('config.json', { userName: 'Aswin' })
  await assert.rejects(config.updateConfig({ owner: { require: 'everyone' } }))
  await assert.rejects(config.updateConfig({ userName: '' }))
  assert.deepEqual(read('config.json'), { userName: 'Aswin' })
})

test('a config.json that does not parse is never saved over', async () => {
  writeFileSync(join(dir, 'config.json'), '{ "userName": "Asw')
  await assert.rejects(config.updateConfig({ userName: 'Aswin' }), /not valid JSON/)
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{ "userName": "Asw')
})

test('an old requireOwner "all" moves to config.json once, and leaves permissions.json', async () => {
  write('permissions.json', { version: 1, requireOwner: 'all', lockdown: true, tiers: { 'app.close': 'deny' } })
  write('config.json', { userName: 'Aswin' })
  await config.migrateOwnerRequirement()
  assert.deepEqual(read('config.json'), { userName: 'Aswin', owner: { require: 'all' } })
  assert.deepEqual(read('permissions.json'), { version: 1, lockdown: true, tiers: { 'app.close': 'deny' } })
  // A second start finds nothing left to move.
  await config.migrateOwnerRequirement()
  assert.equal((await config.loadConfig()).owner.require, 'all')
})

test('an old requireOwner "off" is dropped, not widened into "hear anyone"', async () => {
  // It only ever relaxed whose yes counted; config's 'off' would also stop
  // ignoring other voices altogether.
  write('permissions.json', { requireOwner: 'off', lockdown: false })
  write('config.json', { userName: 'Aswin' })
  await config.migrateOwnerRequirement()
  assert.deepEqual(read('config.json'), { userName: 'Aswin' })
  assert.deepEqual(read('permissions.json'), { lockdown: false })
  assert.equal((await config.loadConfig()).owner.require, 'all')
})

test('a config.json that fails its schema does not stop the bridge starting', async () => {
  write('permissions.json', { requireOwner: 'all' })
  write('config.json', { stt: { engine: 'whisper' } })
  await config.migrateOwnerRequirement()
  // Nothing was half-done: the old value waits for a config.json that loads.
  assert.deepEqual(read('permissions.json'), { requireOwner: 'all' })
  assert.deepEqual(read('config.json'), { stt: { engine: 'whisper' } })
})

test('the old default "actions" is dropped, not carried over', async () => {
  write('permissions.json', { requireOwner: 'actions', lockdown: false })
  await config.migrateOwnerRequirement()
  assert.equal(existsSync(join(dir, 'config.json')), false)
  assert.deepEqual(read('permissions.json'), { lockdown: false })
  assert.equal((await config.loadConfig()).owner.require, 'all')
})

test('a value already in config.json wins over the old one', async () => {
  write('permissions.json', { requireOwner: 'off' })
  write('config.json', { owner: { require: 'actions' } })
  await config.migrateOwnerRequirement()
  assert.equal((await config.loadConfig()).owner.require, 'actions')
  assert.deepEqual(read('permissions.json'), {})
})

test('nothing to migrate leaves every file alone', async () => {
  await config.migrateOwnerRequirement()
  assert.equal(existsSync(join(dir, 'permissions.json')), false)
  assert.equal(existsSync(join(dir, 'config.json')), false)
})

/** A face that always answers yes in someone else's voice. */
function stranger() {
  const log = []
  return {
    log,
    ask: async () => ({ text: 'yes', source: 'voice', owner: 'other' }),
    audit: (e) => log.push(e),
    owner: () => ({ verdict: 'other', ownerRecently: false }),
  }
}

test('the gate wants the owner by default, and not when the setting is off', async () => {
  const strict = gateMod.createGate(stranger())
  const refused = await strict.check('app.close', { prompt: 'Close it?' })
  assert.equal(refused.allowed, false)
  assert.match(refused.reason, /Only your voice/)

  let setting = 'all'
  const f = stranger()
  const gate = gateMod.createGate({ ...f, requireOwner: () => setting })
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, false)
  setting = 'actions'
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, false)
  // Changed while the gate is alive: the next question already uses it.
  setting = 'off'
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, true)
  assert.equal(f.log.at(-1).decision, 'allow')
})

test('a requireOwner left in permissions.json no longer decides anything', async () => {
  write('permissions.json', { requireOwner: 'off' })
  const gate = gateMod.createGate({ ...stranger(), requireOwner: () => 'all' })
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, false)
  assert.equal('requireOwner' in (await gateMod.loadPermissions()), false)
})

test('a safeguard set to "free" by hand in permissions.json still asks', async () => {
  write('permissions.json', { tiers: { 'jarvis.unlock': 'free', 'settings.weaken': 'remember', 'app.close': 'free' } })
  const asked = []
  const gate = gateMod.createGate({
    ask: async (_kind, args) => {
      asked.push(args.prompt)
      return { text: 'no', source: 'voice' }
    },
    audit: () => {},
  })
  assert.equal((await gate.check('jarvis.unlock', { prompt: 'Lift the lockdown?' })).allowed, false)
  assert.equal((await gate.check('settings.weaken', { prompt: 'Loosen it?' })).allowed, false)
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, true, 'an ordinary action follows its tier')
  assert.deepEqual(asked, ['Lift the lockdown?', 'Loosen it?'])
})
