import { z } from 'zod'
import { join } from 'node:path'
import { createCatalog } from '../../os/catalog.mjs'
import { resolveApp } from '../../os/resolve.mjs'
import { closeApp, isRunning, launchApp, processNamesFor } from '../../os/launch.mjs'
import { loadApps, saveApps } from '../../gate.mjs'
import { dataDir } from '../../store/files.mjs'

/**
 * Windows apps, by voice.
 *
 * The list of apps is the Start menu (Get-StartApps, cached for a day and
 * re-read in the background once it is older). A spoken name is matched
 * against it — aliases you have taught, the usual nicknames ("vs code",
 * "chrome", "cmd"), then the names themselves. Opening asks the first time for
 * each app and remembers your yes; risky ones (a terminal, the registry
 * editor, admin consoles) ask every time; closing always asks, because
 * unsaved work goes with it.
 */

/**
 * The Windows side of these neurons. A neuron context may bring its own
 * (`ctx.os`, any subset of these): the tests hand in a made-up Start menu and
 * a launcher that only takes notes, so nothing on the PC is ever opened.
 */
const WINDOWS = {
  catalog: createCatalog({ cachePath: () => join(dataDir(), 'apps-catalog.json') }),
  launchApp,
  closeApp,
  processNamesFor,
  isRunning,
  /** How long a launched app gets to show up before the launch is called failed. */
  launchCheckMs: 8000,
}
const osOf = (ctx) => (ctx?.os ? { ...WINDOWS, ...ctx.os } : WINDOWS)

/** The Start menu, for anything outside these neurons. */
export async function catalog({ refresh = false } = {}) {
  return refresh ? WINDOWS.catalog.refresh() : WINDOWS.catalog.get()
}

/**
 * Re-read a day-old Start menu in the background — once now, then hourly —
 * so no spoken command ever waits on PowerShell for it. Returns a stop
 * function.
 */
export const keepCatalogFresh = () => WINDOWS.catalog.start()

/** Words that mean a web page rather than an app. */
const SITE = /(\bdot com\b|\.com\b|\.org\b|\.in\b|\.io\b|\byoutube\b|\bgmail\b|\bgoogle (docs|drive|calendar|maps)\b|\bgithub\b)/i

/**
 * The app a spoken name means, asking when two fit equally well.
 * @returns {Promise<{ app: object } | { fallthrough: true } | { say: string }>}
 */
async function find(spoken, ctx) {
  const os = osOf(ctx)
  const [cat, apps] = await Promise.all([os.catalog.get(), loadApps()])
  let { best, ambiguous } = resolveApp(spoken, cat, { aliases: apps.aliases })
  if (!best) {
    // Installed since the Start menu was last read? Look once more — at most
    // every ten minutes, so a run of questions meant for Claude doesn't cost
    // a PowerShell call each.
    const fresh = await os.catalog.afterMiss()
    if (fresh) ({ best, ambiguous } = resolveApp(spoken, fresh, { aliases: apps.aliases }))
  }
  if (!best) return { fallthrough: true }
  if (!ambiguous) return { app: best.app }
  const names = ambiguous.map((c) => c.app.name)
  const answer = await ctx.choose(`Which one — ${names.slice(0, -1).join(', ')} or ${names.at(-1)}?`, names)
  if (!answer) return { say: "Okay, I'll leave it." }
  const chosen = ambiguous.find((c) => c.app.name === answer).app
  // Next time the same words mean the same app, without asking.
  apps.aliases[spoken.toLowerCase().trim()] = chosen.appId
  await saveApps(apps)
  return { app: chosen }
}

/**
 * Explorer exits with 1 whether the app started or not, so "Opening X." is
 * said at once and checked afterwards: if none of the app's processes is
 * running eight seconds later, the user hears that it didn't open. An app
 * whose process is unknown is taken on trust, and "couldn't ask Windows" is
 * never reported as a failure.
 */
function checkLaunch(app, names, ctx, os) {
  if (!names.length) return
  const check = async () => {
    if ((await os.isRunning(names)) !== false) return
    ctx.audit({ kind: 'app', name: 'open', args: { app: app.name, appId: app.appId }, ok: false, reason: 'not running after launch' })
    // There is no turn to answer by now, so it goes out as a notice, which
    // the face speaks once it is free.
    ctx.send({ type: 'notice', text: `${app.name} doesn't seem to have opened.` })
  }
  const timer = setTimeout(() => check().catch((err) => console.warn(`[jarvis] launch check failed: ${err.message}`)), os.launchCheckMs)
  timer.unref?.()
}

