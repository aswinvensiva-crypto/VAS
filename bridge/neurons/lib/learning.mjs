import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { learnCorrection } from '../../corrections/learn.mjs'
import { saveCorrections, validateCorrection } from '../../corrections/store.mjs'
import { dataDir } from '../../store/files.mjs'
import { USER_BRAIN } from '../brain.mjs'
import { WAKE_PARTS, normalize, tokenize } from '../matcher.mjs'
import { fill, route } from '../router.mjs'
import { parseConfirm } from '../../gate.mjs'
import { kill_switch } from './basic.mjs'

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
    const learned = learnCorrection(previous.text, text)
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
    const corrected = ctx.corrections.apply(previous.text)
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

const CAN_DO = 'Routines can open, switch to or close apps, open or search sites in Chrome, say something, or tell the time.'
const EXAMPLE = 'Try "when I say work mode, open VS Code and Chrome".'

const brainPath = () => join(dataDir(), USER_BRAIN)

function readUserBrain() {
  const path = brainPath()
  const text = existsSync(path)
    ? readFileSync(path, 'utf8')
    : '# Your routines. Taught by voice, or written by hand — see brain.default.yml for the format.\nversion: 1\nsynapses: []\n'
  return YAML.parseDocument(text)
}

/** Routines you taught by voice, by synapse name: a step may not be one. */
const taughtNames = (brain) => new Set(brain.userSynapses().filter((s) => s.source === 'taught').map((s) => s.name))

const hasPhrase = (list, phrase) =>
  phrase.length > 0 && list.some((_, i) => phrase.every((w, k) => list[i + k] === w))

/**
 * What stands JARVIS down: the kill switch's own modes ("sleep", "mute"…)
 * and every order of a synapse that runs it, yours included ("stand down",
 * "that's all").
 */
function killPhrases(brain) {
  const phrases = kill_switch.params.mode.options.map((mode) => [mode])
  for (const synapse of brain.synapses()) {
    if (!synapse.neurons.some((n) => n.name === kill_switch.name)) continue
    for (const { template } of synapse.signals) {
      if (template.tokens.every((t) => t.type === 'lit')) phrases.push(template.tokens.map((t) => t.word))
    }
  }
  return phrases
}

/**
 * Why a phrase cannot set off a routine, or null when it can.
 *
 * Two words at least, so it is not said by accident. No part of the wake
 * phrase: the face would hear a fresh "Hey Jarvis", and the matcher trims the
 * name off whatever it hears. No word the permission gate takes for a yes or
 * a no — a routine said while a question is open must not answer it, and an
 * answer must not run a routine. Nothing that stands JARVIS down. Each list
 * comes from where those words are decided (wake-aliases.json, parseConfirm,
 * the kill switch's synapses), so it cannot drift from them.
 */
function triggerProblem(trigger, brain) {
  // The words as given, before the matcher trims a leading name or filler:
  // "jarvis mode" is refused for its name, not for being one word long.
  const words = tokenize(trigger).norm
  const quoted = `"${trigger}"`
  if (WAKE_PARTS.some((part) => hasPhrase(words, part))) return `${quoted} sounds like my wake word — pick another phrase.`
  // parseConfirm only takes a yes at the start of an answer, so every
  // word is tried as a start.
  if (words.some((_, i) => parseConfirm(words.slice(i).join(' ')) !== 'unclear')) {
    return `${quoted} sounds like a yes or a no to me — pick another phrase.`
  }
  if (killPhrases(brain).some((p) => hasPhrase(words, p))) return `${quoted} is how you stand me down — pick another phrase.`
  if (normalize(trigger).norm.length < 2) return 'Pick a trigger of at least two words, so I don\'t set it off by accident.'
  return null
}

/** A comma, semicolon or colon as punctuation, not inside a number ("1,000", "10:30"). */
const BREAK = /(?<!\p{N})[,;:]|[,;:](?!\p{N})/u

