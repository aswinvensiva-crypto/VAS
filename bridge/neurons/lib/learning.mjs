import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { learnCorrection } from '../../corrections/learn.mjs'
import { saveCorrections, validateCorrection } from '../../corrections/store.mjs'
import { dataDir } from '../../store/files.mjs'
import { USER_BRAIN } from '../brain.mjs'
import { normalize } from '../matcher.mjs'
import { route } from '../router.mjs'

/**
 * Learning from you: corrections when JARVIS mishears, and routines you
 * teach him — new neurons, made by voice.
 */

/** "no, I said open Spotify" — remember the mishearing, then do what was meant. */
export const correction = {
  name: 'correction',
  description: 'Learn from a correction and redo the command as meant.',
  tier: 'confirm',
  params: { text: z.string().min(1).max(200) },
  async run({ text }, ctx) {
    const previous = ctx.memory.previousUser
    // Only a correction of what was just said, a moment ago; anything else
    // ("I said I'd be late") is ordinary conversation for Claude.
    if (!previous || Date.now() - previous.at > 30_000) return { fallthrough: true }
    // Learned from what was actually transcribed. The routed text has already
    // been through the corrections learned so far, so aligning against it
    // would miss the mishearing whenever an older correction touched it too.
    const heard = previous.raw ?? previous.text
    const learned = learnCorrection(heard, text)
    if (!learned) return { fallthrough: true }
    const verdict = await ctx.gate.check('correction.save', {
      prompt: `Got it — when I hear "${learned.heard}", you mean "${learned.meant}". Remember that?`,
      args: learned,
    })
    if (verdict.allowed) {
      try {
        ctx.corrections.add({ ...learned, source: 'voice' })
        await saveCorrections(ctx.corrections)
      } catch (err) {
        return { say: String(err.message) }
      }
    }
    // Either way, do what they meant this time.
    const corrected = ctx.corrections.apply(heard)
    const redo = verdict.allowed ? corrected : text
    const r = await ctx.route(redo)
    return r ?? { handoff: redo }
  },
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

/** The neurons a routine may chain. Nothing that teaches, corrects or unlocks. */
const ROUTINE_NEURONS = new Set(['open_app', 'focus_app', 'close_app', 'chrome_open', 'chrome_search', 'say', 'time', 'date'])

/** Words a trigger must not contain: they mean something else already. */
const RESERVED = /\b(yes|yeah|no|confirm|cancel|stop|unlock|lock ?down|sleep|shut ?down|quit|jarvis|travis|jervis)\b/i

const brainPath = () => join(dataDir(), USER_BRAIN)

function readUserBrain() {
  const path = brainPath()
  const text = existsSync(path)
    ? readFileSync(path, 'utf8')
    : '# Your routines. Taught by voice, or written by hand — see brain.default.yml for the format.\nversion: 1\nsynapses: []\n'
  return YAML.parseDocument(text)
}

/** Split "work mode open vs code and chrome" into a trigger and steps that all resolve. */
function plan(spec, ctx) {
  const tryActions = (actionsText) => {
    const steps = actionsText
      .split(/\s*(?:,|\band then\b|\bthen\b|\band\b)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!steps.length) return null
    const resolved = []
    let verb = null
    for (let step of steps) {
      let hit = route(step, ctx.brain)
      // "open VS Code and Chrome": the second step borrows the first's verb.
      if ((!hit || hit.synapse.neurons.length !== 1) && verb) {
        const borrowed = `${verb} ${step}`
        hit = route(borrowed, ctx.brain)
        if (hit) step = borrowed
      }
      if (!hit || hit.synapse.neurons.length !== 1) return null
      verb = step.split(/\s+/)[0]
      const [neuron] = hit.synapse.neurons
      if (!ROUTINE_NEURONS.has(neuron.name)) return null
      resolved.push({ step, neuron: neuron.name, params: Object.fromEntries(Object.entries(neuron.params).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => hit.params[n] ?? '') : v])) })
    }
    return resolved
  }

  const comma = spec.indexOf(',')
  if (comma > 0) {
    const steps = tryActions(spec.slice(comma + 1))
    if (steps) return { trigger: spec.slice(0, comma).trim(), steps }
  }
  const words = spec.trim().split(/\s+/)
  for (let i = 1; i < words.length; i++) {
    const steps = tryActions(words.slice(i).join(' '))
    if (steps) return { trigger: words.slice(0, i).join(' '), steps }
  }
  return null
}

