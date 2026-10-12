import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The app neurons against a made-up Start menu and a launcher that only takes
 * notes: what they ask, what they would open or close, what they show, and
 * how the catalog keeps itself fresh. Nothing here runs PowerShell, reads the
 * real Start menu or launches anything.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ROWS = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'startapps.json'), 'utf8'))

let dir
let apps
let createGate
let createCatalog
let isRunning
let APPS
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-appneurons-'))
  process.env.JARVIS_DATA_DIR = dir
  apps = await import('../../bridge/neurons/lib/apps.mjs')
  ;({ createGate } = await import('../../bridge/gate.mjs'))
  const catalogMod = await import('../../bridge/os/catalog.mjs')
  createCatalog = catalogMod.createCatalog
  APPS = catalogMod.parseStartApps(ROWS)
  ;({ isRunning } = await import('../../bridge/os/launch.mjs'))
})
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of ['permissions.json', 'apps.json', 'apps-catalog.json', 'audit.log']) rmSync(join(dir, f), { force: true })
})

const HOUR = 60 * 60 * 1000
const tick = () => new Promise((r) => setTimeout(r, 30))

/** A Start menu that is whatever the test says, with a clock the test turns. */
function fakeStartMenu(lists = [APPS]) {
  const clock = { t: 1_000_000 }
  const reads = []
  const catalog = createCatalog({
    cachePath: join(dir, 'apps-catalog.json'),
    now: () => clock.t,
    source: async () => {
      reads.push(clock.t)
      return lists[Math.min(reads.length - 1, lists.length - 1)]
    },
    log: () => {},
  })
  return { catalog, clock, reads }
}

/**
 * A neuron context with the real permission gate, a scripted face answering
 * its questions, and a Windows that records instead of acting.
 */
function harness({ answers = [], running = true, catalog = fakeStartMenu().catalog } = {}) {
  const asked = []
  const sent = []
  const audits = []
  const launched = []
  const closed = []
  const checked = []
  const gate = createGate({
    ask: async (_kind, args) => {
      asked.push(args.prompt)
      const a = answers.shift() ?? 'no'
      return typeof a === 'string' ? { text: a, source: 'voice' } : a
    },
    audit: (e) => audits.push(e),
  })
  const ctx = {
    gate,
    audit: (e) => audits.push(e),
    send: (m) => sent.push(m),
    choose: async () => null,
    run: async () => ({ say: 'not an app' }),
    os: {
      catalog,
      launchApp: async (app) => {
        launched.push(app.name)
        return { ok: true }
      },
      closeApp: async (names) => {
        closed.push(names)
        return { ok: true, closed: 1 }
      },
      isRunning: async (names) => {
        checked.push(names)
        return running
      },
      launchCheckMs: 10,
    },
  }
  return { ctx, asked, sent, audits, launched, closed, checked, answers }
}

const run = (neuron, params, ctx) => apps[neuron].run(params, ctx)