/**
 * The spec's words, and before which of them the speaker put a comma.
 *
 * The matcher works on words, so the spec it captured has lost its commas;
 * the text as it was said (`raw`) still has them. The spec is a run of the
 * raw text's words, so lining the two up places each comma. When they do not
 * line up — a learned correction rewrote a word in between — there are simply
 * no breaks, and every split point is tried instead.
 */
function spokenBreaks(spec, raw) {
  const words = tokenize(spec).orig
  const want = words.map((w) => w.toLowerCase())
  const pieces = String(raw ?? '').split(BREAK).map((piece) => tokenize(piece).norm)
  const heard = pieces.flat()
  const at = []
  let count = 0
  for (const piece of pieces.slice(0, -1)) at.push((count += piece.length))
  let offset = -1
  for (let i = heard.length - want.length; i >= 0 && offset < 0; i--) {
    if (want.every((w, k) => heard[i + k] === w)) offset = i
  }
  const breaks = offset < 0 ? [] : at.map((b) => b - offset).filter((b) => b > 0 && b < words.length)
  return { words, breaks: [...new Set(breaks)] }
}

/** words[from, to) as text again, with the speaker's commas back in. */
const rejoin = (words, breaks, from = 0, to = words.length) =>
  words
    .slice(from, to)
    .map((w, k) => (from + k + 1 < to && breaks.includes(from + k + 1) ? `${w},` : w))
    .join(' ')

/** Between steps: "and then", "then", "and". */
const SEPARATOR = /\b(and then|then|and)\b/i
const SEPARATOR_WORDS = new Set(['and', 'then'])

/**
 * One step as the neuron it would run, a reason it may not be a step, or
 * null when it is not an order at all.
 */
function resolveStep(text, ctx, taught) {
  const step = normalize(text).orig.join(' ')
  if (!step) return null
  const hit = route(step, ctx.brain, { routine: true })
  if (!hit) return null
  if (hit.synapse.neurons.length !== 1 || taught.has(hit.synapse.name)) {
    return { problem: `A routine can't run another routine, so "${step}" can't be a step.` }
  }
  const [neuron] = hit.synapse.neurons
  if (!ROUTINE_NEURONS.has(neuron.name)) return { problem: `"${step}" can't be part of a routine. ${CAN_DO}` }
  return { step, neuron: neuron.name, params: fill(neuron.params, hit.params), captured: hit.params }
}

/** What a bare next step borrows: "open" from "open VS Code", "search for" from "search for cats". */
function lead({ step, captured }) {
  const values = Object.values(captured)
  if (values.length !== 1) return null
  return step.toLowerCase().endsWith(` ${values[0].toLowerCase()}`) ? step.slice(0, -values[0].length).trim() : null
}

/**
 * "open VS Code and Chrome, then say hi" as steps that all resolve now.
 *
 * Steps are split at commas, "then" and "and". One that is not an order on
 * its own borrows the lead of the step before ("and Chrome" is "open
 * Chrome") — except right after a spoken line, where a bare "and …" is more
 * of the line: "say rise and shine" is one step, not two.
 *
 * @returns {{ steps: object[] } | { problem: string | null, reached: number, refused?: boolean }}
 *   reached: how many steps resolved before the one that did not
 */
