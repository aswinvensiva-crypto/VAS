import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OWN_SERVERS, createPolicy, sessionTools } from '../../bridge/policy.mjs'

const readOnly = createPolicy({ allowWrites: false }).decideTool
const writes = createPolicy({ allowWrites: true }).decideTool

test('JARVIS\'s own servers are allowed by name, whatever their tool is called', () => {
  for (const server of OWN_SERVERS) {
    for (const tool of ['open_app', 'chrome_navigate', 'teach_routine', 'recall_x', 'ui_theme']) {
      assert.equal(readOnly(`mcp__${server}__${tool}`), true, `${server}/${tool}`)
    }
  }
})

test('other servers: read verbs run, effectful verbs need --writes', () => {
  assert.equal(readOnly('mcp__someserver__list_devices'), true)
  assert.equal(readOnly('mcp__someserver__install_apk'), false)
  assert.equal(readOnly('mcp__someserver__recall_memory'), false) // "call" inside the name
  assert.equal(writes('mcp__someserver__install_apk'), true)
  assert.equal(readOnly('mcp__openrouter__send-message'), true) // exempt
})

test('built-ins: shell and file writes only with --writes', () => {
  assert.equal(readOnly('Bash'), false)
  assert.equal(readOnly('Write'), false)
  assert.equal(readOnly('WebSearch'), true)
  assert.equal(writes('Bash'), true)
  assert.equal(readOnly('SomeFutureTool'), false)
})

test('session tools: search only by default, full set with --writes', () => {
  const locked = sessionTools({ allowWrites: false })
  assert.deepEqual(locked.tools, ['WebSearch', 'ToolSearch', 'TodoWrite'])
  assert.ok(locked.disallowedTools.includes('Bash'))
  assert.ok(locked.disallowedTools.includes('WebFetch'))
  assert.deepEqual(sessionTools({ allowWrites: true }), {})
})

test('a configured server\'s tools are foreign; their inputs give up every address they carry', async () => {
  const { addressesIn, foreignMcp } = await import('../../bridge/policy.mjs')
  const { urlsIn } = await import('../../bridge/panels.mjs')
  assert.equal(foreignMcp('mcp__fetch__fetch'), true)
  assert.equal(foreignMcp('mcp__jarvis_chrome__chrome_navigate'), false, 'JARVIS\'s own ask for themselves')
  assert.equal(foreignMcp('WebSearch'), false)
  assert.deepEqual(addressesIn({ url: 'evil.example/?q=subjects' }, urlsIn), ['evil.example/?q=subjects'])
  assert.deepEqual(
    addressesIn({ request: { pages: ['see https://a.example/x and //b.example/y'] }, note: 'no address here' }, urlsIn),
    ['https://a.example/x', '//b.example/y'],
  )
  assert.deepEqual(addressesIn({ query: 'kochi weather' }, urlsIn), [])
})
