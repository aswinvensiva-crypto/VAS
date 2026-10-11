import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { parseTemplate } from './matcher.mjs'
import { dataDir, watchData } from '../store/files.mjs'

/**
 * JARVIS's brain: the synapses that turn spoken orders into neurons.
 *
 * Two files, merged. brain.default.yml ships with VAS; brain.yml in the data
 * folder is yours — routines you taught him by voice, or wrote by hand — and a
 * synapse there with the same name replaces the built-in one. The user file
 * is watched: edit it and the next thing you say uses it. A file that does not
 * parse is reported and the last good brain stays in charge, so a typo never
 * leaves JARVIS deaf to his own commands.
 */

const MatchType = z.enum(['normal', 'strict', 'ordered-strict', 'not-contain'])

const Order = z.union([
  z.string(),
  z.object({
    text: z.string().min(1),
    'matching-type': MatchType.default('normal'),
    'excluded-words': z.array(z.string()).optional(),
  }),
])

const Synapse = z.object({
  name: z.string().min(1),
  signals: z.array(z.object({ order: Order })).default([]),
  neurons: z.array(z.record(z.string(), z.record(z.string(), z.unknown()).nullable())).min(1),
  /** Taught by voice (and when) — informational. */
  source: z.string().optional(),
  created: z.string().optional(),
})

const BrainFile = z.object({
  version: z.literal(1).default(1),
  synapses: z.array(Synapse).default([]),
})

export const USER_BRAIN = 'brain.yml'
const DEFAULT_BRAIN = new URL('./brain.default.yml', import.meta.url)

/** Parse and validate one brain file's text; throws a readable error. */
export function parseBrain(text, { known } = {}) {
  const raw = YAML.parse(text) ?? {}
  const parsed = BrainFile.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${issue.path.join('.') || 'brain'}: ${issue.message}`)
  }
  for (const syn of parsed.data.synapses) {
    for (const step of syn.neurons) {
      const [name] = Object.keys(step)
      if (known && !known.has(name)) throw new Error(`synapse "${syn.name}" uses unknown neuron "${name}"`)
    }
  }
  return parsed.data
}

/** One synapse, ready for matching. */
function compile(syn, source, index) {
  return {
    name: syn.name,
    source,
    index,
    signals: syn.signals.map(({ order }) => {
      const text = typeof order === 'string' ? order : order.text
      return {
        text,
        template: parseTemplate(text),
        type: typeof order === 'string' ? 'normal' : order['matching-type'],
        excluded: typeof order === 'string' ? [] : (order['excluded-words'] ?? []),
      }
    }),
    neurons: syn.neurons.map((step) => {
      const [name] = Object.keys(step)
      return { name, params: step[name] ?? {} }
    }),
  }
}

/**
 * Load both files and keep the merged brain current.
 *
 * @param {{ known: Set<string>, onError?: (message: string) => void }} options
 *   known: the registered neuron names, so a synapse naming a neuron that does
 *   not exist is caught when the file loads rather than when it is spoken.
 */
export function createBrain({ known, onError = (m) => console.warn(`[jarvis] brain: ${m}`) }) {
  const builtIn = parseBrain(readFileSync(DEFAULT_BRAIN, 'utf8'), { known })
  let user = { synapses: [] }

  function loadUser() {
    const path = join(dataDir(), USER_BRAIN)
    if (!existsSync(path)) {
      user = { synapses: [] }
      return
    }
    try {
      user = parseBrain(readFileSync(path, 'utf8'), { known })
    } catch (err) {
      onError(`${USER_BRAIN} not loaded (${err.message}); keeping the previous version`)
    }
  }

  let compiled = []
  function rebuild() {
    const mine = new Set(user.synapses.map((s) => s.name))
    compiled = [
      ...user.synapses.map((s, i) => compile(s, 'user', i)),
      ...builtIn.synapses.filter((s) => !mine.has(s.name)).map((s, i) => compile(s, 'default', i)),
    ]
  }

  loadUser()
  rebuild()
  const stop = watchData(USER_BRAIN, () => {
    loadUser()
    rebuild()
  })

  return {
    /** Every synapse, user ones first. */
    synapses: () => compiled,
    /** Routines you taught or wrote, as stored. */
    userSynapses: () => user.synapses,
    reload() {
      loadUser()
      rebuild()
    },
    close: stop,
  }
}