function resolveSteps(text, ctx, taught) {
  const pieces = []
  for (const clause of text.split(',')) {
    // split() with a capture group interleaves: even parts are steps, odd parts the separators.
    const parts = clause.split(SEPARATOR)
    for (let i = 0; i < parts.length; i += 2) {
      const piece = parts[i].trim().replace(/[.!?]+$/, '')
      if (piece) pieces.push({ text: piece, weak: parts[i - 1]?.toLowerCase() === 'and' })
    }
  }
  if (!pieces.length) return { problem: null, reached: 0 }
  const steps = []
  for (const piece of pieces) {
    const prev = steps.at(-1)
    let r = resolveStep(piece.text, ctx, taught)
    if (!r && prev?.neuron === 'say' && piece.weak) {
      const longer = resolveStep(`${prev.step} and ${piece.text}`, ctx, taught)
      if (longer && !longer.problem) {
        steps[steps.length - 1] = longer
        continue
      }
    }
    const borrowed = !r && prev ? lead(prev) : null
    if (borrowed) r = resolveStep(`${borrowed} ${piece.text}`, ctx, taught)
    if (!r) return { problem: `I can't do "${piece.text}" on my own. ${CAN_DO}`, reached: steps.length }
    if (r.problem) return { problem: r.problem, reached: steps.length, refused: true }
    steps.push(r)
  }
  return { steps }
}

/**
 * Every way `spec` splits into a trigger and steps that all resolve, and,
 * when there is none, the most useful thing to say about why.
 *
 * The speaker's first comma decides when there is one and what follows it
 * resolves. Otherwise every split point is tried, and each one whose
 * remainder resolves is a candidate (teach asks when there are several). A
 * split never falls next to "and" or "then": "work mode and" is no trigger.
 */
function plan(spec, raw, ctx) {
  const { words, breaks } = spokenBreaks(spec, raw)
  const taught = taughtNames(ctx.brain)
  const splitAt = (i) => {
    const r = resolveSteps(rejoin(words, breaks, i), ctx, taught)
    if (!r.steps) return r
    return { candidate: { trigger: words.slice(0, i).join(' '), steps: r.steps } }
  }

  let said = null
  if (breaks.length) {
    const r = splitAt(Math.min(...breaks))
    if (r.candidate) return { candidates: [r.candidate], problem: null }
    // A step that resolved to something a routine may not do ("go to
    // sleep", another routine) is refused however else the words split.
    if (r.refused) return { candidates: [], problem: r.problem }
    // Where the speaker put the comma, the actions start, so whatever failed
    // there is the thing to mention — unless the comma was misplaced (a
    // recogniser's "good, morning open Spotify") and another split works.
    said = r.problem
  }
  const candidates = []
  // Otherwise only a failure past the first step, or a step refused outright,
  // says anything; "I can't do 'mode open notepad'" from a wrong split doesn't.
  let best = { problem: null, score: 0 }
  for (let i = 1; i < words.length; i++) {
    if (SEPARATOR_WORDS.has(words[i - 1].toLowerCase()) || SEPARATOR_WORDS.has(words[i].toLowerCase())) continue
    const r = splitAt(i)
    if (r.candidate) {
      candidates.push(r.candidate)
      continue
    }
    const score = r.reached + (r.refused ? 0.5 : 0)
    if (r.problem && score > best.score) best = { problem: r.problem, score }
  }
  return { candidates, problem: said ?? best.problem }
}

const describe = (steps) => {
  const parts = steps.map((s) => s.step)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
}

/** "Which words should start it — "work mode" or "work mode open notepad"?" */
async function pickTrigger(candidates, ctx) {
  const options = candidates.slice(0, 3).map((c) => c.trigger)
  const quoted = options.map((o) => `"${o}"`)
  const answer = await ctx.choose(
    `Which words should start the routine — ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}?`,
    options,
  )
  return candidates.find((c) => c.trigger === answer) ?? null
}

const brokenBrain = (doc) =>
  doc.errors.length ? { say: `Your ${USER_BRAIN} has a mistake in it, so I won't write to it until it's fixed.`, stop: true } : null

/**
 * The one way a routine is saved, by voice or by Claude: the trigger
 * checked, the user asked, then written into brain.yml as ordered-strict.
 * Saving grants nothing; each step still asks for itself when it runs.
 */