test('open: asks the first time, then opens without asking', async () => {
  const h = harness({ answers: ['yes'] })
  const first = await run('open_app', { app: 'notepad' }, h.ctx)
  assert.equal(first.say, 'Opening Notepad.')
  assert.equal(h.asked.length, 1)
  assert.match(h.asked[0], /haven't opened Notepad .*remember/)
  const second = await run('open_app', { app: 'Notepad' }, h.ctx)
  assert.equal(second.say, 'Opening Notepad.')
  assert.equal(h.asked.length, 1, 'the second open must not ask')
  assert.deepEqual(h.launched, ['Notepad', 'Notepad'])
  const saved = JSON.parse(readFileSync(join(dir, 'apps.json'), 'utf8'))
  assert.equal(saved.allow['Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'].name, 'Notepad')
  assert.deepEqual(saved.process['Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'], ['Notepad'])
})

test('open: a no opens nothing and is not remembered', async () => {
  const h = harness({ answers: ['no', 'no'] })
  assert.match((await run('open_app', { app: 'notepad' }, h.ctx)).say, /won't/)
  await run('open_app', { app: 'notepad' }, h.ctx)
  assert.equal(h.asked.length, 2)
  assert.deepEqual(h.launched, [])
})

test('close: asks every time, and "cancel" leaves the app alone', async () => {
  const h = harness({ answers: ['cancel', 'yes', 'yes'] })
  const cancelled = await run('close_app', { app: 'notepad' }, h.ctx)
  assert.match(h.asked[0], /^Close Notepad\? Anything unsaved there could be lost\.$/)
  assert.match(cancelled.say, /won't/)
  assert.equal(cancelled.stop, true)
  assert.deepEqual(h.closed, [], 'nothing was asked to close')
  assert.equal((await run('close_app', { app: 'notepad' }, h.ctx)).say, 'Closed Notepad.')
  assert.equal((await run('close_app', { app: 'notepad' }, h.ctx)).say, 'Closed Notepad.')
  assert.equal(h.asked.length, 3, 'a yes to closing is never remembered')
  assert.deepEqual(h.closed, [['Notepad'], ['Notepad']])
})

test('close: an on-screen Cancel is a no as well', async () => {
  const h = harness({ answers: [{ source: 'click', approved: false }] })
  await run('close_app', { app: 'notepad' }, h.ctx)
  assert.deepEqual(h.closed, [])
})

test('a high-risk app asks every time, even after a yes', async () => {
  const h = harness({ answers: ['yes', 'yes', 'no'] })
  await run('open_app', { app: 'command prompt' }, h.ctx)
  await run('open_app', { app: 'command prompt' }, h.ctx)
  const refused = await run('open_app', { app: 'command prompt' }, h.ctx)
  assert.equal(h.asked.length, 3)
  assert.ok(h.asked.every((p) => /Command Prompt can change your system\. Open it\?/.test(p)), h.asked.join(' | '))
  assert.deepEqual(h.launched, ['Command Prompt', 'Command Prompt'])
  assert.match(refused.say, /won't/)
  const saved = JSON.parse(readFileSync(join(dir, 'apps.json'), 'utf8'))
  assert.equal(Object.keys(saved.allow).length, 0, 'a risky yes is not remembered')
})

test('a launch whose app never shows up is reported afterwards, as a notice', async () => {
  const h = harness({ answers: ['yes'], running: false })
  const r = await run('open_app', { app: 'notepad' }, h.ctx)
  assert.equal(r.say, 'Opening Notepad.', 'said at once, not after the check')
  assert.deepEqual(h.sent, [])
  await tick()
  assert.deepEqual(h.checked, [['Notepad']])
  assert.deepEqual(h.sent, [{ type: 'notice', text: "Notepad doesn't seem to have opened." }])
  assert.ok(h.audits.some((e) => e.kind === 'app' && e.ok === false && /not running/.test(e.reason)))
})

test('no notice when the app is running, when Windows cannot say, or when its process is unknown', async () => {
  for (const running of [true, null]) {
    const h = harness({ answers: ['yes'], running })
    await run('open_app', { app: 'notepad' }, h.ctx)
    await tick()
    assert.equal(h.checked.length, 1)
    assert.deepEqual(h.sent, [], `isRunning -> ${running}`)
    rmSync(join(dir, 'apps.json'), { force: true })
  }
  const h = harness({ answers: ['yes'], running: false })
  await run('open_app', { app: 'paint' }, h.ctx) // no known process name for Paint
  await tick()
  assert.deepEqual(h.checked, [])
  assert.deepEqual(h.sent, [])
})

test('list_apps: the list goes on a blade, the spoken answer stays short', async () => {
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({
    allow: { 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App': { name: 'Notepad', grantedAt: '2026-01-01T00:00:00.000Z' } },
  }))
  const h = harness()
  const r = await run('list_apps', {}, h.ctx)
  assert.match(r.say, new RegExp(`^You have ${APPS.length} apps in the Start menu — they're on screen`))
  assert.match(r.say, /okayed Notepad\.$/)
  assert.equal(h.sent.length, 1)
  const { type, blade } = h.sent[0]
  assert.equal(type, 'blade')
  assert.equal(blade.kind, 'markup')
  assert.equal(blade.title, 'APPS')
  assert.equal(blade.size, 'tall')
  const rows = blade.html.match(/<div class="hud-row">.*?<\/div>/g)
  assert.equal(rows.length, APPS.length)
  assert.match(rows[0], /Notepad<\/span>.*hud-tag hud-hot">okayed</, 'okayed apps first')
  assert.match(blade.html, /Command Prompt<\/span><\/span><span class="hud-tag">asks every time</)
  assert.match(blade.html, /Spotify<\/span><\/span><span class="hud-tag">asks once</)
})

test('list_apps: names are escaped before they become markup', () => {
  const blade = apps.appsBlade([{ name: 'R&D <b>Tool</b>', appId: 'x!y', kind: 'store', risk: 'normal' }], {})
  assert.match(blade.html, /R&amp;D &lt;b&gt;Tool&lt;\/b&gt;/)
  assert.doesNotMatch(blade.html, /<b>/)
})

test('a name nobody can find re-reads the Start menu, at most once in ten minutes', async () => {
  const zed = { name: 'Zed', appId: 'Zed.Zed_abc!App', kind: 'store', risk: 'normal' }
  const menu = fakeStartMenu([APPS, [...APPS, zed]])
  await menu.catalog.get()
  assert.equal(menu.reads.length, 1)

  // Read a moment ago: a miss is just a miss, and goes on to Claude.
  const h = harness({ catalog: menu.catalog, answers: ['yes'] })
  assert.deepEqual(await run('open_app', { app: 'zed' }, h.ctx), { fallthrough: true })
  assert.equal(menu.reads.length, 1)

  // Eleven minutes on, Zed has been installed: the miss reads again and finds it.
  menu.clock.t += 11 * 60 * 1000
  assert.equal((await run('open_app', { app: 'zed' }, h.ctx)).say, 'Opening Zed.')
  assert.equal(menu.reads.length, 2)
  assert.deepEqual(h.launched, ['Zed'])

  // And the next miss, a minute later, does not.
  menu.clock.t += 60 * 1000
  assert.deepEqual(await run('open_app', { app: 'the pod bay doors' }, h.ctx), { fallthrough: true })
  assert.equal(menu.reads.length, 2)
})

test('catalog: a day-old cache answers at once and is re-read behind it', async () => {
  const menu = fakeStartMenu([APPS, [...APPS, { name: 'Zed', appId: 'Zed.Zed_abc!App', kind: 'store', risk: 'normal' }]])
  // No cache: upkeep leaves it to the first command; the first command waits.
  await menu.catalog.upkeep()
  assert.equal(menu.reads.length, 0)
  assert.equal((await menu.catalog.get()).apps.length, APPS.length)
  assert.equal(menu.reads.length, 1)

  menu.clock.t += 25 * HOUR
  const old = await menu.catalog.get()
  assert.equal(old.apps.length, APPS.length, 'answered from the old cache')
  await tick()
  assert.equal(menu.reads.length, 2, 're-read in the background')
  assert.equal(JSON.parse(readFileSync(join(dir, 'apps-catalog.json'), 'utf8')).apps.length, APPS.length + 1)
  assert.equal((await menu.catalog.get()).apps.length, APPS.length + 1)
  assert.equal(menu.reads.length, 2, 'fresh again: no more reads')
})

test('catalog: upkeep refreshes a stale cache on start and leaves a fresh one alone', async () => {
  const menu = fakeStartMenu()
  await menu.catalog.get()
  await menu.catalog.upkeep()
  assert.equal(menu.reads.length, 1)
  menu.clock.t += 25 * HOUR
  const stop = menu.catalog.start(60_000)
  try {
    await tick()
    assert.equal(menu.reads.length, 2, 'start() looks at the cache straight away')
  } finally {
    stop()
  }
})

test('catalog: one read at a time, and a failed background read keeps the old list', async () => {
  let reads = 0
  let fail = false
  const logs = []
  let t = 0
  const catalog = createCatalog({
    cachePath: join(dir, 'apps-catalog.json'),
    now: () => t,
    source: async () => {
      reads++
      await tick()
      if (fail) throw new Error('timed out')
      return APPS
    },
    log: (m) => logs.push(m),
  })
  await Promise.all([catalog.refresh(), catalog.refresh(), catalog.get()])
  assert.equal(reads, 1)
  fail = true
  t += 25 * HOUR
  assert.equal((await catalog.get()).apps.length, APPS.length)
  await tick()
  await tick()
  assert.equal(reads, 2)
  assert.match(logs[0], /timed out/)
  assert.equal((await catalog.get()).apps.length, APPS.length)
})

test('isRunning: reads tasklist by absolute path and compares names itself', async () => {
  const calls = []
  const execFile = async (file, args, opts) => {
    calls.push({ file, args, opts })
    return { stdout: '"System Idle Process","0","Services","0","8 K"\r\n"Code - Insiders.exe","4242","Console","1","123,456 K"\r\n' }
  }
  assert.equal(await isRunning(['Code - Insiders'], { execFile, systemRoot: 'C:\\Windows' }), true)
  assert.equal(await isRunning(['code - insiders', 'notepad'], { execFile, systemRoot: 'C:\\Windows' }), true)
  assert.equal(await isRunning(['Notepad'], { execFile, systemRoot: 'C:\\Windows' }), false)
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\tasklist.exe')
  assert.deepEqual(calls[0].args, ['/FO', 'CSV', '/NH'])
  assert.equal(calls[0].opts.shell, undefined)
  assert.equal(await isRunning(['Notepad'], { execFile: async () => { throw new Error('no') } }), null)
  assert.equal(await isRunning([], { execFile }), null)
})
