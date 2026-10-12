import { z } from 'zod'
import { readJson, writeJsonAtomic } from './store/files.mjs'
import { audit as defaultAudit } from './store/audit.mjs'

/**
 * The permission gate: what JARVIS may do without asking, what he asks once,
 * and what he asks every time.
 *
 *   free      — runs. Reading a page, opening a site, the time.
 *   remember  — asks the first time for each thing (each app), and a yes is
 *               kept in apps.json. "Open Spotify" asks once, then just opens.
 *   confirm   — asks every time. Closing an app, clicking or typing in your
 *               signed-in browser, saving a routine or a correction, anything
 *               risky (a terminal, the registry editor).
 *   deny      — never.
 *
 * Asking is spoken: JARVIS says the question, you say yes or no (or click),
 * and the answer is judged here, on the raw words — not by the model, and not
 * after any learned correction has rewritten them. Every decision is written
 * to the audit log.
 *
 * Voice is a bad interface for a dialog, so the question has to be short and
 * the answer forgiving; it is also a dangerous one, because a TV can say
 * "yes". So: one question at a time, a timeout that means no, deny words
 * checked before accept words, and (once a voice is enrolled) only the owner's
 * yes counts.
 */

export const Tier = z.enum(['free', 'remember', 'confirm', 'deny'])

export const DEFAULT_TIERS = {
  'app.open': 'remember',
  'app.focus': 'remember',
  'app.open.risky': 'confirm',
  'app.close': 'confirm',
  'chrome.read': 'free',
  'chrome.navigate': 'free',
  'chrome.act': 'confirm',
  'routine.save': 'confirm',
  'routine.forget': 'confirm',
  'correction.save': 'confirm',
  'jarvis.quit': 'confirm',
  'jarvis.unlock': 'confirm',
  'camera.hidden': 'confirm',
  'voice.forget': 'confirm',
}

/**
 * Whose yes counts is not in here: it is config.json's owner.require, the one
 * owner setting the voice pipeline reads too (an old requireOwner in this file
 * is moved there at startup, see migrateOwnerRequirement). Unknown keys are
 * dropped on read, so an old file still loads.
 */
const PermissionsSchema = z.object({
  version: z.literal(1).default(1),
  /** A click on the on-screen Confirm button counts as a yes. */
  allowClickConfirm: z.boolean().default(true),
  /** Lockdown: nothing but unlock runs until it is lifted. */
  lockdown: z.boolean().default(false),
  tiers: z.record(z.string(), Tier).default({}),
})

const AppsSchema = z.object({
  /** Apps you have said yes to opening, by AppID. */
  allow: z.record(z.string(), z.object({ name: z.string(), grantedAt: z.string() })).default({}),
  /** Your own names for apps: spoken alias -> AppID. */
  aliases: z.record(z.string(), z.string()).default({}),
  /** Process names seen for an app, so it can be closed again. */
  process: z.record(z.string(), z.array(z.string())).default({}),
})

export const loadPermissions = () => readJson('permissions.json', PermissionsSchema)
export const savePermissions = (p) => writeJsonAtomic('permissions.json', PermissionsSchema.parse(p))
export const loadApps = () => readJson('apps.json', AppsSchema)
export const saveApps = (a) => writeJsonAtomic('apps.json', AppsSchema.parse(a))

/**
 * Yes, no, or neither — judged on the words as heard.
 *
 * Deny words win: "yes — no, wait, cancel" is a no. Accept needs a clear
 * opener or the word "confirm"; anything else is unclear and gets asked again.
 */
export function parseConfirm(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim()
  if (!t) return 'unclear'
  if (/\b(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|abort|wait)\b/.test(t)) return 'no'
  if (/^(yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|do it|confirm(ed)?)\b/.test(t)) return 'yes'
  if (/\bconfirm(ed)?\b/.test(t)) return 'yes'
  return 'unclear'
}

/**
 * One gate per connection.
 *
 * @param {object} deps
 * @param {(kind: string, args: object, timeoutMs?: number) => Promise<any>} deps.ask
 *        the bridge's ask-the-face round trip (server.mjs)
 * @param {(id: string) => void} [deps.cancel] tell the face a question is moot
 * @param {(entry: object) => void} [deps.audit]
 * @param {() => { verdict: 'owner'|'other'|'unknown'|'unenrolled', ownerRecently?: boolean }} [deps.owner]
 *        whose voice the latest segment was in, and whether the owner spoke in
 *        the last minute (so a short "yes" too brief to judge still counts
 *        right after the owner gave the command)
 * @param {() => 'all'|'actions'|'off'} [deps.requireOwner] the owner requirement
 *        (config.json owner.require), asked on every check so a change in
 *        Settings applies to the very next question. 'all' and 'actions' both
 *        want the owner's yes here; they differ only in what is heard at all.
 */
