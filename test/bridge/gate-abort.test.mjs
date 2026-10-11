import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Standing JARVIS down (Escape, barge-in, "go to sleep", a disconnect) must
 * withdraw every question: the one on screen, and the ones still queued behind
 * it. A queued "Close Spotify?" that pops up after the user said stop would be
 * the gate acting on an order the user already took back.
 */
let dir
let gateMod
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-gate-abort-'))
  process.env.JARVIS_DATA_DIR = dir
  gateMod = await import('../../bridge/gate.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

test('an interrupt withdraws the question on screen and every one queued behind it', async () => {
  const asked = []
  const log = []
  let onScreen = null
  const gate = gateMod.createGate({
    ask: (_kind, args) => {
      asked.push(args.prompt)
      // The first question waits on the user; anything after it is answered "yes".
      if (asked.length === 1) return new Promise((resolve) => (onScreen = resolve))
      return Promise.resolve({ text: 'yes', source: 'voice' })
    },
    cancel: () => onScreen?.({ cancelled: true }),
    audit: (entry) => log.push(entry),
  })

  const first = gate.check('app.close', { subject: 'A', prompt: 'Close A?' })
  const second = gate.check('app.close', { subject: 'B', prompt: 'Close B?' })
  const third = gate.check('chrome.act', { prompt: 'Click "Send" on mail.google.com?' })
  await tick()
  assert.deepEqual(asked, ['Close A?'], 'one question at a time')

  gate.abortAll()
  const results = await Promise.all([first, second, third])
  assert.deepEqual(results.map((r) => r.allowed), [false, false, false])
  assert.ok(results.every((r) => r.reason === 'Cancelled.'), JSON.stringify(results))
  await tick()
  assert.deepEqual(asked, ['Close A?'], 'queued questions must never reach the face after an interrupt')

  const denies = log.filter((e) => e.decision === 'deny')
  assert.equal(denies.length, 3)
  for (const e of denies) {
    assert.equal(e.kind, 'gate')
    assert.equal(e.tier, 'confirm')
    assert.equal(e.reason, 'cancelled')
  }

  // The gate is not left wedged: the next question is asked and answered.
  const next = await gate.check('app.close', { subject: 'D', prompt: 'Close D?' })
  assert.equal(next.allowed, true)
  assert.deepEqual(asked, ['Close A?', 'Close D?'])
  const allow = log.at(-1)
  assert.equal(allow.decision, 'allow')
  assert.equal(allow.name, 'app.close')
  assert.equal(allow.source, 'voice')
  assert.deepEqual(allow.owner, { verdict: 'unenrolled' })
  assert.deepEqual(allow.args, { subject: 'D' })
})
