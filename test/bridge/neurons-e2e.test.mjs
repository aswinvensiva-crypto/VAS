import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startBridge } from './helpers.mjs'

/**
 * Neurons through a real bridge (fake SDK, and the Start menu read from
 * test/fixtures/startapps.json rather than this machine's, so the same apps
 * exist wherever it runs): local answers, handing on to Claude, the
 * permission gate's questions, corrections and taught routines. Every app
 * question is answered "no", so nothing on this machine is ever opened or
 * closed by the test.
 */
const WebSocket = createRequire(import.meta.url)('ws')
const windows = process.platform === 'win32'

let bridge
let ws
let seq = 0
/** Answers for the gate's questions, in order; each records the prompt it got. */
const answers = []
const prompts = []
/** When set, the scripted face leaves the next question unanswered. */
let holdNext = false
const held = []

before(async () => {
  bridge = await startBridge({
    env: { JARVIS_STARTAPPS_FIXTURE: fileURLToPath(new URL('../fixtures/startapps.json', import.meta.url)) },
  })
  ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type === 'confirm') {
      prompts.push(m.prompt)
      if (holdNext) {
        holdNext = false
        held.push(m.id)
        return
      }
      const a = answers.shift() ?? 'no'
      ws.send(JSON.stringify({ type: 'reply', id: m.id, text: a, source: 'voice' }))
    }
  })
})
after(async () => {
  ws?.close()
  await bridge?.stop()
})

/** Ask one question; resolves with the turn's text, done frame and whether Claude saw it. */
function ask(text) {
  const id = `t${++seq}`
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
    ws.send(JSON.stringify({ type: 'ask', text, id }))
  })
}

test('a matching order is answered locally, instantly, without Claude', async () => {
  const t0 = Date.now()
  const r = await ask('Hey Jarvis, what time is it?')
  assert.equal(r.claude, false)
  assert.equal(r.done.local, 'time')
  assert.match(r.said, /^It's /)
  assert.ok(Date.now() - t0 < 1000, 'local answers should be immediate')
})

test('anything else goes to Claude, told what was handled locally meanwhile', async () => {
  const r = await ask('tell me a joke')
  assert.equal(r.claude, true)
  assert.match(r.said, /\[Handled on this PC without you: "Hey Jarvis, what time is it\?" → It's /)
  assert.match(r.said, /tell me a joke$/)
  const again = await ask('another one')
  assert.equal(again.said, 'echo: another one', 'the note is delivered once')
})

test('"go to sleep" stands him down', async () => {
  const r = await ask('go to sleep')
  assert.equal(r.done.after, 'dormant')
})

test('opening an app asks first, and a no leaves it closed', { skip: !windows && 'Windows Start menu' }, async () => {
  answers.push('no')
  const r = await ask('open spotify')
  assert.equal(r.claude, false)
  assert.match(prompts.at(-1), /Spotify/)
  assert.match(r.said, /won't/i)
})

test('closing an app always asks', { skip: !windows && 'Windows Start menu' }, async () => {
  answers.push('no')
  const r = await ask('close whatsapp')
  assert.match(prompts.at(-1), /Close WhatsApp\?/)
  assert.match(r.said, /won't/i)
})

test('an unknown app is Claude\'s problem', { skip: !windows && 'Windows Start menu' }, async () => {
  const r = await ask('open the pod bay doors')
  assert.equal(r.claude, true)
})

test('a correction is learned, saved, and the command redone as meant', { skip: !windows && 'Windows Start menu' }, async () => {
  answers.push('no') // "open spot if i" -> some app?  no
  await ask('open spot if i')
  answers.push('yes', 'no') // save the correction: yes; then open Spotify: no
  const r = await ask('no, I said open Spotify')
  assert.ok(prompts.some((p) => /when I hear "spot if i", you mean "spotify"/i.test(p)), prompts.join(' | '))
  assert.match(prompts.at(-1), /Spotify/)
  assert.match(r.said, /won't/i)
  const saved = JSON.parse(readFileSync(join(bridge.dataDir, 'corrections.json'), 'utf8'))
  const entries = Array.isArray(saved) ? saved : saved.entries ?? saved.corrections ?? []
  assert.ok(entries.some((e) => e.heard === 'spot if i' && /spotify/i.test(e.meant)), JSON.stringify(saved))
})

test('a routine taught by voice is saved and then runs locally', { skip: !windows && 'Windows Start menu' }, async () => {
  answers.push('yes') // save the routine
  const taught = await ask('when I say focus time, open notepad and calculator')
  assert.match(prompts.at(-1), /When you say "focus time", I'll open notepad and open calculator\. Save that\?/i)
  assert.match(taught.said, /Saved/)
  assert.ok(existsSync(join(bridge.dataDir, 'brain.yml')))
  answers.push('no') // the routine's first step asks to open Notepad: no
  const r = await ask('focus time')
  assert.equal(r.claude, false)
  assert.match(prompts.at(-1), /Notepad/)
  const listed = await ask('list my routines')
  assert.match(listed.said, /focus time/)
})

test('"forget the routine …" asks, then the routine is gone', { skip: !windows && 'Windows Start menu' }, async () => {
  answers.push('yes') // forget it
  const r = await ask('forget the routine focus time')
  assert.equal(r.claude, false)
  assert.match(prompts.at(-1), /^Forget the routine "focus time"\?$/)
  assert.match(r.said, /Forgotten/)
  assert.doesNotMatch(readFileSync(join(bridge.dataDir, 'brain.yml'), 'utf8'), /focus time/)
  const after = await ask('focus time')
  assert.equal(after.claude, true, 'with the routine gone, the words are Claude\'s again')
})

test('an interrupt withdraws an open question', { skip: !windows && 'Windows Start menu' }, async () => {
  holdNext = true
  const cancelled = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20_000)
    const on = (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type !== 'confirm_cancel') return
      clearTimeout(timer)
      ws.off('message', on)
      resolve(m.id)
    }
    ws.on('message', on)
  })
  ws.send(JSON.stringify({ type: 'ask', text: 'close notepad', id: `t${++seq}` }))
  // Wait until the question is actually open, then stand down.
  for (let i = 0; i < 100 && !held.length; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(held.length, 1, 'a question was asked and left open')
  ws.send(JSON.stringify({ type: 'interrupt' }))
  assert.equal(await cancelled, held[0])
})
