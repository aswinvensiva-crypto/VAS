import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let gateMod
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-gate-'))
  process.env.JARVIS_DATA_DIR = dir
  gateMod = await import('../../bridge/gate.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of ['permissions.json', 'apps.json']) rmSync(join(dir, f), { force: true })
})

/** A fake face: answers each confirm question from a script, recording the prompts. */
function face(...answers) {
  const asked = []
  const log = []
  return {
    asked,
    log,
    ask: async (kind, args) => {
      asked.push({ kind, ...args })
      const a = answers.shift()
      if (a instanceof Error) throw a
      return typeof a === 'string' ? { text: a, source: 'voice' } : a
    },
    audit: (e) => log.push(e),
  }
}

test('parseConfirm: deny words win, accept needs a clear yes', () => {
  const { parseConfirm } = gateMod
  for (const s of ['yes', 'Yes please', 'yeah do it', 'confirm', 'okay', 'go ahead', 'I confirm']) assert.equal(parseConfirm(s), 'yes', s)
  for (const s of ['no', 'cancel', 'yes — no wait', "don't", 'never mind', 'stop']) assert.equal(parseConfirm(s), 'no', s)
  for (const s of ['', 'maybe', 'what time is it', 'Shall I close Spotify?']) assert.equal(parseConfirm(s), 'unclear', s)
})

test('free actions run without asking', async () => {
  const f = face()
  const gate = gateMod.createGate(f)
  assert.deepEqual(await gate.check('chrome.read', { prompt: 'x' }), { allowed: true })
  assert.equal(f.asked.length, 0)
  assert.equal(f.log[0].decision, 'allow')
})

test('remember: asks once per app, then remembers the yes', async () => {
  const f = face('yes')
  const gate = gateMod.createGate(f)
  const r1 = await gate.check('app.open', { subject: 'Spotify!App', subjectName: 'Spotify', prompt: 'Open Spotify?' })
  assert.equal(r1.allowed, true)
  assert.equal(f.asked.length, 1)
  assert.equal(f.asked[0].prompt, 'Open Spotify?')
  const r2 = await gate.check('app.open', { subject: 'Spotify!App', prompt: 'Open Spotify?' })
  assert.equal(r2.allowed, true)
  assert.equal(f.asked.length, 1, 'second open must not ask')
  assert.ok(JSON.parse(readFileSync(join(dir, 'apps.json'), 'utf8')).allow['Spotify!App'])
})

test('remember: a no is not remembered', async () => {
  const f = face('no', 'yes')
  const gate = gateMod.createGate(f)
  assert.equal((await gate.check('app.open', { subject: 'X', prompt: 'Open X?' })).allowed, false)
  assert.equal((await gate.check('app.open', { subject: 'X', prompt: 'Open X?' })).allowed, true)
  assert.equal(f.asked.length, 2)
})

test('confirm: asks every time; unclear is asked once more; silence is a no', async () => {
  const f = face('yes', 'yes', 'hmm', 'yes', new Error('timeout'))
  const gate = gateMod.createGate(f)
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, true)
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, true)
  const third = await gate.check('app.close', { prompt: 'Close it?' })
  assert.equal(third.allowed, true)
  assert.match(f.asked[3].prompt, /Yes or no/)
  const fourth = await gate.check('app.close', { prompt: 'Close it?' })
  assert.equal(fourth.allowed, false)
  assert.match(fourth.reason, /No answer/)
})

test('clicks count unless switched off; deny tier and lockdown never ask', async () => {
  const f = face({ source: 'click', approved: true })
  const gate = gateMod.createGate(f)
  assert.equal((await gate.check('chrome.act', { prompt: 'Click?' })).allowed, true)

  writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ tiers: { 'chrome.act': 'deny' } }))
  assert.equal((await gate.check('chrome.act', { prompt: 'Click?' })).allowed, false)

  writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ lockdown: true }))
  const locked = await gate.check('chrome.read', { prompt: 'x' })
  assert.equal(locked.allowed, false)
  assert.match(locked.reason, /locked down/)
  assert.equal(f.asked.length, 1)
})

test('only the owner\'s spoken yes counts once a voice is enrolled', async () => {
  const f = face({ text: 'yes', source: 'voice', owner: 'other' }, { text: 'yes', source: 'voice', owner: 'owner' })
  const gate = gateMod.createGate({ ...f, owner: () => ({ verdict: 'owner' }) })
  const stranger = await gate.check('app.close', { prompt: 'Close it?' })
  assert.equal(stranger.allowed, false)
  assert.match(stranger.reason, /Only your voice/)
  assert.equal((await gate.check('app.close', { prompt: 'Close it?' })).allowed, true)
})

test('questions are asked one at a time', async () => {
  let open = 0
  let maxOpen = 0
  const gate = gateMod.createGate({
    ask: async () => {
      open++
      maxOpen = Math.max(maxOpen, open)
      await new Promise((r) => setTimeout(r, 20))
      open--
      return { text: 'yes', source: 'voice' }
    },
    audit: () => {},
  })
  await Promise.all([1, 2, 3].map(() => gate.check('app.close', { prompt: 'Close?' })))
  assert.equal(maxOpen, 1)
})