export const open_app = {
  name: 'open_app',
  description: 'Open a Windows app by name (asks the first time for each app).',
  tier: 'remember',
  params: { app: z.string().min(1).max(80) },
  async run({ app: spoken }, ctx) {
    if (SITE.test(spoken)) return ctx.run('chrome_open', { site: spoken })
    const os = osOf(ctx)
    const found = await find(spoken, ctx)
    if (!found.app) return found
    const { app } = found
    const risky = app.risk === 'high'
    const verdict = await ctx.gate.check(risky ? 'app.open.risky' : 'app.open', {
      subject: app.appId,
      subjectName: app.name,
      prompt: risky
        ? `${app.name} can change your system. Open it?`
        : `I haven't opened ${app.name} for you before. Open it, and remember that's okay?`,
    })
    if (!verdict.allowed) return { say: verdict.reason, stop: true }
    const r = await os.launchApp(app)
    ctx.audit({ kind: 'app', name: 'open', args: { app: app.name, appId: app.appId }, ok: r.ok, reason: r.reason })
    if (!r.ok) return { say: r.reason, stop: true }
    const apps = await loadApps()
    const learned = os.processNamesFor(app)
    if (learned.length) {
      apps.process[app.appId] = learned
      await saveApps(apps)
    }
    checkLaunch(app, apps.process[app.appId] ?? [], ctx, os)
    return { say: `Opening ${app.name}.` }
  },
}

export const focus_app = {
  name: 'focus_app',
  description: 'Bring an open app to the front.',
  tier: 'remember',
  params: { app: z.string().min(1).max(80) },
  async run({ app: spoken }, ctx) {
    const found = await find(spoken, ctx)
    if (!found.app) return found
    const { app } = found
    const verdict = await ctx.gate.check('app.focus', {
      subject: app.appId,
      subjectName: app.name,
      prompt: `Bring up ${app.name}?`,
    })
    if (!verdict.allowed) return { say: verdict.reason, stop: true }
    // Opening a single-instance app again brings its window forward; Windows
    // does not let a background process simply steal focus.
    const r = await osOf(ctx).launchApp(app)
    return { say: r.ok ? `Here's ${app.name}.` : r.reason }
  },
}

export const close_app = {
  name: 'close_app',
  description: 'Close a Windows app gracefully (always asks first).',
  tier: 'confirm',
  params: { app: z.string().min(1).max(80) },
  async run({ app: spoken }, ctx) {
    const os = osOf(ctx)
    const found = await find(spoken, ctx)
    if (!found.app) return found
    const { app } = found
    const apps = await loadApps()
    const names = apps.process[app.appId] ?? os.processNamesFor(app)
    if (!names.length) return { say: `I don't know which program ${app.name} runs as, so I'll leave it alone.` }
    const verdict = await ctx.gate.check('app.close', {
      subject: app.appId,
      prompt: `Close ${app.name}? Anything unsaved there could be lost.`,
    })
    if (!verdict.allowed) return { say: verdict.reason, stop: true }
    const r = await os.closeApp(names)
    ctx.audit({ kind: 'app', name: 'close', args: { app: app.name }, ok: r.ok, reason: r.reason })
    if (!r.ok) return { say: r.reason ?? `I couldn't close ${app.name}.` }
    return { say: r.closed ? `Closed ${app.name}.` : `${app.name} doesn't seem to be open.` }
  },
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * The Start menu as a blade: what you have okayed first, then everything else
 * by name, each tagged with what opening it takes — nothing, one yes, or a
 * yes every time. A risky app is never "okayed": its yes is not remembered.
 */
export function appsBlade(list, allow) {
  const okayed = (app) => app.risk !== 'high' && Boolean(allow[app.appId])
  const tag = (app) => (app.risk === 'high' ? 'asks every time' : okayed(app) ? 'okayed' : 'asks once')
  const rows = [...list]
    .sort((a, b) => Number(okayed(b)) - Number(okayed(a)) || a.name.localeCompare(b.name))
    .map((app, i) =>
      `<div class="hud-row"><span class="hud-idx">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="hud-main"><span class="hud-label">${escapeHtml(app.name)}</span></span>` +
      `<span class="hud-tag${okayed(app) ? ' hud-hot' : ''}">${tag(app)}</span></div>`,
    )
  return {
    id: `apps-${Date.now().toString(36)}`,
    title: 'APPS',
    kind: 'markup',
    html: `<div class="hud-rows">${rows.join('')}</div>`,
    size: 'tall',
    hold: 'turn',
  }
}

export const list_apps = {
  name: 'list_apps',
  description: 'Show the apps on screen, and say how many there are and which are already allowed.',
  tier: 'free',
  params: {},
  async run(_params, ctx) {
    const [cat, apps] = await Promise.all([osOf(ctx).catalog.get(), loadApps()])
    // The whole list is for reading, not hearing: it goes on a blade, and the
    // spoken answer stays a sentence or two.
    ctx.send?.({ type: 'blade', blade: appsBlade(cat.apps, apps.allow) })
    const allowed = Object.values(apps.allow).map((a) => a.name)
    const head = `You have ${cat.apps.length} apps in the Start menu — they're on screen, and I can open any of them by name.`
    return { say: allowed.length ? `${head} You've already okayed ${allowed.slice(0, 8).join(', ')}.` : head }
  },
}

export const refresh_apps = {
  name: 'refresh_apps',
  description: 'Re-read the Start menu, for newly installed apps.',
  tier: 'free',
  params: {},
  async run(_params, ctx) {
    const cat = await osOf(ctx).catalog.refresh()
    return { say: `Done — ${cat.apps.length} apps.` }
  },
}
