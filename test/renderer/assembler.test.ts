import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTINUE_MS,
  MAX_HOLD_MS,
  SETTLE_MS,
  holdFor,
  makeAssembler,
} from '../../src/lib/assembler.ts'

/**
 * The assembler decides when a run of transcribed segments is one finished
 * thought. Timers are faked, so "held for 1.6 s" is checked to the
 * millisecond rather than by sleeping.
 */
function rig(t: TestContext) {
  // Not zero: the assembler uses 0 to mean "nothing held yet".
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const emitted: string[] = []
  const partials: string[] = []
  const diag = { holding: '', waitedMs: -1 }
  const a = makeAssembler({
    emit: (text) => emitted.push(text),
    partial: (text) => partials.push(text),
    diag,
  })
  return { a, emitted, partials, diag, tick: (ms: number) => t.mock.timers.tick(ms) }
}

test('holdFor: a terminator sends now, an unfinished clause waits longest', () => {
  assert.equal(holdFor("What's the weather in London?"), 0)
  assert.equal(holdFor('Open Spotify.'), 0)
  assert.equal(holdFor("what's the weather in"), CONTINUE_MS)
  assert.equal(holdFor('open chrome and'), CONTINUE_MS)
  assert.equal(holdFor('first this,'), CONTINUE_MS)
  assert.equal(holdFor(''), CONTINUE_MS)
  // One or two words is usually a start, unless it is a short command.
  assert.equal(holdFor('weather'), CONTINUE_MS)
  assert.equal(holdFor('stop'), SETTLE_MS)
  assert.equal(holdFor('open the calculator app'), SETTLE_MS)
})

test('a finished sentence is sent at once, with nothing held', (t) => {
  const { a, emitted, diag } = rig(t)
  a.feed('What time is it?', false)
  assert.deepEqual(emitted, ['What time is it?'])
  assert.equal(a.held(), '')
  assert.equal(diag.waitedMs, 0)
})

test('a pause mid-sentence holds the first half and joins the second', (t) => {
  const { a, emitted, partials, diag } = rig(t)
  a.feed("what's the weather in", false)
  assert.deepEqual(emitted, [])
  assert.equal(a.held(), "what's the weather in")
  assert.equal(diag.holding, "what's the weather in")
  assert.equal(diag.waitedMs, CONTINUE_MS)
  t.mock.timers.tick(CONTINUE_MS - 1)
  assert.deepEqual(emitted, [], 'still inside the hold')
  a.feed('London?', false)
  assert.deepEqual(emitted, ["what's the weather in London?"])
  // The caption showed the whole thought as it grew.
  assert.equal(partials.at(-1), "what's the weather in London?")
})

test('an unfinished thought is sent anyway once the hold runs out', (t) => {
  const { a, emitted, tick } = rig(t)
  a.feed('open chrome and', false)
  tick(CONTINUE_MS - 1)
  assert.deepEqual(emitted, [])
  tick(1)
  assert.deepEqual(emitted, ['open chrome and'])
  assert.equal(a.held(), '')
})

test('a complete-looking sentence waits only the short settle', (t) => {
  const { a, emitted, tick } = rig(t)
  a.feed('open the calculator app', false)
  tick(SETTLE_MS - 1)
  assert.deepEqual(emitted, [])
  tick(1)
  assert.deepEqual(emitted, ['open the calculator app'])
})

test('while the user is still talking nothing is decided, up to the ceiling', (t) => {
  const { a, emitted, tick } = rig(t)
  a.feed('open the calculator app', true)
  tick(MAX_HOLD_MS - 1)
  assert.deepEqual(emitted, [])
  tick(1)
  assert.deepEqual(emitted, ['open the calculator app'])
})

test('the ceiling counts from the first fragment, not the latest', (t) => {
  const { a, emitted, tick } = rig(t)
  a.feed('first open chrome and', false)
  tick(CONTINUE_MS - 100)
  a.feed('then spotify and', false)
  tick(CONTINUE_MS - 100)
  a.feed('then notepad and', false)
  tick(CONTINUE_MS - 100)
  // 4.5 s in: 1.5 s of the ceiling is left, less than a full continue hold.
  a.feed('then paint and', false)
  tick(MAX_HOLD_MS - 3 * (CONTINUE_MS - 100) - 1)
  assert.deepEqual(emitted, [])
  tick(1)
  assert.deepEqual(emitted, ['first open chrome and then spotify and then notepad and then paint and'])
})

test('flush sends what is held right now; cancel throws it away', (t) => {
  const { a, emitted, diag, tick } = rig(t)
  a.feed('open chrome and', false)
  a.flush()
  assert.deepEqual(emitted, ['open chrome and'])
  a.flush()
  assert.deepEqual(emitted, ['open chrome and'], 'nothing held, nothing sent')

  a.feed('close notepad and', false)
  a.cancel()
  assert.equal(a.held(), '')
  assert.equal(diag.holding, '')
  tick(MAX_HOLD_MS)
  assert.deepEqual(emitted, ['open chrome and'], 'a cancelled hold never fires')
})

test('blank transcripts are ignored', (t) => {
  const { a, emitted, partials } = rig(t)
  a.feed('   ', false)
  assert.deepEqual(emitted, [])
  assert.deepEqual(partials, [])
  assert.equal(a.held(), '')
})
