import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const aliases = JSON.parse(
  await readFile(new URL('../../config/wake-aliases.json', import.meta.url), 'utf8'),
)

test('wake aliases: canonical name first, all lowercase, no possessive', () => {
  assert.equal(aliases.names[0], 'jarvis')
  for (const n of [...aliases.names, ...aliases.prefixes]) {
    assert.equal(n, n.toLowerCase(), n)
    assert.ok(n.length > 0)
  }
  // "jarvis's" as an alias would defeat the possessive guard in the wake regex.
  assert.ok(!aliases.names.includes("jarvis's"))
})
