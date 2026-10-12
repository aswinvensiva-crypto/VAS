import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The brain: brain.default.yml merged with the user's brain.yml, validated,
 * hot-reloaded, and never replaced by a file that does not load.
 */

let dir
let brainMod
let route
let known
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-brain-'))
  process.env.JARVIS_DATA_DIR = dir
  brainMod = await import('../../bridge/neurons/brain.mjs')
  ;({ route } = await import('../../bridge/neurons/router.mjs'))
  known = new Set((await import('../../bridge/neurons/registry.mjs')).registry.keys())
})
after(() => rmSync(dir, { recursive: true, force: true }))

const userFile = () => join(dir, 'brain.yml')
const writeUser = (text) => writeFileSync(userFile(), text)

/** A brain that records its complaints instead of printing them. */
let brain
let errors
function open() {
  errors = []
  brain = brainMod.createBrain({ known, onError: (m) => errors.push(m) })
  return brain
}
beforeEach(() => rmSync(userFile(), { force: true }))
afterEach(() => brain?.close())

const GOOD = `
version: 1
synapses:
  - name: work-mode
    signals:
      - order: { text: "work mode", matching-type: ordered-strict }
    neurons:
      - say: { message: "To work." }
  - name: time
    signals:
      - order: { text: "what time is it", matching-type: ordered-strict }
    neurons:
      - say: { message: "Time you got a watch." }
`

const said = (text) => route(text, brain)?.synapse.neurons[0]