async function saveRoutine({ trigger: given, steps }, ctx) {
  const problem = triggerProblem(given, ctx.brain)
  if (problem) return { say: problem, stop: true }
  const trigger = normalize(given).orig.join(' ')
  const existing = route(trigger, ctx.brain)
  if (existing && existing.coverage === 1) {
    return { say: `"${trigger}" already does something. Say "forget the routine ${trigger}" first.`, stop: true }
  }
  const broken = brokenBrain(readUserBrain())
  if (broken) return broken
  const verdict = await ctx.gate.check('routine.save', {
    prompt: `When you say "${trigger}", I'll ${describe(steps)}. Save that?`,
    args: { trigger },
  })
  if (!verdict.allowed) return { say: verdict.reason, stop: true }

  // Read again: the question can stay open long enough for a hand edit.
  const doc = readUserBrain()
  const brokenNow = brokenBrain(doc)
  if (brokenNow) return brokenNow
  const synapse = {
    name: `routine-${trigger.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    source: 'taught',
    created: new Date().toISOString(),
    signals: [{ order: { text: trigger.toLowerCase(), 'matching-type': 'ordered-strict' } }],
    neurons: steps.map((s) => ({ [s.neuron]: s.params })),
  }
  const list = doc.get('synapses') ?? doc.createNode([])
  list.add(doc.createNode(synapse))
  doc.set('synapses', list)
  writeFileSync(brainPath(), String(doc))
  ctx.brain.reload()
  ctx.audit({ kind: 'teach', name: synapse.name, args: { trigger, steps: steps.map((s) => s.neuron) } })
  return { say: `Saved. Say "${trigger}" any time.` }
}

/** "when I say work mode, open VS Code and Chrome" — a new neuron. */
export const teach = {
  name: 'teach',
  description: 'Learn a routine: a phrase that runs several actions.',
  tier: 'confirm',
  params: { spec: z.string().min(3).max(300) },
  async run({ spec }, ctx) {
    // The words as said, commas and all, when the turn has them; the spec
    // alone has lost its commas, and then every split point is tried.
    const { candidates, problem } = plan(spec, ctx.raw ?? spec, ctx)
    if (!candidates.length) {
      return { say: problem ?? `I can only build routines from things I can do directly, like opening apps or sites. ${EXAMPLE}`, stop: true }
    }
    const usable = candidates.filter((c) => !triggerProblem(c.trigger, ctx.brain))
    if (!usable.length) return { say: triggerProblem(candidates[0].trigger, ctx.brain), stop: true }
    // More than one reading works ("work mode open notepad open calculator"
    // has no comma to say where the phrase ends): ask rather than guess.
    const chosen = usable.length === 1 ? usable[0] : await pickTrigger(usable, ctx)
    if (!chosen) return { say: 'Okay, I\'ll leave it. Say it again with a pause after the phrase.', stop: true }
    return saveRoutine(chosen, ctx)
  },
}

/**
 * The same, for Claude: a trigger and its steps already apart. The steps
 * go through the same resolving, the trigger through the same checks, and
 * the user is asked the same question before anything is written.
 */
export const teach_routine = {
  name: 'teach_routine',
  description: 'Learn a routine from a trigger phrase and its steps.',
  tier: 'confirm',
  params: {
    trigger: z.string().min(3).max(100),
    steps: z.array(z.string().min(2).max(200)).min(1).max(10),
  },
  async run({ trigger, steps }, ctx) {
    const r = resolveSteps(steps.join(', '), ctx, taughtNames(ctx.brain))
    if (!r.steps) return { say: r.problem ?? `Those steps are empty. ${CAN_DO}`, stop: true }
    return saveRoutine({ trigger, steps: r.steps }, ctx)
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
    if (!mine.length) return { say: `You haven't taught me any routines yet. ${EXAMPLE}` }
    const triggers = mine.map((s) => {
      const o = s.signals[0]?.order
      return typeof o === 'string' ? o : o?.text
    })
    return { say: `You've taught me ${triggers.length}: ${triggers.join(', ')}.` }
  },
}

// validateCorrection is re-exported for the settings endpoints.
export { validateCorrection }
