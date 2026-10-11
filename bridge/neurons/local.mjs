import { z } from 'zod'
import { route } from './router.mjs'
import { runSynapse } from './run.mjs'
import { registry } from './registry.mjs'
import { resolveApp } from '../os/resolve.mjs'
import { chromeOps } from '../chrome.mjs'
import { audit } from '../store/audit.mjs'

/**
 * The local half of a conversation: what happens when something said matches
 * a neuron, before (or instead of) Claude.
 *
 * One per connection. A local turn replies with the same 'text' and 'done'
 * frames as a Claude turn, tagged with the question's id, so the face cannot
 * tell the difference — except that it arrives in milliseconds. Claude is
 * told afterwards what was handled without it ("[Handled on this PC: …]"),
 * so "close it" after a local "open Spotify" still makes sense to it.
 *
 * @param {object} deps
 * @param {(msg: object) => void} deps.send
 * @param {Function} deps.ask        the bridge's ask-the-face round trip
 * @param {object} deps.gate
 * @param {object} deps.brain
 * @param {object} deps.corrections
 * @param {(text: string, id: string|null) => void} deps.toClaude
 */
export function createLocal({ send, ask, gate, brain, corrections, toClaude }) {
  const memory = { lastReply: '', lastUser: null, previousUser: null }
  const log = []
  let current = null

  /** "Notepad or Notepad++?" — the answer, by name or position, or null. */
  async function choose(question, options) {
    let reply
    try {
      reply = await ask('confirm', { prompt: question, action: 'choose', timeoutMs: 20_000 }, 25_000)
    } catch {
      return null
    }
    if (!reply || reply.cancelled) return null
    if (reply.source === 'click') return reply.approved ? options[0] : null
    const said = String(reply.text ?? '').toLowerCase()
    const ordinal = ['first', 'second', 'third', 'fourth', 'fifth'].findIndex((w) => said.includes(w))
    if (ordinal >= 0 && ordinal < options.length) return options[ordinal]
    const pseudo = options.map((name) => ({ name, appId: name, kind: 'store', risk: 'normal' }))
    return resolveApp(said, pseudo).best?.app.name ?? null
  }

  function context({ id, signal, after }) {
    const ctx = {
      signal,
      gate,
      brain,
      corrections,
      memory,
      chrome: chromeOps,
      audit,
      choose,
      send,
      say: (text) => !signal.aborted && send({ type: 'text', delta: `${text} `, ask: id }),
      afterTurn: (fn) => after.push(fn),
      /** Run one neuron by name, e.g. open_app handing a website to chrome_open. */
      async run(name, params) {
        const neuron = registry.get(name)
        const parsed = z.object(neuron.params).safeParse(params)
        if (!parsed.success) return { say: "I couldn't do that." }
        return (await neuron.run(parsed.data, ctx)) ?? {}
      },
      /** Route and run another utterance (a correction redoing a command). */
      async route(text) {
        const hit = route(text, brain)
        return hit ? runSynapse(hit, ctx, registry) : null
      },
    }
    return ctx
  }

  return {
    memory,
    /** Context for neurons Claude calls as tools (no turn of their own). */
    toolContext() {
      return context({ id: null, signal: new AbortController().signal, after: [] })
    },

    /** Notes for Claude about turns it did not see, cleared once read. */
    takeLog() {
      const lines = log.splice(0)
      return lines.length ? `[Handled on this PC without you: ${lines.join('; ')}]\n\n` : ''
    },

    /**
     * Handle one question. Returns once it is answered locally or handed on.
     * Synchronous routing keeps questions in the order they were asked.
     */
    async handle(text, id) {
      memory.previousUser = memory.lastUser
      memory.lastUser = { text, at: Date.now() }
      const hit = route(text, brain)
      if (!hit) return toClaude(text, id)

      const ac = new AbortController()
      current = ac
      const after = []
      const local = (m) => !ac.signal.aborted && send({ ...m, ask: id })
      // A neuron that takes a moment (the Start menu read cold, a page loading)
      // gets the same "working on it" cue as a Claude tool would.
      const slow = setTimeout(() => local({ type: 'tool', name: `mcp__jarvis_neurons__${hit.synapse.neurons[0].name}` }), 700)
      try {
        const r = await runSynapse(hit, context({ id, signal: ac.signal, after }), registry)
        clearTimeout(slow)
        if (ac.signal.aborted || r.aborted) return
        if (r.fallthrough) return toClaude(text, id)
        if (r.handoff) {
          if (r.say) local({ type: 'text', delta: `${r.say} ` })
          return toClaude(r.handoff, id)
        }
        const say = r.say || 'Done.'
        memory.lastReply = say
        log.push(`"${text}" → ${say}`)
        if (log.length > 10) log.shift()
        local({ type: 'text', delta: say })
        local({ type: 'done', text: say, costUsd: 0, local: hit.synapse.name, ...(r.after ? { after: r.after } : {}) })
        for (const fn of after) setTimeout(fn, 1800)
      } catch (err) {
        clearTimeout(slow)
        console.error(`[jarvis] neuron ${hit.synapse.name} failed:`, err)
        local({ type: 'error', message: 'That went wrong on my side.' })
      } finally {
        if (current === ac) current = null
      }
    },

    /** Barge-in, Escape, or disconnect: drop the local turn in progress. */
    abort() {
      current?.abort()
      current = null
    },
  }
}
