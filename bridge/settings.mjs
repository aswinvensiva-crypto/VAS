import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { DEFAULT_TIERS, Tier, loadApps, loadPermissions, saveApps, savePermissions } from './gate.mjs'
import { saveCorrections, validateCorrection } from './corrections/store.mjs'
import { USER_BRAIN } from './neurons/brain.mjs'
import { audit as defaultAudit } from './store/audit.mjs'
import { readConfigStrict, updateConfig } from './store/config.mjs'
import { dataDir, readRawJson, watchData, writeTextAtomic } from './store/files.mjs'

/**
 * Settings: everything VAS has learned about you and been allowed to do, in
 * one place the face's Settings drawer can read and change.
 *
 *   GET    /settings                  everything below, at once
 *   POST   /settings/general          your name, speech engine and language,
 *                                     the owner requirement, preferred voice
 *   POST   /settings/corrections      { heard, meant }  learn one by hand
 *   DELETE /settings/corrections      { heard }
 *   DELETE /settings/apps/allow       { appId }         ask again next time
 *   POST   /settings/apps/aliases     { alias, appId }
 *   DELETE /settings/apps/aliases     { alias }
 *   DELETE /settings/routines         { name }          forget a taught routine
 *   POST   /settings/permissions      { tiers?, lockdown?, allowClickConfirm? }
 *
 * Learning your voice and forgetting it stay on the /voice endpoints, which
 * the drawer reuses.
 *
 * Every change is validated with the same schemas the files are read with,
 * written atomically, applied at once — nothing waits for a restart — and
 * written to the audit log. A mutation answers with the whole new picture, so
 * the drawer never shows a list the bridge no longer has.
 *
 * These change what JARVIS may do without asking, so they only accept JSON:
 * a form posted from some other page cannot send that content type without a
 * CORS preflight, and the preflight is refused for any origin but our own.
 */

/** What each permission-gated action is, in words for the Permissions tab. */
const ACTION_LABELS = {
  'app.open': 'Open an app',
  'app.focus': 'Switch to an app',
  'app.open.risky': 'Open a risky app (terminal, registry, admin tools)',
  'app.close': 'Close an app',
  'chrome.read': 'Read your Chrome tabs',
  'chrome.navigate': 'Open sites and searches in Chrome',
  'chrome.act': 'Click or type in Chrome',
  'chrome.leave': 'Go to another site after reading a page (guards what was read)',
  'routine.save': 'Save a routine',
  'routine.forget': 'Forget a routine',
  'correction.save': 'Learn a correction',
  'jarvis.quit': 'Shut down VAS',
  'jarvis.unlock': 'Lift a lockdown',
  'settings.weaken': 'Loosen a safeguard here while locked down or voice-only',
  'camera.hidden': 'Use the camera while VAS is hidden',
  'voice.forget': 'Forget your voice',
}

const GeneralPatch = z
  .object({
    userName: z.string().trim().min(1).max(40),
    stt: z
      .object({
        engine: z.enum(['auto', 'local', 'scribe']),
        /** A Whisper language code ("en", "ml", "yue"), or auto-detect. */
        language: z.string().regex(/^(auto|[a-z]{2,3})$/, 'a language code like "en", or "auto"'),
      })
      .partial()
      .strict(),
    owner: z.object({ require: z.enum(['actions', 'all', 'off']) }).strict(),
    /** null goes back to the best-ranked installed voice. */
    tts: z.object({ voice: z.string().trim().min(1).max(200).nullable() }).strict(),
  })
  .partial()
  .strict()

const Phrase = z.string().trim().min(1).max(60)
const CorrectionBody = z.object({ heard: z.string(), meant: z.string() })
const AppBody = z.object({ appId: z.string().min(1).max(300) })
const AliasBody = z.object({ alias: Phrase, appId: z.string().min(1).max(300) })
const RoutineBody = z.object({ name: z.string().min(1).max(200) })
const PermissionsPatch = z
  .object({
    lockdown: z.boolean(),
    allowClickConfirm: z.boolean(),
    /** An action's tier; null puts it back to the built-in default. */
    tiers: z.record(z.string().min(1).max(60), Tier.nullable()),
  })
  .partial()
  .strict()

/** An error the drawer can show as it is. */
const refuse = (status, reason) => Object.assign(new Error(reason), { status })

