import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BARE_NAME, LEADING_NAME, OVERRIDE, WAKE, afterWake } from '../../src/lib/wakeWords.ts'

test('wakes on his name and the usual mishearings', () => {
  for (const s of ['hey jarvis', 'Jarvis', 'ok Jervis', 'hi travis', "java's", 'yo jarvys what time is it']) {
    assert.ok(WAKE.test(s), s)
  }
})

test('does not wake on a possessive or on unrelated words', () => {
  for (const s of ["Jarvis's job is done", 'the service is down', 'harvest moon', 'jars of jam']) {
    assert.equal(WAKE.test(s), false, s)
  }
})

test('afterWake returns the command that followed the name', () => {
  assert.equal(afterWake('Hey Jarvis, open Spotify'), 'open Spotify')
  assert.equal(afterWake('jarvis'), '')
  assert.equal(afterWake('nothing here'), '')
})

test('bare and leading vocatives', () => {
  assert.ok(BARE_NAME.test('Hey Jarvis.'))
  assert.equal(BARE_NAME.test('Hey Jarvis, open chrome'), false)
  assert.equal('Travis: what is the time'.replace(LEADING_NAME, ''), 'what is the time')
})

test('override words always cut through', () => {
  for (const s of ['stop', 'wait a second', 'jarvis', 'never mind', 'no']) assert.ok(OVERRIDE.test(s), s)
  assert.equal(OVERRIDE.test('open notepad'), false)
})
