import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge } from './helpers.mjs'

/**
 * An installed VAS (JARVIS_APP_ONLY=1) has no dev server, so the dev origins a
 * development bridge accepts are refused too — only the VAS window's own
 * app://vas may talk to it, and still only with the token.
 */
let bridge
before(async () => {
  bridge = await startBridge({ env: { JARVIS_APP_ONLY: '1' } })
})
after(async () => {
  await bridge?.stop()
})

const health = (origin) =>
  fetch(`http://127.0.0.1:${bridge.port}/health`, { headers: { 'x-vas-token': bridge.token, origin } })

test('the VAS window is accepted', async () => {
  assert.equal((await health('app://vas')).status, 200)
})

test('dev-server origins are refused even with the token', async () => {
  assert.equal((await health('http://localhost:5173')).status, 403)
  assert.equal((await health('http://127.0.0.1:5174')).status, 403)
})

test('the log says so', () => {
  assert.match(bridge.log(), /accepting only the VAS window/)
})
