import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PS_FLAGS, START_APPS_SCRIPT, loadCatalog, parseStartApps } from '../../bridge/os/catalog.mjs'
import { normalizeName, resolveApp } from '../../bridge/os/resolve.mjs'
import { CLOSE_SCRIPT, closeApp, launchApp, processNamesFor } from '../../bridge/os/launch.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ROWS = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'startapps.json'), 'utf8'))
const APPS = parseStartApps(ROWS)
const byName = (name) => APPS.find((a) => a.name === name)
const best = (query, opts) => resolveApp(query, { apps: APPS }, opts).best?.app

test('the fixture parses: every row kept, kinds and risks tagged', () => {
  assert.equal(APPS.length, ROWS.length)
  assert.deepEqual(byName('Notepad++'), { name: 'Notepad++', appId: 'D:\\Notepad++\\notepad++.exe', kind: 'exe', risk: 'normal' })
  assert.equal(byName('Command Prompt').kind, 'exe')
  assert.equal(byName('Spotify').kind, 'store')
  assert.equal(byName('Google Chrome').kind, 'shell')
  for (const name of ['Command Prompt', 'Windows PowerShell', 'Windows PowerShell ISE (x86)', 'Registry Editor',
    'Services', 'Component Services', 'Terminal', 'Run', 'Control Panel', 'Task Manager']) {
    assert.equal(byName(name).risk, 'high', name)
  }
  for (const name of ['Google Chrome', 'Spotify', 'Notepad', 'Notepad++', 'VLC media player', 'Settings']) {
    assert.equal(byName(name).risk, 'normal', name)
  }
})

test('one app comes back from PowerShell as a bare object, and is still a list', () => {
  assert.deepEqual(parseStartApps({ Name: 'Paint', AppID: 'Microsoft.Paint_8wekyb3d8bbwe!App' }).map((a) => a.kind), ['store'])
  assert.deepEqual(parseStartApps(null), [])
  const odd = parseStartApps([
    { Name: 'Tidy', AppID: 'C:\\Tools\\tidy.bat' },
    { Name: 'Site', AppID: 'https://example.com/' },
    { Name: 'Broken' },
  ])
  assert.deepEqual(odd.map((a) => [a.kind, a.risk]), [['script', 'high'], ['url', 'normal']])
})

test('names are normalised the way they are spoken', () => {
  assert.equal(normalizeName('Notepad++'), 'notepad plus plus')
  assert.equal(normalizeName('Microsoft® Word™'), 'microsoft word')
  assert.equal(normalizeName('the Spotify app'), 'spotify')
  assert.equal(normalizeName('My  C+ Editor'), 'c plus editor')
})

test('spoken names resolve to the right Start menu entry', () => {
  assert.equal(best('vs code').name, 'Visual Studio Code - Insiders')
  assert.equal(best('chrome').name, 'Google Chrome')
  assert.equal(best('notepad plus plus').name, 'Notepad++')
  assert.equal(best('notepad++').kind, 'exe')
  assert.equal(best('notepad').name, 'Notepad')
  assert.equal(best('spotify').name, 'Spotify')
  assert.equal(best('whatsapp').name, 'WhatsApp')
  assert.equal(best('vlc').name, 'VLC media player')
  assert.equal(best('power point').name, 'PowerPoint')
})

test('shells and consoles resolve, and stay high-risk', () => {
  const ps = best('powershell')
  assert.equal(ps.name, 'Windows PowerShell')
  assert.equal(ps.risk, 'high')
  assert.equal(best('command prompt').risk, 'high')
  const services = best('services')
  assert.equal(services.name, 'Services')
  assert.equal(services.kind, 'msc')
  assert.equal(services.risk, 'high')
})

test('nothing close enough falls through to Claude', () => {
  assert.deepEqual(resolveApp('open the pod bay doors', APPS), { best: null, ambiguous: null })
  assert.equal(resolveApp('chrome & calc', APPS).best, null)
  assert.equal(resolveApp('', APPS).best, null)
})

test('near-ties are ambiguous; a clear winner is not', () => {
  const r = resolveApp('note', APPS)
  assert.equal(r.best.app.name, 'Notepad') // tie, shorter name wins
  assert.deepEqual(r.ambiguous.map((c) => c.app.name), ['Notepad', 'Notepad++'])
  assert.equal(resolveApp('notepad', APPS).ambiguous, null)
})

