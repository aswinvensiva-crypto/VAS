import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startBridge } from './helpers.mjs'

const WebSocket = createRequire(import.meta.url)('ws')

let bridge
before(async () => {
  // As if VAS were started from a terminal inside a Claude Code session.
  bridge = await startBridge({
    env: {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'host-session',
      CLAUDE_CODE_MESSAGING_TOKEN: 'host-secret',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  })
})
after(async () => {
  await bridge?.stop()
})

const url = (path) => `http://127.0.0.1:${bridge.port}${path}`
const withToken = (extra = {}) => ({ headers: { 'x-vas-token': bridge.token, ...extra } })

test('listens on loopback only', async () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)
  if (!lan) return // no network adapter to try from
  const refused = await new Promise((resolve) => {
    const s = createConnection({ host: lan.address, port: bridge.port })
    s.once('connect', () => {
      s.destroy()
      resolve(false)
    })
    s.once('error', () => resolve(true))
  })
  assert.ok(refused, `bridge answered on ${lan.address}`)
})

test('HTTP needs the session token', async () => {
  assert.equal((await fetch(url('/health'))).status, 401)
  assert.equal((await fetch(url('/health'), { headers: { 'x-vas-token': 'wrong' } })).status, 401)
  const ok = await fetch(url('/health'), withToken())
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).ok, true)
})

test('an unknown origin is refused even with the token', async () => {
  const res = await fetch(url('/health'), withToken({ origin: 'https://evil.example' }))
  assert.equal(res.status, 403)
})

test('routes match on path, so a query string is not a 404', async () => {
  const res = await fetch(url('/stt?mode=wake'), { method: 'POST', body: '', ...withToken() })
  assert.notEqual(res.status, 404)
})

function openSocket(protocols, origin = 'app://vas') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, protocols, { headers: { origin } })
    ws.once('open', () => resolve({ ws, open: true }))
    ws.once('unexpected-response', (_req, res) => resolve({ open: false, status: res.statusCode }))
    ws.once('error', () => resolve({ open: false }))
  })
}

test('the socket needs the token as a subprotocol', async () => {
  const bare = await openSocket(['vas.v1'])
  assert.equal(bare.open, false)
  assert.equal(bare.status, 401)
  const wrong = await openSocket(['vas.v1', 'vas.token.nope'])
  assert.equal(wrong.open, false)
})

test('the desktop origin with the token gets a working turn', async () => {
  const { ws, open } = await openSocket(['vas.v1', `vas.token.${bridge.token}`])
  assert.ok(open)
  assert.equal(ws.protocol, 'vas.v1')
  const reply = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('no reply')), 10_000)
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.ask !== 't1') return
      if (m.type === 'text') text += m.delta
      if (m.type === 'done') {
        clearTimeout(timer)
        resolve(text)
      }
    })
    ws.send(JSON.stringify({ type: 'ask', text: 'ping', id: 't1' }))
  })
  ws.close()
  assert.equal(reply, 'echo: ping')
})

test('the agent session is locked down', async () => {
  // The SDK is started lazily on the first connection; the test above made one.
  const options = JSON.parse(readFileSync(bridge.dump, 'utf8'))
  assert.equal(options.persistSession, false)
  assert.deepEqual(options.tools, ['WebSearch', 'ToolSearch', 'TodoWrite'])
  for (const t of ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(options.disallowedTools.includes(t), t)
  }
  assert.deepEqual(options.settingSources, [])
  assert.equal(options.cwd, join(bridge.dataDir, 'workspace'))
  assert.ok(!options.env.includes('JARVIS_BRIDGE_TOKEN'), 'token leaked into the agent environment')
  // The session VAS was started from stays out of VAS's own claude.exe...
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH']) {
    assert.ok(!options.env.includes(k), `${k} leaked into the agent environment`)
  }
  // ...but a setting the user chose on purpose is kept.
  assert.ok(options.env.includes('CLAUDE_CODE_USE_BEDROCK'))
  assert.equal(options.canUseTool, 'function')
  for (const s of ['jarvis', 'jarvis_ui', 'jarvis_chrome', 'jarvis_eyes']) {
    assert.ok(options.mcpServers.includes(s), s)
  }
})
