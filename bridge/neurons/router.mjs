import { match, normalize, rankMatches } from './matcher.mjs'

/**
 * Which synapse, if any, an utterance is for.
 *
 * Every signal of every synapse is tried; of those that fit, exactly one runs
 * — the one whose own words cover the most of what was said (so a routine you
 * taught, "work mode", beats the general "open {{app}}" when both could
 * apply), then your synapses over the built-in ones, then the stricter match.
 * Nothing fits: null, and the utterance goes to Claude.
 *
 * Synchronous on purpose: deciding takes microseconds, and keeping it
 * synchronous keeps questions answered in the order they were asked.
 *
 * `routine` is for teaching: a step of a routine may also use the synapses
 * marked routine-only ("say {{message}}"), which no spoken order reaches.
 *
 * @param {{ routine?: boolean }} [options]
 * @returns {{ synapse: object, params: Record<string, string>, coverage: number } | null}
 */
export function route(text, brain, { routine = false } = {}) {
  const input = normalize(text)
  if (!input.norm.length) return null
  const candidates = []
  for (const synapse of brain.synapses()) {
    if (synapse.routineOnly && !routine) continue
    for (const signal of synapse.signals) {
      const m = match(signal.template, input, { type: signal.type, excluded: signal.excluded })
      if (m) {
        candidates.push({
          ...m,
          synapse,
          type: signal.type,
          source: synapse.source,
          index: synapse.index,
        })
      }
    }
  }
  if (!candidates.length) return null
  const best = rankMatches(candidates)[0]
  return { synapse: best.synapse, params: best.params, coverage: best.coverage }
}

/** Put captured words into a neuron's parameters: "{{app}}" -> "spotify". */
export function fill(params, captured) {
  const out = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] =
      typeof value === 'string'
        ? value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => captured[name] ?? '')
        : value
  }
  return out
}