test('a learned alias outranks everything', () => {
  const r = resolveApp('my music', APPS, { aliases: { 'My Music': 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' } })
  assert.equal(r.best.app.name, 'Spotify')
  assert.equal(r.best.score, 1)
})

/** An execFile that behaves like Explorer: the launch works, the exit code says 1. */
function fakeExplorer(calls) {
  return async (file, args, opts) => {
    calls.push({ file, args, opts })
    throw Object.assign(new Error('Command failed'), { code: 1 })
  }
}

function fakeSpawn(calls) {
  return (file, args, opts) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter()
    child.unref = () => { child.unrefed = true }
    process.nextTick(() => child.emit('spawn'))
    calls.child = child
    return child
  }
}

const noSpawn = () => assert.fail('spawn must not be called')
const noExec = async () => assert.fail('execFile must not be called')

test('Store and shell apps open through shell:AppsFolder; exit code 1 is success', async () => {
  const calls = []
  const r = await launchApp(byName('Google Chrome'), {
    execFile: fakeExplorer(calls), spawn: noSpawn, exists: () => false, systemRoot: 'C:\\Windows',
  })
  assert.deepEqual(r, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'C:\\Windows\\explorer.exe')
  assert.deepEqual(calls[0].args, ['shell:AppsFolder\\Chrome'])
  assert.equal(calls[0].opts.shell, undefined)
})

test('a real .exe on disk is spawned directly, detached, in its own folder', async () => {
  const calls = []
  const r = await launchApp(byName('Notepad++'), {
    execFile: noExec, spawn: fakeSpawn(calls), exists: (p) => p === 'D:\\Notepad++\\notepad++.exe', systemRoot: 'C:\\Windows',
  })
  assert.deepEqual(r, { ok: true })
  assert.equal(calls[0].file, 'D:\\Notepad++\\notepad++.exe')
  assert.deepEqual(calls[0].args, [])
  assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore', cwd: 'D:\\Notepad++', windowsHide: false })
  assert.equal(calls.child.unrefed, true)
})

test('forged AppIDs, scripts and links are refused before anything runs', async () => {
  const deps = { execFile: noExec, spawn: noSpawn, exists: () => true, systemRoot: 'C:\\Windows' }
  const forged = await launchApp({ name: 'x', appId: 'Chrome" & calc & "', kind: 'shell' }, deps)
  assert.equal(forged.ok, false)
  assert.match(forged.reason, /characters/)
  const script = await launchApp({ name: 'Tidy', appId: 'C:\\Tools\\tidy.bat', kind: 'script' }, deps)
  assert.equal(script.ok, false)
  assert.match(script.reason, /script/)
  assert.equal((await launchApp({ name: 'Site', appId: 'https://example.com/', kind: 'url' }, deps)).ok, false)
})

test('process names for closing: exe basenames and the known table, else nothing', () => {
  assert.deepEqual(processNamesFor(byName('Notepad++')), ['notepad++'])
  assert.deepEqual(processNamesFor(byName('Visual Studio Code - Insiders')), ['Code - Insiders'])
  assert.deepEqual(processNamesFor(byName('Google Chrome')), ['chrome'])
  assert.deepEqual(processNamesFor(byName('Calculator')), ['CalculatorApp'])
  assert.deepEqual(processNamesFor(byName('Paint')), [])
})

test('closeApp runs close-app.ps1 with checked names and reads the count', async () => {
  const calls = []
  const execFile = async (file, args) => {
    calls.push({ file, args })
    return { stdout: '2\r\n' }
  }
  const r = await closeApp(['Code - Insiders', 'notepad++'], { execFile, systemRoot: 'C:\\Windows' })
  assert.deepEqual(r, { ok: true, closed: 2 })
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(calls[0].args, [...PS_FLAGS, '-File', CLOSE_SCRIPT, '-ProcessName', 'Code - Insiders,notepad++'])

  for (const bad of [['*'], ['chrome;calc'], ['-Command'], ['a,b'], []]) {
    const refused = await closeApp(bad, { execFile: noExec })
    assert.equal(refused.ok, false, JSON.stringify(bad))
  }
})

test('close-app.ps1 runs for real and closes nothing that is not there', { skip: process.platform !== 'win32' }, async () => {
  const r = await closeApp(['vas-no-such-process-1', 'vas no such process 2'])
  assert.deepEqual(r, { ok: true, closed: 0 })
})

test('loadCatalog: a fresh cache is used as is, a stale one is refreshed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vas-apps-'))
  try {
    const cachePath = join(dir, 'apps-catalog.json')
    const HOUR = 60 * 60 * 1000
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1000, apps: [{ name: 'Paint', appId: 'Microsoft.Paint_8wekyb3d8bbwe!App', kind: 'shell', risk: 'normal' }] }))

    const fresh = await loadCatalog({ cachePath, now: () => 1000 + HOUR, exec: noExec })
    assert.deepEqual(fresh.apps.map((a) => [a.name, a.kind]), [['Paint', 'store']]) // re-derived, not trusted

    const calls = []
    const exec = async (file, args) => {
      calls.push({ file, args })
      return { stdout: '\uFEFF' + JSON.stringify(ROWS) }
    }
    const refreshed = await loadCatalog({ cachePath, now: () => 1000 + 25 * HOUR, exec })
    assert.equal(calls.length, 1)
    assert.match(calls[0].file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    assert.deepEqual(calls[0].args, [...PS_FLAGS, '-Command', START_APPS_SCRIPT])
    assert.equal(refreshed.apps.length, ROWS.length)
    assert.equal(refreshed.fetchedAt, 1000 + 25 * HOUR)
    const saved = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.equal(saved.fetchedAt, 1000 + 25 * HOUR)
    assert.equal(saved.apps.length, ROWS.length)

    const failing = async () => { throw new Error('timed out') }
    const stale = await loadCatalog({ cachePath, now: () => 1000 + 50 * HOUR, exec: failing })
    assert.equal(stale.stale, true)
    assert.equal(stale.apps.length, ROWS.length)
    await assert.rejects(loadCatalog({ cachePath: join(dir, 'none.json'), exec: failing }), /timed out/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nothing under bridge/os runs through a shell', () => {
  const dir = join(ROOT, 'bridge', 'os')
  const files = readdirSync(dir, { recursive: true }).filter((f) => /\.(?:mjs|js|cjs|ps1)$/.test(f))
  assert.ok(files.length >= 4)
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8')
    assert.ok(!/shell:\s?true/.test(text), `${f} mentions shell: true`)
  }
})