const describe = (steps) => {
  const parts = steps.map((s) => s.step)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
}

/** "when I say work mode, open VS Code and Chrome" — a new neuron. */
export const teach = {
  name: 'teach',
  description: 'Learn a routine: a phrase that runs several actions.',
  tier: 'confirm',
  params: { spec: z.string().min(3).max(300) },
  async run({ spec }, ctx) {
    const p = plan(spec, ctx)
    if (!p) return { say: 'I can only build routines from things I can do directly, like opening apps or sites. Try "when I say work mode, open VS Code and Chrome".' }
    const trigger = normalize(p.trigger).orig.join(' ')
    if (normalize(trigger).norm.length < 2) return { say: 'Pick a trigger of at least two words, so I don\'t set it off by accident.' }
    if (RESERVED.test(trigger)) return { say: `"${trigger}" already means something to me — pick another phrase.` }
    const existing = route(trigger, ctx.brain)
    if (existing && existing.coverage === 1) return { say: `"${trigger}" already does something. Say "forget the routine ${trigger}" first.` }
    const verdict = await ctx.gate.check('routine.save', {
      prompt: `When you say "${trigger}", I'll ${describe(p.steps)}. Save that?`,
      args: { trigger },
    })
    if (!verdict.allowed) return { say: verdict.reason }

    const doc = readUserBrain()
    const synapse = {
      name: `routine-${trigger.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      source: 'taught',
      created: new Date().toISOString(),
      signals: [{ order: { text: trigger.toLowerCase(), 'matching-type': 'ordered-strict' } }],
      neurons: p.steps.map((s) => ({ [s.neuron]: s.params })),
    }
    const list = doc.get('synapses') ?? doc.createNode([])
    list.add(doc.createNode(synapse))
    doc.set('synapses', list)
    writeFileSync(brainPath(), String(doc))
    ctx.brain.reload()
    ctx.audit({ kind: 'teach', name: synapse.name, args: { trigger, steps: p.steps.map((s) => s.neuron) } })
    return { say: `Saved. Say "${trigger}" any time.` }
  },
}

export const forget_routine = {
  name: 'forget_routine',
  description: 'Delete a routine you taught.',
  tier: 'confirm',
  params: { name: z.string().min(1).max(100) },
  async run({ name }, ctx) {
    const doc = readUserBrain()
    const list = doc.get('synapses')
    const items = list?.items ?? []
    const want = normalize(name).norm.join(' ')
    const index = items.findIndex((item) => {
      const signals = item.toJSON().signals ?? []
      return signals.some((s) => normalize(typeof s.order === 'string' ? s.order : s.order.text).norm.join(' ') === want)
    })
    if (index < 0) return { say: `I don't have a routine called "${name}".` }
    const verdict = await ctx.gate.check('routine.forget', { prompt: `Forget the routine "${name}"?` })
    if (!verdict.allowed) return { say: verdict.reason }
    list.delete(index)
    writeFileSync(brainPath(), String(doc))
    ctx.brain.reload()
    ctx.audit({ kind: 'teach', name: 'forget', args: { routine: name } })
    return { say: `Forgotten.` }
  },
}

export const list_routines = {
  name: 'list_routines',
  description: 'Say the routines you have taught.',
  tier: 'free',
  params: {},
  async run(_params, ctx) {
    const mine = ctx.brain.userSynapses()
    if (!mine.length) return { say: 'You haven\'t taught me any routines yet. Try "when I say work mode, open VS Code and Chrome".' }
    const triggers = mine.map((s) => {
      const o = s.signals[0]?.order
      return typeof o === 'string' ? o : o?.text
    })
    return { say: `You've taught me ${triggers.length}: ${triggers.join(', ')}.` }
  },
}

// validateCorrection is re-exported for the settings endpoints.
export { validateCorrection }
