import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startBridge } from './helpers.mjs'

/**
 * The Settings drawer's endpoints through a real bridge (fake SDK, throwaway
 * data folder): every section reads back, every change is validated, saved,
 * applied without a restart and audited — and hand edits to the files count
 * too.
 */
const WebSocket = createRequire(import.meta.url)('ws')

let bridge
before(async () => {
  bridge = await startBridge()
})
after(async () => {
  await bridge?.stop()
})

const url = (path) => `http://127.0.0.1:${bridge.port}${path}`
const headers = (extra = {}) => ({ 'x-vas-token': bridge.token, origin: 'app://vas', ...extra })
const file = (name) => join(bridge.dataDir, name)
const readData = (name) => JSON.parse(readFileSync(file(name), 'utf8'))

async function get(path = '/settings') {
  const res = await fetch(url(path), { headers: headers() })
  assert.equal(res.status, 200, path)
  return res.json()
}

/** A settings change; resolves to { status, body }. */
async function send(method, path, body, extra = {}) {
  const res = await fetch(url(path), {
    method,
    headers: headers({ 'content-type': 'application/json', ...extra }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/** Poll until `check` passes — for changes picked up by a file watcher. */
async function eventually(check, what) {
  let last
  for (let i = 0; i < 50; i++) {
    try {
      return await check()
    } catch (err) {
      last = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`${what}: ${last?.message}`)
}

const auditLines = () =>
  existsSync(file('audit.log'))
    ? readFileSync(file('audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : []

test('settings need the session token like everything else', async () => {
  assert.equal((await fetch(url('/settings'))).status, 401)
  const res = await fetch(url('/settings/general'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 401)
})

test('GET /settings returns every section', async () => {
  const s = await get()
  assert.equal(s.general.owner.require, 'all')
  assert.equal(s.general.stt.engine, 'auto')
  assert.equal(s.general.tts.voice, null)
  assert.ok(s.general.userName.length > 0)
  assert.deepEqual(s.corrections, [])
  assert.deepEqual(s.apps, { allowed: [], aliases: [] })
  assert.deepEqual(s.routines, [])
  assert.equal(s.permissions.lockdown, false)
  const close = s.permissions.actions.find((a) => a.action === 'app.close')
  assert.deepEqual(close, { action: 'app.close', label: 'Close an app', tier: 'confirm', default: 'confirm' })
  assert.equal(s.voice.enrolled, false)
})

test('the drawer may preflight its removals', async () => {
  const res = await fetch(url('/settings/corrections'), {
    method: 'OPTIONS',
    headers: { origin: 'app://vas', 'access-control-request-method': 'DELETE' },
  })
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-methods'), /DELETE/)
})

test('general settings are saved, applied at once and audited', async () => {
  const r = await send('POST', '/settings/general', {
    userName: 'Tony',
    owner: { require: 'actions' },
    stt: { language: 'auto' },
    tts: { voice: 'Microsoft Hazel' },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.settings.general.userName, 'Tony')
  assert.equal(r.body.settings.general.tts.voice, 'Microsoft Hazel')
  // Only what was chosen is written; the defaults stay out of the file.
  assert.deepEqual(readData('config.json'), {
    userName: 'Tony',
    owner: { require: 'actions' },
    stt: { language: 'auto' },
    tts: { voice: 'Microsoft Hazel' },
  })
  const health = await get('/health')
  assert.equal(health.user.name, 'Tony')
  assert.equal(health.speaker.require, 'actions')
  assert.ok(auditLines().some((e) => e.kind === 'settings' && e.name === 'general' && e.args.userName === 'Tony'))

  const cleared = await send('POST', '/settings/general', { tts: { voice: null } })
  assert.equal(cleared.body.settings.general.tts.voice, null)
})

test('bad settings are refused and change nothing', async () => {
  const before = readFileSync(file('config.json'), 'utf8')
  for (const body of [{ owner: { require: 'everyone' } }, { hotkey: 'Control+Alt+V' }, { stt: { language: 'English please' } }, { userName: '' }]) {
    const r = await send('POST', '/settings/general', body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.body.ok, false)
    assert.ok(r.body.reason)
  }
  assert.equal((await send('POST', '/settings/general', '{ nope')).status, 400)
  assert.equal((await send('POST', '/settings/general', { userName: 'X' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await send('POST', '/settings/nothing', {})).status, 404)
  assert.equal(readFileSync(file('config.json'), 'utf8'), before)
})

test('corrections: added with the learning rules, removed, saved', async () => {
  const added = await send('POST', '/settings/corrections', { heard: 'spot if i', meant: 'Spotify' })
  assert.equal(added.status, 200, JSON.stringify(added.body))
  assert.deepEqual(
    added.body.settings.corrections.map(({ heard, meant, source }) => ({ heard, meant, source })),
    [{ heard: 'spot if i', meant: 'Spotify', source: 'settings' }],
  )
  assert.ok(readData('corrections.json').some((c) => c.heard === 'spot if i'))

  // validateCorrection's rules hold here exactly as they do by voice.
  const forged = await send('POST', '/settings/corrections', { heard: 'yes', meant: 'no' })
  assert.equal(forged.status, 400)
  assert.match(forged.body.reason, /confirmation/)
  assert.equal((await send('POST', '/settings/corrections', { heard: 'the', meant: 'a' })).status, 400)

  const removed = await send('DELETE', '/settings/corrections', { heard: 'Spot If I' })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body.settings.corrections, [])
  assert.deepEqual(readData('corrections.json'), [])
  assert.equal((await send('DELETE', '/settings/corrections', { heard: 'spot if i' })).status, 404)
  assert.ok(auditLines().some((e) => e.name === 'correction.remove'))
})

test('apps: revoke an allowed app, add and remove an alias', async () => {
  writeFileSync(
    file('apps.json'),
    JSON.stringify({
      allow: {
        'Spotify.App!Spotify': { name: 'Spotify', grantedAt: '2026-10-01T00:00:00.000Z' },
        'Notepad!App': { name: 'Notepad', grantedAt: '2026-10-02T00:00:00.000Z' },
      },
      aliases: {},
      process: { 'Spotify.App!Spotify': ['Spotify'] },
    }),
  )
  const s = await get()
  assert.deepEqual(s.apps.allowed.map((a) => a.name), ['Notepad', 'Spotify'])

  const alias = await send('POST', '/settings/apps/aliases', { alias: '  My  Music ', appId: 'Spotify.App!Spotify' })
  assert.equal(alias.status, 200, JSON.stringify(alias.body))
  assert.deepEqual(alias.body.settings.apps.aliases, [{ alias: 'my music', appId: 'Spotify.App!Spotify', name: 'Spotify' }])
  assert.equal(readData('apps.json').aliases['my music'], 'Spotify.App!Spotify')
  assert.equal((await send('POST', '/settings/apps/aliases', { alias: 'evil', appId: 'cmd.exe' })).status, 400)

  const revoked = await send('DELETE', '/settings/apps/allow', { appId: 'Spotify.App!Spotify' })
  assert.equal(revoked.status, 200)
  assert.deepEqual(revoked.body.settings.apps.allowed.map((a) => a.name), ['Notepad'])
  const apps = readData('apps.json')
  assert.equal(apps.allow['Spotify.App!Spotify'], undefined)
  assert.deepEqual(apps.process['Spotify.App!Spotify'], ['Spotify'], 'closing it later still works')
  assert.equal((await send('DELETE', '/settings/apps/allow', { appId: 'Spotify.App!Spotify' })).status, 404)

  assert.equal((await send('DELETE', '/settings/apps/aliases', { alias: 'MY MUSIC' })).status, 200)
  assert.deepEqual(readData('apps.json').aliases, {})
  assert.ok(auditLines().some((e) => e.name === 'app.revoke' && e.args.app === 'Spotify'))
})

test('routines: listed from brain.yml and deleted, keeping the rest of the file', async () => {
  writeFileSync(
    file('brain.yml'),
    [
      '# my own routines',
      'version: 1',
      'synapses:',
      '  - name: routine-tea-time',
      '    source: taught',
      '    signals:',
      '      - order: { text: "tea time", matching-type: ordered-strict }',
      '    neurons:',
      '      - say: { message: "Kettle on." }',
      '  - name: routine-clock-check',
      '    signals:',
      '      - order: { text: "clock check please", matching-type: ordered-strict }',
      '    neurons:',
      '      - time: {}',
      '',
    ].join('\n'),
  )
  const listed = await eventually(async () => {
    const s = await get()
    assert.equal(s.routines.length, 2)
    return s.routines
  }, 'brain.yml was not picked up')
  assert.deepEqual(listed[0], {
    name: 'routine-tea-time',
    triggers: ['tea time'],
    steps: ['say Kettle on.'],
    source: 'taught',
    created: null,
  })

  const r = await send('DELETE', '/settings/routines', { name: 'routine-tea-time' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.settings.routines.map((x) => x.name), ['routine-clock-check'])
  const text = readFileSync(file('brain.yml'), 'utf8')
  assert.match(text, /# my own routines/)
  assert.doesNotMatch(text, /tea time/)
  assert.equal((await send('DELETE', '/settings/routines', { name: 'routine-tea-time' })).status, 404)
})

test('permissions: tiers, reset to default, lockdown', async () => {
  const r = await send('POST', '/settings/permissions', { tiers: { 'app.close': 'deny', 'chrome.act': 'confirm' }, lockdown: true })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const close = r.body.settings.permissions.actions.find((a) => a.action === 'app.close')
  assert.equal(close.tier, 'deny')
  assert.equal(r.body.settings.permissions.lockdown, true)
  assert.equal(readData('permissions.json').tiers['app.close'], 'deny')

  // Lifting it is a safeguard coming off: with no face open to ask, refused.
  const blind = await send('POST', '/settings/permissions', { tiers: { 'app.close': null }, lockdown: false })
  assert.equal(blind.status, 409)
  assert.match(blind.body.reason, /Open VAS/)
  assert.equal(readData('permissions.json').lockdown, true)

  // With a face open it is put to the gate as unlocking, where a click counts
  // while clicks do — and once lifted, the rest is judged as unlocked.
  const face = await openFace(() => ({ source: 'click', approved: true }))
  try {
    const reset = await send('POST', '/settings/permissions', { tiers: { 'app.close': null }, lockdown: false })
    assert.equal(reset.status, 200, JSON.stringify(reset.body))
    assert.equal(reset.body.settings.permissions.actions.find((a) => a.action === 'app.close').tier, 'confirm')
    assert.equal(readData('permissions.json').tiers['app.close'], undefined)
    assert.equal(readData('permissions.json').lockdown, false)
    assert.deepEqual(face.prompts, ['Lift the lockdown?'])
  } finally {
    await face.close()
  }

  assert.equal((await send('POST', '/settings/permissions', { tiers: { 'launch.missiles': 'free' } })).status, 400)
  assert.equal((await send('POST', '/settings/permissions', { tiers: { 'app.close': 'sometimes' } })).status, 400)
  assert.ok(auditLines().some((e) => e.kind === 'settings' && e.name === 'permissions' && e.args.lockdown === true))
})

test('a hand edit to config.json applies without a restart; a broken one is ignored', async () => {
  writeFileSync(file('config.json'), JSON.stringify({ userName: 'Pepper', owner: { require: 'off' } }))
  await eventually(async () => {
    const h = await get('/health')
    assert.equal(h.user.name, 'Pepper')
    assert.equal(h.speaker.require, 'off')
  }, 'config.json edit was not applied')

  writeFileSync(file('config.json'), '{ "userName": "Pep')
  await new Promise((r) => setTimeout(r, 600))
  assert.equal((await get('/health')).user.name, 'Pepper', 'a half-written file keeps the settings in effect')
  assert.match(bridge.log(), /config\.json changed but was not applied/)
  writeFileSync(file('config.json'), '{}')
})

/** A face on the socket answering every question with `reply(m)`, keeping the prompts. */
async function openFace(reply) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  const prompts = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'confirm') return
    prompts.push(m.prompt)
    ws.send(JSON.stringify({ type: 'reply', id: m.id, ...reply(m) }))
  })
  return {
    prompts,
    close: () =>
      new Promise((r) => {
        ws.once('close', () => setTimeout(r, 50))
        ws.close()
      }),
  }
}

test('with clicks switched off, loosening a safeguard here needs a spoken yes', async () => {
  writeFileSync(file('permissions.json'), JSON.stringify({ allowClickConfirm: false, tiers: { 'app.close': 'deny' } }))
  const clicker = await openFace(() => ({ source: 'click', approved: true }))
  try {
    const r = await send('POST', '/settings/permissions', { tiers: { 'app.close': 'free' } })
    assert.equal(r.status, 403)
    assert.match(r.body.reason, /say yes instead/)
    assert.equal(readData('permissions.json').tiers['app.close'], 'deny', 'nothing changed')
    assert.deepEqual(clicker.prompts, ['Let "Close an app" be just do it?'])
    // Tightening is never asked about.
    assert.equal((await send('POST', '/settings/permissions', { tiers: { 'app.open': 'deny' } })).status, 200)
    assert.equal(clicker.prompts.length, 1)
  } finally {
    await clicker.close()
  }

  const speaker = await openFace(() => ({ source: 'voice', text: 'yes', raw: 'yes' }))
  try {
    const r = await send('POST', '/settings/permissions', { allowClickConfirm: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(speaker.prompts, ['Let a click approve things again?'])
    assert.equal(readData('permissions.json').allowClickConfirm, true)
  } finally {
    await speaker.close()
  }
  writeFileSync(file('permissions.json'), '{}')
})

test('a hand edit to permissions.json counts from the next question on', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, ['vas.v1', `vas.token.${bridge.token}`], {
    headers: { origin: 'app://vas' },
  })
  await new Promise((r) => ws.once('open', r))
  const prompts = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'confirm') return
    prompts.push(m.prompt)
    ws.send(JSON.stringify({ type: 'reply', id: m.id, text: 'no', source: 'voice' }))
  })
  const ask = (text, id) =>
    new Promise((resolve) => {
      let said = ''
      const on = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.ask !== id) return
        if (m.type === 'text') said += m.delta
        if (m.type === 'done') {
          ws.off('message', on)
          resolve(said)
        }
      }
      ws.on('message', on)
      ws.send(JSON.stringify({ type: 'ask', text, id }))
    })
  try {
    assert.match(await ask('unlock', 'u1'), /not locked down/)
    writeFileSync(file('permissions.json'), JSON.stringify({ lockdown: true }))
    await ask('unlock', 'u2')
    assert.deepEqual(prompts, ['Lift the lockdown?'])
  } finally {
    ws.close()
  }
})

test('every action on the Permissions tab is named in words, not by its key', async () => {
  const s = await get('/settings')
  const unnamed = s.permissions.actions.filter((a) => a.label === a.action).map((a) => a.action)
  assert.deepEqual(unnamed, [])
  assert.ok(s.permissions.actions.some((a) => a.action === 'chrome.leave'))
})
