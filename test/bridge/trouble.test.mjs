import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainFailure, sessionTrouble } from '../../bridge/trouble.mjs'

/**
 * What JARVIS says when Claude cannot answer at all. Claude Code's own words
 * are written for its terminal ("Please run /login"); these are for someone
 * talking to a desktop app.
 */
test('Claude Code\'s terminal messages become sentences that say what to do', () => {
  for (const said of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'OAuth token has expired']) {
    assert.match(plainFailure(said), /isn't signed in on this PC/, said)
  }
  assert.match(plainFailure("You've hit your session limit · resets 3:50am"), /usage limit/)
  assert.match(plainFailure('Credit balance is too low'), /usage limit/)
  assert.equal(plainFailure('Here is a joke about octopuses.'), null, 'an ordinary answer is left alone')
  assert.equal(plainFailure(undefined), null)
})

test('a session that stops says why, without the stack or exit code', () => {
  assert.match(sessionTrouble(new Error('spawn C:\VAS\claude.exe ENOENT')), /missing from VAS/)
  assert.match(sessionTrouble(new Error('spawn EPERM')), /antivirus/)
  assert.match(sessionTrouble(new Error('Claude Code process exited with code 1')), /stopped unexpectedly/)
  assert.match(sessionTrouble(new Error('Not logged in · Please run /login')), /isn't signed in/)
  assert.doesNotMatch(sessionTrouble(new Error('Claude Code process exited with code 143')), /143/)
})
