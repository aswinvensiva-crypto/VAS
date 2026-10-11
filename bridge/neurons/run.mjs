import { z } from 'zod'
import { fill } from './router.mjs'

/**
 * Run one synapse: its neurons in order, each with the words captured from
 * what was said put into its parameters.
 *
 * A neuron returns what JARVIS should say and, optionally:
 *   fallthrough — "not for me after all" (open_app heard "the pod bay doors"):
 *                 the utterance goes to Claude as if nothing had matched.
 *   handoff     — "Claude should finish this", with the message to send
 *                 (chrome_search opens the page, Claude reads it).
 *   after       — what the interface does next: 'dormant' to stand down.
 *   stop        — skip the rest of a routine (a step was refused).
 *
 * @param {{ synapse: object, params: Record<string,string> }} hit
 * @param {object} ctx      shared with every neuron (see server.mjs)
 * @param {Map<string, object>} registry
 */
export async function runSynapse(hit, ctx, registry) {
  const said = []
  let after
  for (const step of hit.synapse.neurons) {
    if (ctx.signal?.aborted) return { aborted: true }
    const neuron = registry.get(step.name)
    if (!neuron) return { say: `I don't know how to ${step.name.replace(/_/g, ' ')} yet.` }
    const parsed = z.object(neuron.params).safeParse(fill(step.params, hit.params))
    if (!parsed.success) {
      return { say: `I couldn't do that — ${parsed.error.issues[0]?.message ?? 'a setting is wrong'}.` }
    }
    const r = (await neuron.run(parsed.data, ctx)) ?? {}
    if (r.fallthrough || r.handoff) return { ...r, say: [...said, r.say].filter(Boolean).join(' ') }
    if (r.say) said.push(r.say)
    if (r.after) after = r.after
    if (r.stop) break
  }
  return { say: said.join(' '), after }
}