/** How much a tier holds back, so a change can be told to loosen or tighten. */
const TIER_RANK = { free: 0, remember: 1, confirm: 2, deny: 3 }
const TIER_WORDS = { free: 'just do it', remember: 'ask once', confirm: 'ask every time', deny: 'never' }
/** The same for whose voice counts. */
const OWNER_RANK = { off: 0, actions: 1, all: 2 }
const OWNER_WORDS = { off: 'anyone, with no voice check', actions: 'anyone talk', all: 'only your voice' }

const aliasKey = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** "open_app: { app: notepad }" as "open app notepad". */
function describeStep(step) {
  const [name, params] = Object.entries(step ?? {})[0] ?? ['?', null]
  const values = Object.values(params ?? {}).filter((v) => typeof v === 'string' || typeof v === 'number')
  return [name.replace(/_/g, ' '), ...values].join(' ')
}

const orderText = (signal) => (typeof signal?.order === 'string' ? signal.order : signal?.order?.text)

/** App names from the cached Start-menu catalog, without asking Windows again. */
async function catalogNames() {
  try {
    const cached = await readRawJson('apps-catalog.json')
    return new Map((cached?.apps ?? []).map((a) => [a.appId, a.name]))
  } catch {
    return new Map()
  }
}

/**
 * @param {object} deps
 * @param {object} deps.config       the bridge's live config, updated in place
 * @param {{ setConfig(c: object): void, status(): { speaker: boolean } }} deps.voice
 * @param {object} deps.corrections  the live corrections (bridge/corrections/store.mjs)
 * @param {{ userSynapses(): object[], reload(): boolean, problem(text: string): string | null }} deps.brain
 * @param {() => object | null} deps.speaker  the enrolled voiceprint, if any
 * @param {() => { check: Function } | null} [deps.gate]  the open face's
 *        permission gate, which can ask out loud; null when no face is open
 */