export function createGate({
  ask,
  cancel = () => {},
  audit = defaultAudit,
  owner = () => ({ verdict: 'unenrolled' }),
  requireOwner = () => 'all',
}) {
  let queue = Promise.resolve()
  const pending = new Set()
  // Bumped by abortAll. A question still waiting its turn in the queue when
  // the user interrupts must never be asked afterwards, so each one notes the
  // generation it was queued in and stands down if that has passed.
  let generation = 0

  /** Ask one question, at most twice; resolves to { answer, source, owner }. */
  async function confirm({ prompt, action, subject }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply
      try {
        reply = await ask(
          'confirm',
          { prompt: attempt ? `Sorry — ${prompt} Yes or no?` : prompt, action, subject, timeoutMs: 25_000 },
          30_000,
        )
      } catch {
        return { answer: 'timeout', source: 'none' }
      }
      if (reply?.cancelled) return { answer: 'cancelled', source: 'none' }
      const source = reply?.source === 'click' ? 'click' : 'voice'
      const answer = source === 'click' ? (reply.approved ? 'yes' : 'no') : parseConfirm(reply?.text)
      if (answer !== 'unclear') return { answer, source, owner: reply?.owner }
    }
    return { answer: 'unclear', source: 'voice' }
  }

  /**
   * May `action` run? Asks when the tier says so.
   *
   * @param {string} action   e.g. 'app.open', 'chrome.act'
   * @param {{ subject?: string, subjectName?: string, prompt: string, args?: object }} details
   * @returns {Promise<{ allowed: boolean, reason?: string }>}
   */
  async function check(action, { subject, subjectName, prompt, args } = {}) {
    const permissions = await loadPermissions()
    const tier =
      permissions.lockdown && action !== 'jarvis.unlock'
        ? 'lockdown'
        : permissions.tiers[action] ?? DEFAULT_TIERS[action] ?? 'confirm'
    const record = (decision, extra = {}) =>
      audit({ kind: 'gate', name: action, args: { subject, ...args }, tier, decision, ...extra })

    if (tier === 'lockdown') {
      record('deny', { reason: 'lockdown' })
      return { allowed: false, reason: 'I am locked down. Say "unlock" first.' }
    }
    if (tier === 'free') {
      record('allow')
      return { allowed: true }
    }
    if (tier === 'deny') {
      record('deny')
      return { allowed: false, reason: 'That is switched off in my permissions.' }
    }
    if (tier === 'remember' && subject) {
      const apps = await loadApps()
      if (apps.allow[subject]) {
        record('allow', { reason: 'remembered' })
        return { allowed: true }
      }
    }

    // One question at a time: a second gated action waits for the first.
    const queuedIn = generation
    const turn = queue.then(async () => {
      if (queuedIn !== generation) return { answer: 'cancelled', source: 'none' }
      const id = Symbol(action)
      pending.add(id)
      try {
        return await confirm({ prompt, action, subject })
      } finally {
        pending.delete(id)
      }
    })
    queue = turn.catch(() => {})
    const { answer, source, owner: ownerVerdict } = await turn

    // Once a voice is enrolled, only the owner's spoken yes counts; a click
    // means someone is at the keyboard, which is its own proof.
    const who = ownerVerdict ?? owner().verdict
    const ownerOk =
      requireOwner() === 'off' ||
      source === 'click' ||
      who === 'owner' ||
      who === 'unenrolled' ||
      (who === 'unknown' && owner().ownerRecently === true)
    const clickOk = source !== 'click' || permissions.allowClickConfirm
    const allowed = answer === 'yes' && ownerOk && clickOk

    record(allowed ? 'allow' : 'deny', { reason: allowed ? answer : !ownerOk ? 'not-owner' : answer, owner: { verdict: who }, source })
    if (allowed && tier === 'remember' && subject) {
      const apps = await loadApps()
      apps.allow[subject] = { name: subjectName ?? subject, grantedAt: new Date().toISOString() }
      await saveApps(apps)
    }
    if (allowed) return { allowed: true }
    const reason =
      answer === 'timeout' ? 'No answer, so I left it.' :
      answer === 'cancelled' ? 'Cancelled.' :
      !ownerOk ? 'Only your voice can approve that.' :
      'Okay, I won\'t.'
    return { allowed: false, reason }
  }

  return {
    check,
    /**
     * Drop every pending question (interrupt, disconnect, standing down): the
     * one on screen is cancelled, and any still queued behind it are never
     * asked.
     */
    abortAll() {
      generation++
      cancel('*')
      pending.clear()
    },
  }
}
