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
  /**
   * Only a step inside a routine you teach, never an order on its own:
   * "…, then say good morning" is a step, but "say something funny" said to
   * JARVIS is a question for Claude.
   */
  'routine-only': z.boolean().optional(),
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

/**
 * Parse and validate one brain file's text; throws a readable error.
 *
 * Every order is also parsed as a template here, so an order the matcher
 * would refuse ("{{a}} {{b}}", a name used twice, nothing but "hey jarvis")
 * fails the file as a whole, with the synapse named, instead of surfacing
 * later from somewhere that cannot recover.
 */
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
    for (const { order } of syn.signals) {
      try {
        parseTemplate(typeof order === 'string' ? order : order.text)
      } catch (err) {
        throw new Error(`synapse "${syn.name}": ${err.message}`)
      }
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
    routineOnly: syn['routine-only'] === true,
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
  // The shipped file is not guarded: a mistake in it is a bug in VAS, and the
  // tests load it, so it fails there rather than on someone's PC.
  const builtIn = parseBrain(readFileSync(DEFAULT_BRAIN, 'utf8'), { known })
  const builtInCompiled = builtIn.synapses.map((s, i) => compile(s, 'default', i))
  let user = { synapses: [] }
  let userCompiled = []

  /**
   * Read your file and swap it in only once all of it has parsed, validated
   * and compiled. Anything that fails on the way — the file half-saved by an
   * editor, bad YAML, an unknown neuron, an order the matcher refuses —
   * leaves the last good version in charge, both what is stored and what is
   * matched, so the two never disagree. This runs at startup and from the
   * file watcher's timer, where a throw would take the whole bridge down.
   */
  function loadUser() {
    const path = join(dataDir(), USER_BRAIN)
    try {
      const next = existsSync(path) ? parseBrain(readFileSync(path, 'utf8'), { known }) : { synapses: [] }
      const nextCompiled = next.synapses.map((s, i) => compile(s, 'user', i))
      user = next
      userCompiled = nextCompiled
    } catch (err) {
      // YAML's errors carry a code frame after the first line; the first line
      // already says what and where, and a log line should stay one line.
      const why = String(err?.message ?? err).split('\n')[0]
      onError(`${USER_BRAIN} not loaded (${why}); keeping the previous version`)
    }
  }

  let compiled = []
  function rebuild() {
    const mine = new Set(user.synapses.map((s) => s.name))
    compiled = [...userCompiled, ...builtInCompiled.filter((s) => !mine.has(s.name))]
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
