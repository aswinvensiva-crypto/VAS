import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let store
let learnCorrection
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-corrections-'))
  process.env.JARVIS_DATA_DIR = dir
  store = await import('../../bridge/corrections/store.mjs')
  ;({ learnCorrection } = await import('../../bridge/corrections/learn.mjs'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

const fresh = (...pairs) => {
  const c = store.createCorrections()
  for (const [heard, meant] of pairs) c.add({ heard, meant })
  return c
}

// learnCorrection

test('learn: the whole command repeated teaches the misheard stretch', () => {
  assert.deepEqual(learnCorrection('open spot if i', 'open spotify'), { heard: 'spot if i', meant: 'spotify' })
})

test('learn: a single misheard word takes its left neighbour along', () => {
  assert.deepEqual(learnCorrection('open vs cold', 'open vs code'), { heard: 'vs cold', meant: 'vs code' })
})

test('learn: a stop-word neighbour is not taken along', () => {
  assert.deepEqual(learnCorrection('turn on the lamp', 'turn on the lamps'), { heard: 'lamp', meant: 'lamps' })
})

test('learn: just the fragment, as the user said it, finds the run it sounds like', () => {
  assert.deepEqual(learnCorrection('open spot if i', 'Spotify'), { heard: 'spot if i', meant: 'Spotify' })
  assert.deepEqual(learnCorrection('open spot if i', 'Spotify.'), { heard: 'spot if i', meant: 'Spotify' })
})

test('learn: a fragment that sounds like nothing heard is refused', () => {
  assert.equal(learnCorrection('open spot if i', 'weather'), null)
  // "cold" and "code" are only half alike: never learned from a bare fragment.
  assert.equal(learnCorrection('open vs cold', 'code'), null)
})

test('learn: identical or case-only differences are no-ops', () => {
  assert.equal(learnCorrection('open spotify', 'open spotify'), null)
  assert.equal(learnCorrection('open spotify', 'Open Spotify'), null)
})

test('learn: two separate differences are a rephrase, not a correction', () => {
  assert.equal(learnCorrection('call tom then text dan', 'call mom then text dad'), null)
})

test('learn: pure insertions and deletions, and long stretches, are refused', () => {
  assert.equal(learnCorrection('open spotify', 'open spotify app'), null)
  assert.equal(learnCorrection('open spotify app', 'open spotify'), null)
  assert.equal(
    learnCorrection('please play one two three four five now thanks', 'please play six seven eight nine ten now thanks'),
    null,
  )
})

test('learn: stop-word-only and guarded corrections are refused', () => {
  assert.equal(learnCorrection('open a file', 'open the file'), null)
  assert.equal(learnCorrection('open jervis', 'open jarvis'), null)
  assert.equal(learnCorrection('please con firm', 'please confirm'), null)
  assert.equal(learnCorrection('shut town the pc', 'shut down the pc'), null)
})

// validateCorrection

test('validate: empty, too long, identical and stop-word-only are refused', () => {
  assert.match(store.validateCorrection({ heard: '  ', meant: 'x' }), /needs both/)
  assert.match(store.validateCorrection({ heard: 'spot' }), /needs both/)
  assert.match(store.validateCorrection({ heard: 'a'.repeat(61), meant: 'b' }), /60 characters/)
  assert.match(store.validateCorrection({ heard: 'Spotify', meant: 'spotify' }), /the same/)
  assert.match(store.validateCorrection({ heard: 'to the', meant: 'tothe' }), /small words/)
  assert.equal(store.validateCorrection({ heard: 'spot if i', meant: 'Spotify' }), null)
})

test('validate: a correction can never forge a confirmation, a wake or a kill phrase', () => {
  for (const [heard, meant] of [
    ['con firm', 'confirm'],
    ['confirm', 'conform'],
    ['yes sir', 'yessir'],
    ['yet', 'yes'],
    ['travel', 'jarvis'],
    ['hey travis', 'hey there'],
    ['jarvis\'s list', 'the list'],
    ['go to sleet', 'go to sleep'],
    ['shut town', 'shutdown'],
    ['never mine', 'nevermind'],
    ['go-ahead', 'go head'],
  ]) {
    assert.ok(store.validateCorrection({ heard, meant }), `${heard} -> ${meant} should be refused`)
  }
  // Whole words only: "know" and "notes" contain "no", and are fine.
  assert.equal(store.validateCorrection({ heard: 'i know', meant: 'i now' }), null)
  assert.equal(store.validateCorrection({ heard: 'open notes', meant: 'open notion' }), null)
})

// createCorrections

test('apply respects word boundaries', () => {
  const c = fresh(['cat', 'cut'])
  assert.equal(c.apply('the category cat'), 'the category cut')
  assert.equal(c.apply("cat's toy"), "cat's toy")
})

test('apply prefers the longest heard phrase', () => {
  const c = fresh(['spot', 'spa'], ['spot if i', 'spotify'])
  assert.equal(c.apply('open spot if i'), 'open spotify')
  assert.equal(c.apply('a spot here'), 'a spa here')
})

test('apply is case-insensitive and tolerant of spacing', () => {
  const c = fresh(['spot if i', 'spotify'])
  assert.equal(c.apply('OPEN Spot If  I please'), 'OPEN spotify please')
})

test('apply never chains: replacements are not scanned again', () => {
  const c = fresh(['alpha', 'beta'], ['beta', 'gamma'])
  assert.equal(c.apply('alpha'), 'beta')
  assert.equal(c.apply('alpha beta'), 'beta gamma')
})

test('regex metacharacters in heard are escaped', () => {
  const c = fresh(['c++', 'C plus plus'], ['(x).*', 'why'])
  assert.equal(c.apply('i write c++ daily'), 'i write C plus plus daily')
  assert.equal(c.apply('c'), 'c')
  assert.equal(c.apply('say (x).* now'), 'say why now')
})

test('apply refuses a result that gains or loses a guarded phrase', () => {
  const c = fresh(['goat', 'go'], ['sleep', 'sheep'], ['spot if i', 'spotify'], ['sleet', 'sleep'])
  assert.equal(c.apply('goat ahead'), 'goat ahead')
  assert.equal(c.apply('go to sleet'), 'go to sleet')
  assert.equal(c.apply('sleet outside'), 'sleep outside')
  assert.equal(c.apply('go to sleep'), 'go to sleep')
  assert.equal(c.apply('count the sleep'), 'count the sheep')
  assert.equal(c.apply('yes open spot if i'), 'yes open spotify')
})

test('add, count, replace, remove, list', () => {
  const c = store.createCorrections()
  const e = c.add({ heard: '  Spot  If I ', meant: 'Spotify', source: 'learned' })
  assert.equal(e.heard, 'spot if i')
  assert.equal(e.meant, 'Spotify')
  assert.equal(e.count, 0)
  assert.equal(e.source, 'learned')
  assert.ok(!Number.isNaN(Date.parse(e.createdAt)))

  c.apply('spot if i and spot if i')
  assert.equal(c.list()[0].count, 2)

  c.add({ heard: 'SPOT IF I', meant: 'Spotify app' })
  assert.equal(c.list().length, 1)
  assert.equal(c.apply('spot if i'), 'Spotify app')

  assert.throws(() => c.add({ heard: 'yet', meant: 'yes' }), /confirmation/)
  assert.equal(c.remove('Spot if i'), true)
  assert.equal(c.remove('spot if i'), false)
  assert.equal(c.apply('spot if i'), 'spot if i')
  assert.deepEqual(c.list(), [])
})

test('createCorrections skips invalid entries instead of trusting them', () => {
  const c = store.createCorrections([
    { heard: 'spot if i', meant: 'Spotify', count: 3, createdAt: '2026-01-01T00:00:00.000Z', source: 'user' },
    { heard: 'yet', meant: 'yes' },
    { heard: 'the', meant: 'a' },
    null,
    { heard: 'vs cold', meant: 'vs code', count: -1 },
  ])
  assert.deepEqual(c.list().map((e) => e.heard), ['spot if i'])
  assert.equal(c.list()[0].count, 3)
})

// persistence

test('load with no file is an empty set', async () => {
  const c = await store.loadCorrections()
  assert.deepEqual(c.list(), [])
  assert.equal(c.apply('open spot if i'), 'open spot if i')
})

test('save and load round-trip, counts included', async () => {
  const c = fresh(['spot if i', 'Spotify'], ['vs cold', 'vs code'])
  c.apply('open spot if i')
  await store.saveCorrections(c)
  const raw = JSON.parse(readFileSync(join(dir, 'corrections.json'), 'utf8'))
  assert.equal(raw.length, 2)

  const loaded = await store.loadCorrections()
  assert.deepEqual(loaded.list(), c.list())
  assert.equal(loaded.apply('open vs cold'), 'open vs code')
})

test('invalid stored entries are dropped on load, the rest kept', async () => {
  writeFileSync(
    join(dir, 'corrections.json'),
    JSON.stringify([
      { heard: 'spot if i', meant: 'Spotify', count: 1, createdAt: '2026-01-01T00:00:00.000Z', source: 'user' },
      { heard: 'yet', meant: 'yes', count: 0, createdAt: '2026-01-01T00:00:00.000Z', source: 'user' },
      { heard: 'travel', meant: 'jarvis' },
      { meant: 'no heard' },
      'not an entry',
    ]),
  )
  const loaded = await store.loadCorrections()
  assert.deepEqual(loaded.list().map((e) => [e.heard, e.meant]), [['spot if i', 'Spotify']])

  writeFileSync(join(dir, 'corrections.json'), '{ not json')
  assert.deepEqual((await store.loadCorrections()).list(), [])
})
