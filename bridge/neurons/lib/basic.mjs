import { z } from 'zod'
import { loadPermissions, savePermissions } from '../../gate.mjs'
import { forgetSpeaker, loadSpeaker } from '../../voice/speaker.mjs'

/**
 * Small neurons that answer instantly and never need Claude.
 *
 * Each neuron is { name, description, tier, params (a zod shape), run }.
 * `run(params, ctx)` returns what to say (see run.mjs for the rest).
 */

export const time = {
  name: 'time',
  description: 'Say the current time.',
  tier: 'free',
  params: {},
  async run() {
    const t = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return { say: `It's ${t}.` }
  },
}

export const date = {
  name: 'date',
  description: "Say today's date.",
  tier: 'free',
  params: {},
  async run() {
    const d = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    return { say: `It's ${d}.` }
  },
}

export const repeat = {
  name: 'repeat',
  description: 'Say the last answer again.',
  tier: 'free',
  params: {},
  async run(_params, ctx) {
    const last = ctx.memory.lastReply
    return { say: last || "I haven't said anything yet." }
  },
}

export const say = {
  name: 'say',
  description: 'Say a fixed sentence (for routines).',
  tier: 'free',
  params: { message: z.string().min(1).max(300) },
  async run({ message }) {
    return { say: message }
  },
}

/**
 * Standing JARVIS down, by degrees.
 *   sleep    — back to waiting for "Hey Jarvis".
 *   mute     — stop listening for the wake word at all (the hotkey still works).
 *   quit     — close VAS entirely. Asks first.
 *   lockdown — refuse every action until unlocked; talking still works.
 *   unlock   — lift lockdown. Asks first, and wants the owner's voice.
 */
export const kill_switch = {
  name: 'kill_switch',
  description: 'Sleep, mute, quit, lock down or unlock.',
  tier: 'free',
  params: { mode: z.enum(['sleep', 'mute', 'quit', 'lockdown', 'unlock']) },
  async run({ mode }, ctx) {
    switch (mode) {
      case 'sleep':
        return { say: 'Okay.', after: 'dormant' }
      case 'mute':
        ctx.send({ type: 'app', op: 'mute' })
        return { say: "I've stopped listening for my name. Use the hotkey when you need me.", after: 'dormant' }
      case 'quit': {
        const ok = await ctx.gate.check('jarvis.quit', { prompt: 'Shut down VAS completely?' })
        if (!ok.allowed) return { say: ok.reason }
        // After this turn's words have been spoken, not in the middle of them.
        ctx.afterTurn(() => ctx.send({ type: 'app', op: 'quit' }))
        return { say: 'Shutting down. See you later.' }
      }
      case 'lockdown': {
        const p = await loadPermissions()
        p.lockdown = true
        await savePermissions(p)
        ctx.audit({ kind: 'lockdown', name: 'on' })
        return { say: 'Locked down. I will not touch anything until you say unlock.' }
      }
      case 'unlock': {
        const p = await loadPermissions()
        if (!p.lockdown) return { say: "I'm not locked down." }
        const ok = await ctx.gate.check('jarvis.unlock', { prompt: 'Lift the lockdown?' })
        if (!ok.allowed) return { say: ok.reason }
        p.lockdown = false
        await savePermissions(p)
        ctx.audit({ kind: 'lockdown', name: 'off' })
        return { say: 'Unlocked.' }
      }
    }
  },
}

/**
 * "Learn my voice" opens the enrollment screen; "forget my voice" deletes the
 * voiceprint (asking first — it switches off the check that keeps other
 * people and the TV from giving JARVIS orders).
 */
export const voice_setup = {
  name: 'voice_setup',
  description: "Learn or forget the owner's voice.",
  tier: 'free',
  params: { mode: z.enum(['enroll', 'forget']) },
  async run({ mode }, ctx) {
    if (mode === 'enroll') {
      ctx.send({ type: 'app', op: 'enroll' })
      return { say: 'Sure — read each line on screen out loud.' }
    }
    if (!loadSpeaker()) return { say: "I haven't learned your voice yet." }
    const ok = await ctx.gate.check('voice.forget', { prompt: 'Forget your voice? Anyone could talk to me again.' })
    if (!ok.allowed) return { say: ok.reason }
    forgetSpeaker()
    ctx.voiceChanged()
    return { say: "Done — I've forgotten your voice." }
  },
}