/** Poll, because the watcher's callback lands on its own timer. */
async function eventually(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('the shipped brain loads on its own, every neuron in it known', () => {
  open()
  assert.deepEqual(errors, [])
  assert.deepEqual(brain.userSynapses(), [])
  assert.ok(brain.synapses().every((s) => s.source === 'default'))
  assert.equal(said('what time is it').name, 'time')
  assert.equal(said('open notepad').name, 'open_app')
})

test('your file is merged in: new synapses added, one with a built-in name replaces it', () => {
  writeUser(GOOD)
  open()
  assert.deepEqual(errors, [])
  assert.deepEqual(brain.userSynapses().map((s) => s.name), ['work-mode', 'time'])
  const times = brain.synapses().filter((s) => s.name === 'time')
  assert.equal(times.length, 1, 'the built-in "time" is replaced, not shadowed')
  assert.equal(times[0].source, 'user')
  assert.deepEqual(said('what time is it'), { name: 'say', params: { message: 'Time you got a watch.' } })
  assert.equal(said('work mode').name, 'say')
  // Everything else still comes from the shipped file.
  assert.equal(said('open notepad').name, 'open_app')
  assert.equal(brain.synapses()[0].source, 'user', 'yours first')
})

test('a routine-only synapse is a step for teaching, never an order', () => {
  open()
  assert.equal(route('say hello there', brain), null)
  const hit = route('say hello there', brain, { routine: true })
  assert.equal(hit.synapse.name, 'say')
  assert.equal(hit.params.message, 'hello there')
  // "say that again" is still the repeat order, routine or not.
  assert.equal(route('say that again', brain, { routine: true }).synapse.name, 'repeat')
})

test('parseBrain: zod and the neuron list reject what cannot run', () => {
  const { parseBrain } = brainMod
  const one = (neuron, order = '"go go"') => `synapses:\n  - name: x\n    signals:\n      - order: ${order}\n    neurons:\n      - ${neuron}\n`
  assert.throws(() => parseBrain(one('launch_rockets: {}'), { known }), /synapse "x" uses unknown neuron "launch_rockets"/)
  assert.throws(() => parseBrain('synapses:\n  - name: x\n    neurons: []\n', { known }), /neurons/)
  assert.throws(() => parseBrain('synapses:\n  - signals: []\n    neurons:\n      - time: {}\n', { known }), /name/)
  assert.throws(() => parseBrain(one('time: {}', '{ text: "go", matching-type: fuzzy }'), { known }), /signals\.0\.order/)
  assert.throws(() => parseBrain('version: 2\n', { known }), /version/)
  assert.doesNotThrow(() => parseBrain(one('time: {}'), { known }))
})

test('parseBrain: orders the matcher would refuse fail the file, naming the synapse', () => {
  const { parseBrain } = brainMod
  const withOrder = (order) => `synapses:\n  - name: odd\n    signals:\n      - order: "${order}"\n    neurons:\n      - say: { message: hi }\n`
  assert.throws(() => parseBrain(withOrder('{{a}} {{b}}'), { known }), /synapse "odd": .*adjacent variables/)
  assert.throws(() => parseBrain(withOrder('play {{x}} by {{x}}'), { known }), /synapse "odd": .*repeats/)
  assert.throws(() => parseBrain(withOrder('hey jarvis'), { known }), /synapse "odd": .*no words/)
})

test('a broken edit keeps the last good brain: bad YAML, bad template, unknown neuron', () => {
  writeUser(GOOD)
  open()
  const shape = () => brain.synapses().map((s) => `${s.source}:${s.name}`)
  const before = shape()
  const broken = [
    'synapses: [ {',
    'synapses:\n  - name: odd\n    signals:\n      - order: "{{a}} {{b}}"\n    neurons:\n      - say: { message: hi }\n',
    'synapses:\n  - name: odd\n    signals:\n      - order: "odd one"\n    neurons:\n      - launch_rockets: {}\n',
  ]
  for (const text of broken) {
    writeUser(text)
    assert.doesNotThrow(() => brain.reload())
    assert.deepEqual(shape(), before, text)
    assert.deepEqual(brain.userSynapses().map((s) => s.name), ['work-mode', 'time'])
    assert.equal(said('work mode').name, 'say')
  }
  assert.equal(errors.length, broken.length)
  assert.ok(errors.every((e) => /brain\.yml not loaded .*keeping the previous version/.test(e)), errors.join('\n'))
  // Fixed again, it loads again; deleted, only the built-ins are left.
  writeUser(GOOD.replace('work mode', 'deep work'))
  brain.reload()
  assert.equal(said('deep work').name, 'say')
  rmSync(userFile())
  brain.reload()
  assert.deepEqual(brain.userSynapses(), [])
  assert.equal(said('what time is it').name, 'time')
})

test('a broken file at startup leaves the built-ins running, and says so', () => {
  writeUser('synapses:\n  - name: odd\n    signals:\n      - order: "hey jarvis"\n    neurons:\n      - say: { message: hi }\n')
  assert.doesNotThrow(open)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /synapse "odd"/)
  assert.deepEqual(brain.userSynapses(), [])
  assert.equal(said('what time is it').name, 'time')
})

test('hot reload: an edit to brain.yml is live without a restart, a bad one is not', async () => {
  open()
  assert.equal(route('work mode', brain), null)
  writeUser(GOOD)
  await eventually(() => route('work mode', brain), 'the new routine to load')
  assert.deepEqual(errors, [])
  writeUser('synapses: [ {')
  await eventually(() => errors.length > 0, 'the broken edit to be reported')
  assert.equal(said('work mode').name, 'say', 'the last good brain is still in charge')
})

test('reload says whether the file loaded, and problem() says why one would not', () => {
  writeUser(GOOD)
  open()
  assert.equal(brain.reload(), true)
  assert.equal(brain.problem(GOOD), null)
  const typo = 'synapses:\n  - name: odd\n    signals:\n      - order: "odd one"\n    neurons:\n      - launch_rockets: {}\n'
  assert.match(brain.problem(typo), /unknown neuron "launch_rockets"/)
  assert.match(brain.problem('synapses: [ {'), /./)
  assert.equal(brain.userSynapses().length, 2, 'checking a text changes nothing')
  writeUser(typo)
  assert.equal(brain.reload(), false)
  assert.equal(brain.userSynapses().length, 2, 'the last good one stays')
})
