import { z } from 'zod'
import { join } from 'node:path'
import { loadCatalog } from '../../os/catalog.mjs'
import { resolveApp } from '../../os/resolve.mjs'
import { closeApp, launchApp, processNamesFor } from '../../os/launch.mjs'
import { loadApps, saveApps } from '../../gate.mjs'
import { dataDir } from '../../store/files.mjs'

/**
 * Windows apps, by voice.
 *
 * The list of apps is the Start menu (Get-StartApps, cached for a day). A
 * spoken name is matched against it — aliases you have taught, the usual
 * nicknames ("vs code", "chrome", "cmd"), then the names themselves. Opening
 * asks the first time for each app and remembers your yes; risky ones (a
 * terminal, the registry editor, admin consoles) ask every time; closing
 * always asks, because unsaved work goes with it.
 */

const catalogPath = () => join(dataDir(), 'apps-catalog.json')

export async function catalog({ refresh = false } = {}) {
  return loadCatalog({ cachePath: catalogPath(), ...(refresh ? { maxAgeMs: 0 } : {}) })
}

/** Words that mean a web page rather than an app. */
const SITE = /(\bdot com\b|\.com\b|\.org\b|\.in\b|\.io\b|\byoutube\b|\bgmail\b|\bgoogle (docs|drive|calendar|maps)\b|\bgithub\b)/i

/**
 * The app a spoken name means, asking when two fit equally well.
 * @returns {Promise<{ app: object } | { fallthrough: true } | { say: string }>}
 */
async function find(spoken, ctx) {
  const [cat, apps] = await Promise.all([catalog(), loadApps()])
  const { best, ambiguous } = resolveApp(spoken, cat, { aliases: apps.aliases })
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

export const open_app = {
  name: 'open_app',
  description: 'Open a Windows app by name (asks the first time for each app).',
  tier: 'remember',
  params: { app: z.string().min(1).max(80) },
  async run({ app: spoken }, ctx) {
    if (SITE.test(spoken)) return ctx.run('chrome_open', { site: spoken })
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
    const r = await launchApp(app)
    ctx.audit({ kind: 'app', name: 'open', args: { app: app.name, appId: app.appId }, ok: r.ok, reason: r.reason })
    if (!r.ok) return { say: r.reason, stop: true }
    const learned = processNamesFor(app)
    if (learned.length) {
      const apps = await loadApps()
      apps.process[app.appId] = learned
      await saveApps(apps)
    }
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
    const r = await launchApp(app)
    return { say: r.ok ? `Here's ${app.name}.` : r.reason }
  },
}

export const close_app = {
  name: 'close_app',
  description: 'Close a Windows app gracefully (always asks first).',
  tier: 'confirm',
  params: { app: z.string().min(1).max(80) },
  async run({ app: spoken }, ctx) {
    const found = await find(spoken, ctx)
    if (!found.app) return found
    const { app } = found
    const apps = await loadApps()
    const names = apps.process[app.appId] ?? processNamesFor(app)
    if (!names.length) return { say: `I don't know which program ${app.name} runs as, so I'll leave it alone.` }
    const verdict = await ctx.gate.check('app.close', {
      subject: app.appId,
      prompt: `Close ${app.name}? Anything unsaved there could be lost.`,
    })
    if (!verdict.allowed) return { say: verdict.reason, stop: true }
    const r = await closeApp(names)
    ctx.audit({ kind: 'app', name: 'close', args: { app: app.name }, ok: r.ok, reason: r.reason })
    if (!r.ok) return { say: r.reason ?? `I couldn't close ${app.name}.` }
    return { say: r.closed ? `Closed ${app.name}.` : `${app.name} doesn't seem to be open.` }
  },
}

export const list_apps = {
  name: 'list_apps',
  description: 'Say how many apps there are and which ones are already allowed.',
  tier: 'free',
  params: {},
  async run() {
    const [cat, apps] = await Promise.all([catalog(), loadApps()])
    const allowed = Object.values(apps.allow).map((a) => a.name)
    const head = `You have ${cat.apps.length} apps in the Start menu, and I can open any of them by name.`
    return { say: allowed.length ? `${head} You've already okayed ${allowed.slice(0, 8).join(', ')}.` : head }
  },
}

export const refresh_apps = {
  name: 'refresh_apps',
  description: 'Re-read the Start menu, for newly installed apps.',
  tier: 'free',
  params: {},
  async run() {
    const cat = await catalog({ refresh: true })
    return { say: `Done — ${cat.apps.length} apps.` }
  },
}
