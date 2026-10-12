import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANSWER_GAP_MS,
  CONTINUE_MS,
  MAX_HOLD_MS,
  SETTLE_MS,
  answersQuestion,
  holdFor,
  makeAssembler,
  type Heard,
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
  const heard: Heard[] = []
  const partials: string[] = []
  const diag = { holding: '', waitedMs: -1 }
  const a = makeAssembler({
    emit: (text, h) => {
      emitted.push(text)
      heard.push(h)
    },
    partial: (text) => partials.push(text),
    diag,
  })
  return { a, emitted, heard, partials, diag, tick: (ms: number) => t.mock.timers.tick(ms) }
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

test('the utterance carries every segment\'s raw words and id, in order', (t) => {
  const { a, emitted, heard } = rig(t)
  a.feed('open spotify and', false, { raw: 'open spot if i and', utt: 'u1' })
  a.feed('close notepad.', false, { raw: 'close note pad.', utt: 'u2' })
  assert.deepEqual(emitted, ['open spotify and close notepad.'])
  assert.deepEqual(heard, [{ raw: 'open spot if i and close note pad.', utts: ['u1', 'u2'] }])
})

test('without the bridge\'s word on it, the words are the raw words and there are no ids', (t) => {
  const { a, heard } = rig(t)
  a.feed('what time is it?', false)
  assert.deepEqual(heard, [{ raw: 'what time is it?', utts: [] }])
})

test('a cancelled or sent utterance takes its ids with it', (t) => {
  const { a, heard } = rig(t)
  a.feed('open chrome and', false, { raw: 'open chrome and', utt: 'stale' })
  a.cancel()
  a.feed('what time is it?', false, { raw: 'what tim is it?', utt: 'u2' })
  a.feed('Thanks.', false, { utt: 'u3' })
  assert.deepEqual(heard, [
    { raw: 'what tim is it?', utts: ['u2'] },
    { raw: 'Thanks.', utts: ['u3'] },
  ])
})

test('blank transcripts are ignored', (t) => {
  const { a, emitted, partials } = rig(t)
  a.feed('   ', false)
  assert.deepEqual(emitted, [])
  assert.deepEqual(partials, [])
  assert.equal(a.held(), '')
})

// A "shall I?" is answered only by speech that began once it had finished.

test('nothing said while the question is still playing can answer it', () => {
  const playing = { questionEnd: Infinity, spokeUntil: 0 }
  assert.equal(answersQuestion(1_000_000, playing), false)
  assert.equal(answersQuestion(Number.MAX_SAFE_INTEGER, playing), false)
})

test('speech that began inside the margin after the question is its echo, not its answer', () => {
  const ended = { questionEnd: 10_000, spokeUntil: 9_990 }
  assert.equal(answersQuestion(9_000, ended), false, 'began over the question')
  assert.equal(answersQuestion(10_000 + ANSWER_GAP_MS - 1, ended), false, 'its last syllable, still arriving')
  assert.equal(answersQuestion(10_000 + ANSWER_GAP_MS, ended), true, 'began after it')
})

test('if he was still talking after the question, the margin runs from when he stopped', () => {
  // The turn's own sentence ran on past the question's last word.
  const overran = { questionEnd: 10_000, spokeUntil: 11_000 }
  assert.equal(answersQuestion(10_000 + ANSWER_GAP_MS, overran), false)
  assert.equal(answersQuestion(11_000 + ANSWER_GAP_MS, overran), true)
})
