import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUtterances, utterances } from '../../bridge/voice/utterances.mjs'

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t }
  return c
}

test('put returns an opaque id; get gives back who said it and what was heard', () => {
  const store = createUtterances()
  const id = store.put({ text: 'open Spotify', raw: 'open spot if i', owner: 'owner', score: 0.81, durationMs: 1840, mode: 'command' })
  assert.match(id, /^[\w-]{12}$/)
  const u = store.get(id)
  assert.equal(u.text, 'open Spotify')
  assert.equal(u.raw, 'open spot if i')
  assert.equal(u.owner, 'owner')
  assert.equal(u.durationMs, 1840)
  assert.equal(u.mode, 'command')
  assert.equal(typeof u.at, 'number')
  assert.notEqual(store.put({ text: 'x' }), id)
})

test('defaults: raw is the text, an unrecognised verdict is unknown', () => {
  const store = createUtterances()
  const u = store.get(store.put({ text: 'yes', owner: 'probably-me' }))
  assert.deepEqual([u.raw, u.owner, u.durationMs, u.mode], ['yes', 'unknown', null, null])
  assert.equal(store.get(store.put({ text: 'yes', owner: 'unenrolled' })).owner, 'unenrolled')
})

test('unknown, malformed and expired ids are null', () => {
  const c = clock()
  const store = createUtterances({ now: c.now })
  const id = store.put({ text: 'open Spotify', owner: 'owner' })
  assert.equal(store.get('nope'), null)
  assert.equal(store.get(undefined), null)
  assert.equal(store.get({ id }), null)
  c.t += 119_000
  assert.equal(store.get(id).text, 'open Spotify')
  c.t += 2_000 // past two minutes
  assert.equal(store.get(id), null)
  assert.equal(store.size, 0)
})

test('the store is capped: the oldest segment goes first', () => {
  const store = createUtterances({ max: 3 })
  const ids = ['a', 'b', 'c', 'd'].map((text) => store.put({ text }))
  assert.equal(store.size, 3)
  assert.equal(store.get(ids[0]), null)
  assert.equal(store.get(ids[3]).text, 'd')
})

test('get returns a copy: a caller cannot rewrite what was heard', () => {
  const store = createUtterances()
  const id = store.put({ text: 'yes', owner: 'other' })
  store.get(id).owner = 'owner'
  assert.equal(store.get(id).owner, 'other')
})

test('there is one shared default store', () => {
  const id = utterances.put({ text: 'hello', owner: 'unknown' })
  assert.equal(utterances.get(id).text, 'hello')
})