export function createSettings({ config, voice, corrections, brain, speaker, gate = () => null, audit = defaultAudit }) {
  /**
   * Loosening a safeguard from here, once the owner has asked for more than a
   * click: lockdown on, or "clicking Confirm counts as a yes" turned off. The
   * drawer must not be the way around either — anyone at the keyboard can open
   * it — so the change is put to the permission gate like any action: under
   * lockdown only lifting it can be asked at all ("jarvis.unlock"), and with
   * clicks off only a spoken yes (the owner's, once a voice is enrolled)
   * approves. Otherwise a click here is as good as a click on Confirm, and
   * nothing is asked.
   */
  async function approved(action, prompt) {
    const g = gate()
    if (!g) throw refuse(409, 'Open VAS so I can ask you about that first.')
    const verdict = await g.check(action, { prompt, args: { from: 'settings' } })
    if (!verdict.allowed) throw refuse(403, verdict.reason ?? 'Not changed.')
  }
  const guarded = (p) => p.lockdown || !p.allowClickConfirm

  /**
   * Make a config the one in effect. In place, because the voice pipeline,
   * the gate and /health all hold this same object; then the voice engine
   * rebuilds what it derives from it (the wake-word file).
   */
  function applyConfig(next) {
    for (const key of Object.keys(config)) if (!Object.hasOwn(next, key)) delete config[key]
    Object.assign(config, next)
    voice.setConfig(config)
  }

  async function snapshot() {
    const [apps, permissions, names] = await Promise.all([loadApps(), loadPermissions(), catalogNames()])
    const nameOf = (appId) => apps.allow[appId]?.name ?? names.get(appId) ?? appId
    const s = speaker()
    const tiers = { ...DEFAULT_TIERS, ...permissions.tiers }
    return {
      general: {
        userName: config.userName,
        stt: { engine: config.stt.engine, language: config.stt.language },
        owner: { require: config.owner.require },
        tts: { voice: config.tts?.voice ?? null },
        hotkey: config.hotkey,
      },
      corrections: corrections
        .list()
        .map(({ heard, meant, count, createdAt, source }) => ({ heard, meant, count, createdAt, source }))
        .sort((a, b) => a.heard.localeCompare(b.heard)),
      apps: {
        allowed: Object.entries(apps.allow)
          .map(([appId, a]) => ({ appId, name: a.name, grantedAt: a.grantedAt }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        aliases: Object.entries(apps.aliases)
          .map(([alias, appId]) => ({ alias, appId, name: nameOf(appId) }))
          .sort((a, b) => a.alias.localeCompare(b.alias)),
      },
      routines: brain.userSynapses().map((syn) => ({
        name: syn.name,
        triggers: syn.signals.map(orderText).filter(Boolean),
        steps: syn.neurons.map(describeStep),
        source: syn.source ?? null,
        created: syn.created ?? null,
      })),
      permissions: {
        lockdown: permissions.lockdown,
        allowClickConfirm: permissions.allowClickConfirm,
        actions: Object.keys(tiers).map((action) => ({
          action,
          label: ACTION_LABELS[action] ?? action,
          tier: tiers[action],
          default: DEFAULT_TIERS[action] ?? 'confirm',
        })),
      },
      voice: {
        available: voice.status().speaker,
        enrolled: Boolean(s),
        clips: s?.clips ?? 0,
        enrolledAt: s?.enrolledAt ?? null,
      },
    }
  }

  async function general(patch) {
    const wanted = patch.owner?.require
    if (wanted && OWNER_RANK[wanted] < OWNER_RANK[config.owner.require] && guarded(await loadPermissions())) {
      await approved('settings.weaken', `Let ${OWNER_WORDS[wanted]}?`)
    }
    applyConfig(await updateConfig(patch))
    audit({ kind: 'settings', name: 'general', args: patch })
  }

  async function addCorrection({ heard, meant }) {
    const reason = validateCorrection({ heard, meant })
    if (reason) throw refuse(400, reason)
    const entry = corrections.add({ heard, meant, source: 'settings' })
    await saveCorrections(corrections)
    audit({ kind: 'settings', name: 'correction.add', args: { heard: entry.heard, meant: entry.meant } })
  }

  async function removeCorrection({ heard }) {
    if (!corrections.remove(heard)) throw refuse(404, `There is no correction for "${heard}".`)
    await saveCorrections(corrections)
    audit({ kind: 'settings', name: 'correction.remove', args: { heard } })
  }

  async function revokeApp({ appId }) {
    const apps = await loadApps()
    const granted = apps.allow[appId]
    if (!granted) throw refuse(404, 'That app is not on the allowed list.')
    delete apps.allow[appId]
    await saveApps(apps)
    audit({ kind: 'settings', name: 'app.revoke', args: { appId, app: granted.name } })
  }

  async function addAlias({ alias, appId }) {
    const apps = await loadApps()
    // Only an app VAS already knows by that ID: one you allowed, or one an
    // existing alias names. A made-up ID would just be an alias to nothing.
    const known = Object.hasOwn(apps.allow, appId) || Object.values(apps.aliases).includes(appId)
    if (!known) throw refuse(400, 'Pick one of the apps you have allowed.')
    const key = aliasKey(alias)
    apps.aliases[key] = appId
    await saveApps(apps)
    audit({ kind: 'settings', name: 'alias.add', args: { alias: key, appId } })
  }

  async function removeAlias({ alias }) {
    const apps = await loadApps()
    const key = Object.keys(apps.aliases).find((k) => aliasKey(k) === aliasKey(alias))
    if (!key) throw refuse(404, `There is no alias "${alias}".`)
    delete apps.aliases[key]
    await saveApps(apps)
    audit({ kind: 'settings', name: 'alias.remove', args: { alias: key } })
  }

  /**
   * Taught routines live in brain.yml next to anything written there by hand,
   * so the file is edited as a document — comments and the user's own layout
   * survive — and the brain reloads it straight away.
   */
  async function deleteRoutine({ name }) {
    let text
    try {
      text = await readFile(join(dataDir(), USER_BRAIN), 'utf8')
    } catch {
      throw refuse(404, 'You have no routines yet.')
    }
    const doc = YAML.parseDocument(text)
    // Valid YAML is not enough: a file the brain refuses (an unknown neuron
    // somewhere in it) is not the one in effect, and editing it would report
    // a routine gone that keeps running.
    if (doc.errors.length || brain.problem?.(text)) {
      throw refuse(409, `${USER_BRAIN} has a mistake in it; fix it by hand first.`)
    }
    const list = doc.get('synapses')
    const index = (list?.items ?? []).findIndex((item) => item?.toJSON?.()?.name === name)
    if (index < 0) throw refuse(404, `There is no routine called "${name}".`)
    list.delete(index)
    await writeTextAtomic(USER_BRAIN, String(doc))
    if (brain.reload() === false) throw refuse(500, `${USER_BRAIN} was changed but did not load; it is in the log.`)
    audit({ kind: 'settings', name: 'routine.delete', args: { routine: name } })
  }

  async function permissions(patch) {
    let p = await loadPermissions()
    for (const action of Object.keys(patch.tiers ?? {})) {
      if (!Object.hasOwn(DEFAULT_TIERS, action) && !Object.hasOwn(p.tiers, action)) {
        throw refuse(400, `"${action}" is not an action JARVIS asks about.`)
      }
    }
    if (p.lockdown && patch.lockdown === false) {
      await approved('jarvis.unlock', 'Lift the lockdown?')
      // Lifted on its own first, so anything else in this change is judged
      // as it would be after unlocking — not refused for the lockdown it ends.
      p.lockdown = false
      await savePermissions(p)
      audit({ kind: 'settings', name: 'permissions', args: { lockdown: false } })
      p = await loadPermissions()
    }
    if (guarded(p)) {
      const looser = []
      if (!p.allowClickConfirm && patch.allowClickConfirm === true) looser.push('a click approve things again')
      for (const [action, tier] of Object.entries(patch.tiers ?? {})) {
        const fallback = DEFAULT_TIERS[action] ?? 'confirm'
        const before = p.tiers[action] ?? fallback
        const after = tier ?? fallback
        if (TIER_RANK[after] < TIER_RANK[before]) looser.push(`"${ACTION_LABELS[action] ?? action}" be ${TIER_WORDS[after]}`)
      }
      if (looser.length) await approved('settings.weaken', `Let ${looser.join(', and ')}?`)
    }
    for (const [action, tier] of Object.entries(patch.tiers ?? {})) {
      if (tier === null) delete p.tiers[action]
      else p.tiers[action] = tier
    }
    if (patch.lockdown !== undefined) p.lockdown = patch.lockdown
    if (patch.allowClickConfirm !== undefined) p.allowClickConfirm = patch.allowClickConfirm
    await savePermissions(p)
    audit({ kind: 'settings', name: 'permissions', args: patch })
  }

  /** route -> [schema, change] */
  const ROUTES = {
    'POST /settings/general': [GeneralPatch, general],
    'POST /settings/corrections': [CorrectionBody, addCorrection],
    'DELETE /settings/corrections': [CorrectionBody.pick({ heard: true }), removeCorrection],
    'DELETE /settings/apps/allow': [AppBody, revokeApp],
    'POST /settings/apps/aliases': [AliasBody, addAlias],
    'DELETE /settings/apps/aliases': [z.object({ alias: Phrase }), removeAlias],
    'DELETE /settings/routines': [RoutineBody, deleteRoutine],
    'POST /settings/permissions': [PermissionsPatch, permissions],
  }

  /**
   * Changes run one at a time. Each is a read-modify-write of a whole file,
   * and two clicks in quick succession must not both read the old file and
   * have the second write throw the first one away.
   */
  let queue = Promise.resolve()
  const serially = (fn) => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  /**
   * One request. `body` is the raw request body. Resolves to [status, json],
   * or null when the path is not a settings route.
   */
  async function handle(req, pathname, body) {
    try {
      if (req.method === 'GET' && pathname === '/settings') return [200, await snapshot()]
      const route = ROUTES[`${req.method} ${pathname}`]
      if (!route) return null
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
        throw refuse(415, 'Settings take JSON.')
      }
      let json
      try {
        json = JSON.parse(String(body || '{}'))
      } catch {
        throw refuse(400, 'That was not valid JSON.')
      }
      const [schema, change] = route
      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw refuse(400, `${issue.path.join('.') || 'request'}: ${issue.message}`)
      }
      await serially(() => change(parsed.data))
      return [200, { ok: true, settings: await snapshot() }]
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issue = err.issues[0]
        return [400, { ok: false, reason: `${issue.path.join('.')}: ${issue.message}` }]
      }
      if (err.status) return [err.status, { ok: false, reason: err.message }]
      throw err
    }
  }

  /**
   * Hand edits to config.json apply while VAS runs, like the ones made here.
   * A file caught half-edited (not JSON yet, or not a valid config) is
   * reported and the settings in effect are kept until it is fixed.
   *
   * permissions.json and apps.json need no watcher: the gate and the app
   * neurons read them afresh for every decision, so an edit there already
   * counts from the next question on.
   */
  function watch() {
    return watchData('config.json', async () => {
      try {
        applyConfig(await readConfigStrict())
        console.log('[jarvis] config.json changed; applied')
      } catch (err) {
        const why = err instanceof z.ZodError ? `${err.issues[0].path.join('.')}: ${err.issues[0].message}` : err.message
        console.warn(`[jarvis] config.json changed but was not applied (${why}); keeping the current settings`)
      }
    })
  }

  return { handle, snapshot, watch }
}
