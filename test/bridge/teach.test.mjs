import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

/**
 * Teaching routines: where the trigger ends, what a step may be, which
 * phrases are kept off limits, the question when the words could be read two
 * ways, forgetting, and Claude's teach_routine tool. Runs against the real
 * brain and permission gate in a scratch data folder, with a scripted face
 * answering the questions. Nothing here opens anything: a routine is only
 * saved, never run.
 */

let dir
let route
let runSynapse
let registry
let createBrain
let createGate
let neuronTools
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-teach-'))
  process.env.JARVIS_DATA_DIR = dir
  ;({ route } = await import('../../bridge/neurons/router.mjs'))
  ;({ runSynapse } = await import('../../bridge/neurons/run.mjs'))
  ;({ registry } = await import('../../bridge/neurons/registry.mjs'))
  ;({ createBrain } = await import('../../bridge/neurons/brain.mjs'))
  ;({ createGate } = await import('../../bridge/gate.mjs'))
  ;({ neuronTools } = await import('../../bridge/neurons/mcp.mjs'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

const userFile = () => join(dir, 'brain.yml')
const saved = () => (existsSync(userFile()) ? YAML.parse(readFileSync(userFile(), 'utf8')).synapses : [])

let brain
beforeEach(() => {
  for (const f of ['brain.yml', 'permissions.json', 'audit.log']) rmSync(join(dir, f), { force: true })
})
afterEach(() => brain?.close())

/**
 * A neuron context with the real brain and gate. `answers` reply to the
 * gate's yes-or-no questions; `pick` answers a "which one?" question.
 */
function harness({ answers = [], pick = () => null, raw } = {}) {
  brain?.close()
  brain = createBrain({ known: new Set(registry.keys()), onError: () => {} })
  const prompts = []
  const questions = []
  const audits = []
  const gate = createGate({
    ask: async (_kind, args) => {
      prompts.push(args.prompt)
      return { text: answers.shift() ?? 'no', source: 'voice' }
    },
    audit: (e) => audits.push(e),
  })
  const ctx = {
    brain,
    gate,
    raw,
    audit: (e) => audits.push(e),
    choose: async (question, options) => {
      questions.push({ question, options })
      return pick(options)
    },
  }
  return { ctx, prompts, questions, audits }
}

/** Say `text` the way the bridge would: routed through the brain, then run. */
async function say(text, h) {
  const hit = route(text, h.ctx.brain)
  assert.ok(hit, `"${text}" should match an order`)
  return runSynapse(hit, h.ctx, registry)
}

/** Teach from what was said, commas and all, as the face hands it over. */
const teachAsSaid = (text, options = {}) => {
  const h = harness({ ...options, raw: text })
  return say(text, h).then((r) => ({ ...h, r }))
}

const steps = (synapse) => synapse.neurons.map((n) => Object.entries(n)[0])

test('the first comma, as said, ends the trigger, and the others separate the steps', async () => {
  const { r, prompts, questions } = await teachAsSaid('Hey Jarvis, when I say music time, open Spotify, open Chrome.', {
    answers: ['yes'],
  })
  assert.equal(questions.length, 0, 'the comma made it clear; nothing to ask')
  assert.deepEqual(prompts, ['When you say "music time", I\'ll open Spotify and open Chrome. Save that?'])
  assert.equal(r.say, 'Saved. Say "music time" any time.')
  const [routine] = saved()
  assert.equal(routine.name, 'routine-music-time')
  assert.equal(routine.source, 'taught')
  assert.deepEqual(routine.signals, [{ order: { text: 'music time', 'matching-type': 'ordered-strict' } }])
  assert.deepEqual(steps(routine), [['open_app', { app: 'Spotify' }], ['open_app', { app: 'Chrome' }]])
  assert.equal(route('music time', brain).synapse.name, 'routine-music-time', 'it answers at once')
})

test('without the comma, every split point is tried and a single reading is taken', async () => {
  const h = harness({ answers: ['yes'] })
  const r = await say('when I say focus time, open notepad and calculator', h)
  assert.equal(h.questions.length, 0)
  assert.deepEqual(h.prompts, ['When you say "focus time", I\'ll open notepad and open calculator. Save that?'])
  assert.match(r.say, /Saved/)
  assert.deepEqual(steps(saved()[0]), [['open_app', { app: 'notepad' }], ['open_app', { app: 'calculator' }]])
})

test('two readings that both work are put to the user, who picks the trigger', async () => {
  const h = harness({ answers: ['yes'], pick: (options) => options[1] })
  await say('when I say music time open Spotify open Chrome', h)
  assert.equal(h.questions.length, 1)
  assert.deepEqual(h.questions[0].options, ['music time', 'music time open Spotify'])
  assert.equal(h.questions[0].question, 'Which words should start the routine — "music time" or "music time open Spotify"?')
  assert.deepEqual(h.prompts, ['When you say "music time open Spotify", I\'ll open Chrome. Save that?'])
  assert.deepEqual(steps(saved()[0]), [['open_app', { app: 'Chrome' }]])
})

test('no answer to that question saves nothing', async () => {
  const h = harness({ answers: ['yes'] })
  const r = await say('when I say music time open Spotify open Chrome', h)
  assert.equal(h.questions.length, 1)
  assert.match(r.say, /leave it/)
  assert.deepEqual(h.prompts, [])
  assert.equal(existsSync(userFile()), false)
})

test('a spoken line can be a step, "and" and all', async () => {
  const { r, prompts } = await teachAsSaid('when I say good morning, say rise and shine, then open Spotify', {
    answers: ['yes'],
  })
  assert.deepEqual(prompts, ['When you say "good morning", I\'ll say rise and shine and open Spotify. Save that?'])
  assert.match(r.say, /Saved/)
  assert.deepEqual(steps(saved()[0]), [['say', { message: 'rise and shine' }], ['open_app', { app: 'Spotify' }]])
})

test('a trigger must be two words, and clear of wake, yes-or-no and stand-down words', async () => {
  const refused = [
    ['when I say go, open notepad', /at least two words/],
    ['when I say work mode jarvis, open notepad', /wake word/],
    ['when I say hey work mode, open notepad', /wake word/],
    ["when I say java's mode, open notepad", /wake word/],
    ['when I say okay computer, open notepad', /wake word/],
    ['when I say sure thing, open notepad', /yes or a no/],
    ['when I say no music, open notepad', /yes or a no/],
    ['when I say wait a second, open notepad', /yes or a no/],
    ['when I say lets go ahead, open notepad', /yes or a no/],
    ['when I say sleep mode, open notepad', /stand me down/],
    ['when I say mute the tv, open notepad', /stand me down/],
    ['when I say stand down now, open notepad', /stand me down/],
    ['when I say what time is it, open notepad', /already does something/],
  ]
  for (const [text, why] of refused) {
    const { r, prompts } = await teachAsSaid(text, { answers: ['yes'] })
    assert.match(r.say, why, text)
    assert.deepEqual(prompts, [], `${text}: nothing should be asked`)
  }
  assert.equal(existsSync(userFile()), false)
})

test('a step must be something a routine may do', async () => {
  writeFileSync(
    userFile(),
    YAML.stringify({
      version: 1,
      synapses: [
        {
          name: 'routine-focus-time',
          source: 'taught',
          signals: [{ order: { text: 'focus time', 'matching-type': 'ordered-strict' } }],
          neurons: [{ open_app: { app: 'notepad' } }],
        },
      ],
    }),
  )
  const before = readFileSync(userFile(), 'utf8')
  const refused = [
    ['when I say bed time now, go to sleep', /"go to sleep" can't be part of a routine/],
    ['when I say lock it all, lockdown', /"lockdown" can't be part of a routine/],
    ['when I say lesson one, when I say hello there, open notepad', /can't be part of a routine/],
    ['when I say fix that up, no I said open spotify', /can't be part of a routine/],
    ['when I say big mode, focus time, then open chrome', /can't run another routine/],
    ['when I say movie night, dim the lights', /I can't do "dim the lights"/],
    ['when I say movie night, dim the lights, then open netflix', /I can't do "dim the lights"/],
  ]
  for (const [text, why] of refused) {
    const { r, prompts } = await teachAsSaid(text, { answers: ['yes'] })
    assert.match(r.say, why, text)
    assert.deepEqual(prompts, [], `${text}: nothing should be asked`)
  }
  assert.equal(readFileSync(userFile(), 'utf8'), before)
})

test('without a comma, a refused step is still named', async () => {
  let h = harness({ answers: ['yes'] })
  let r = await say('when I say nap time now go to sleep', h)
  assert.match(r.say, /"go to sleep" can't be part of a routine/)
  h = harness({ answers: ['yes'] })
  r = await say('when I say movie night dim the lights', h)
  assert.match(r.say, /I can only build routines from things I can do directly/)
  assert.deepEqual(h.prompts, [])
})

test('a no to saving writes nothing', async () => {
  const { r, prompts } = await teachAsSaid('when I say music time, open Spotify', { answers: ['no'] })
  assert.equal(prompts.length, 1)
  assert.match(r.say, /won't/)
  assert.equal(existsSync(userFile()), false)
})

test('"forget the routine …" asks, and only a yes removes it', async () => {
  await teachAsSaid('when I say music time, open Spotify', { answers: ['yes'] })
  await teachAsSaid('when I say work mode, open VS Code', { answers: ['yes'] })
  assert.equal(saved().length, 2)

  let h = harness({ answers: ['no'] })
  let r = await say('forget the routine music time', h)
  assert.deepEqual(h.prompts, ['Forget the routine "music time"?'])
  assert.match(r.say, /won't/)
  assert.equal(saved().length, 2, 'a no keeps it')

  h = harness({ answers: ['yes'] })
  r = await say('forget the routine music time', h)
  assert.equal(r.say, 'Forgotten.')
  assert.deepEqual(saved().map((s) => s.name), ['routine-work-mode'])
  assert.equal(route('music time', brain), null, 'gone from the live brain too')
  assert.equal(route('work mode', brain).synapse.name, 'routine-work-mode')

  h = harness({ answers: ['yes'] })
  r = await say('delete the routine party time', h)
  assert.equal(r.say, 'I don\'t have a routine called "party time".')
  assert.deepEqual(h.prompts, [])
})

test('teach_routine: Claude\'s tool goes through the same checks and the same question', async () => {
  const call = async (args, options) => {
    const h = harness(options)
    const tool = neuronTools(() => h.ctx).find((t) => t.name === 'teach_routine')
    const result = await tool.handler(args, {})
    return { ...h, result, text: result.content[0].text }
  }

  const ok = await call({ trigger: 'Focus Mode', steps: ['open Notepad', 'say time to focus'] }, { answers: ['yes'] })
  assert.deepEqual(ok.prompts, ['When you say "Focus Mode", I\'ll open Notepad and say time to focus. Save that?'])
  assert.equal(ok.result.isError, undefined)
  assert.equal(ok.text, 'Saved. Say "Focus Mode" any time.')
  assert.deepEqual(steps(saved()[0]), [['open_app', { app: 'Notepad' }], ['say', { message: 'time to focus' }]])
  assert.ok(ok.audits.some((e) => e.kind === 'gate' && e.name === 'routine.save' && e.decision === 'allow'))

  const refusedTrigger = await call({ trigger: 'yes please', steps: ['open Notepad'] }, { answers: ['yes'] })
  assert.equal(refusedTrigger.result.isError, true)
  assert.match(refusedTrigger.text, /yes or a no/)
  assert.deepEqual(refusedTrigger.prompts, [])

  const refusedStep = await call({ trigger: 'nap time', steps: ['go to sleep'] }, { answers: ['yes'] })
  assert.equal(refusedStep.result.isError, true)
  assert.match(refusedStep.text, /can't be part of a routine/)

  const declined = await call({ trigger: 'nap time', steps: ['open Spotify and Chrome'] }, { answers: ['no'] })
  assert.equal(declined.result.isError, true)
  assert.deepEqual(declined.prompts, ['When you say "nap time", I\'ll open Spotify and open Chrome. Save that?'])
  assert.equal(saved().length, 1, 'only the first routine was saved')
})
