import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBridge } from './helpers.mjs'

/**
 * The face-to-bridge protocol for what was heard, through a real bridge (fake
 * SDK): an ask's raw words reach the neurons, an ask spoken only in someone
 * else's voice is dropped, and a spoken "yes" is judged on its raw words and on
 * the bridge's own record of whose voice it was.
 *
 * A voice is "enrolled" by writing a voiceprint into the data folder, and the
 * bridge's utterance store is preloaded with known segments (see
 * fixtures/seed-utterances.mjs) — real verdicts would need the voice models
 * and two real people. Nothing here opens an app: every action asked about is
 * saving a correction.
 */
const WebSocket = createRequire(import.meta.url)('ws')
const SEED = fileURLToPath(new URL('../fixtures/seed-utterances.mjs', import.meta.url))

const SEGMENTS = {
  'me-1': { owner: { verdict: 'owner', score: 0.71 }, raw: 'what tim is it', text: 'what time is it' },
  'me-2': { owner: { verdict: 'owner', score: 0.66 }, raw: 'yes', text: 'yes' },
  'tv-1': { owner: { verdict: 'other', score: 0.08 }, raw: 'what time is it', text: 'what time is it' },
  'tv-2': { owner: { verdict: 'other', score: 0.11 }, raw: 'right now', text: 'right now' },
  'tv-3': { owner: { verdict: 'other', score: 0.05 }, raw: 'yes', text: 'yes' },
}

let dir
let bridge
let ws
let seq = 0
/** Replies for the gate's questions, in order; each records the prompt it got. */
const replies = []
const prompts = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-heard-'))
  mkdirSync(join(dir, 'data'))
  writeFileSync(
    join(dir, 'data', 'speaker.json'),
    JSON.stringify({
      version: 1,
      model: 'test',
      dim: 3,
      centroid: [1, 0, 0],
      thresholds: { short: 0.5, long: 0.5 },
      clips: 7,
      enrolledAt: new Date().toISOString(),
    }),
  )
  bridge = await startBridge({
    env: {
      JARVIS_DATA_DIR: join(dir, 'data'),
      JARVIS_TEST_UTTERANCES: JSON.stringify(SEGMENTS),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(SEED).href}`.trim(),
    },
  })
  ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'confirm') return
    prompts.push(m.prompt)
    const reply = replies.shift() ?? { text: 'no', raw: 'no' }
    ws.send(JSON.stringify({ type: 'reply', id: m.id, source: 'voice', ...reply }))
  })
})
after(async () => {
  ws?.close()
  await bridge?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** Ask one question; resolves with its text, its done frame and whether Claude saw it. */
function ask(text, heard = {}) {
  const id = `h${++seq}`
  return new Promise((resolve, reject) => {
    let said = ''
    const timer = setTimeout(() => reject(new Error(`no answer to "${text}"`)), 30_000)
    const on = (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.ask !== id) return
      if (m.type === 'text') said += m.delta
      if (m.type === 'done' || m.type === 'error') {
        clearTimeout(timer)
        ws.off('message', on)
        resolve({ said: said.trim(), done: m, claude: said.startsWith('echo: ') })
      }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ type: 'ask', text, id, ...heard }))
  })
}

const auditLog = () => {
  const path = join(dir, 'data', 'audit.log')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
}
const savedCorrections = () => {
  const path = join(dir, 'data', 'corrections.json')
  if (!existsSync(path)) return []
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(saved) ? saved : (saved.entries ?? saved.corrections ?? [])
}
/** The audit log is written in the background; give it a moment. */
const settle = () => new Promise((r) => setTimeout(r, 300))

test('an ask spoken only in someone else\'s voice is dropped, and logged', async () => {
  const r = await ask('what time is it right now', { raw: 'what time is it right now', utts: ['tv-1', 'tv-2'] })
  assert.equal(r.done.ignored, 'other-voice')
  assert.equal(r.done.text, '')
  assert.equal(r.said, '', 'nothing is said back')
  await settle()
  assert.ok(auditLog().some((e) => e.kind === 'ask' && e.reason === 'other-voice'), JSON.stringify(auditLog()))
  // Not run locally, and never handed to Claude: the next Claude turn is told
  // of no local turn in between.
  const next = await ask('tell me a joke')
  assert.equal(next.said, 'echo: tell me a joke')
})

test('one segment in the owner\'s voice is enough for the ask to be answered', async () => {
  const r = await ask('what time is it', { raw: 'what time is it', utts: ['me-1', 'tv-1'] })
  assert.equal(r.done.ignored, undefined)
  assert.equal(r.done.local, 'time')
})

test('the raw words reach the neurons: a correction is learned from them', async () => {
  // Routed on the corrected text, remembered with the raw transcript.
  const first = await ask('what time is it', { raw: 'what tim is it', utts: ['me-1'] })
  assert.equal(first.done.local, 'time')
  // The spoken reply's corrected text says yes; its raw words say no.
  replies.push({ text: 'yes', raw: 'nah', utts: ['me-2'] })
  const r = await ask('no, I said what time is it')
  assert.match(prompts.at(-1), /when I hear "what tim", you mean "what time"/)
  assert.equal(r.done.local, 'correction')
  assert.equal(savedCorrections().length, 0, 'judged on the raw "nah", so nothing was saved')
})

test('a spoken yes is judged on its raw words and its own segments\' voice', async () => {
  await ask('what time is it', { raw: 'what tim is it', utts: ['me-1'] })
  // The corrected text says no; the raw words — what was said — say yes, in
  // the owner's voice by the bridge's own record.
  replies.push({ text: 'no', raw: 'yes', utts: ['me-2'] })
  await ask('no, I said what time is it')
  assert.ok(savedCorrections().some((e) => e.heard === 'what tim' && e.meant === 'what time'), JSON.stringify(savedCorrections()))
})

test('a yes in someone else\'s voice does not count, whatever the face claims', async () => {
  await ask('what time is it', { raw: 'what dime is it', utts: ['me-1'] })
  replies.push({ text: 'yes', raw: 'yes', utts: ['tv-3'], owner: 'owner' })
  await ask('no, I said what time is it')
  assert.match(prompts.at(-1), /when I hear "what dime"/)
  assert.equal(savedCorrections().some((e) => e.heard === 'what dime'), false)
  await settle()
  const refused = auditLog().filter((e) => e.kind === 'gate' && e.name === 'correction.save').at(-1)
  assert.equal(refused?.reason, 'not-owner', JSON.stringify(refused))
  assert.equal(refused?.owner?.verdict, 'other')
})
