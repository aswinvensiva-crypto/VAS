import { test } from 'node:test'
import assert from 'node:assert/strict'
import { USABLE, chooseVoice, rankVoices, scoreVoice } from '../../src/lib/voiceRank.ts'

/** The English voices a Windows 11 laptop with the en-GB and en-IN packs exposes to Electron. */
const WINDOWS = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Mark - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { name: 'Microsoft George - English (United Kingdom)', lang: 'en-GB' },
  { name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB' },
  { name: 'Microsoft Susan - English (United Kingdom)', lang: 'en-GB' },
  { name: 'Microsoft Ravi - English (India)', lang: 'en-IN' },
  { name: 'Microsoft Heera - English (India)', lang: 'en-IN' },
  { name: 'Microsoft Hortense - French (France)', lang: 'fr-FR' },
]
const named = (part: string) => WINDOWS.find((v) => v.name.includes(part))!

test('Zira, Hazel and Heera are usable, so the picker can reach them', () => {
  for (const name of ['Zira', 'Hazel', 'Heera']) {
    assert.ok(scoreVoice(named(name)) >= USABLE, `${name} scored ${scoreVoice(named(name))}`)
  }
  const cycled = rankVoices(WINDOWS).map((v) => v.name.split(' ')[1])
  for (const name of ['Zira', 'Hazel', 'Heera', 'David', 'Mark', 'George', 'Ravi']) assert.ok(cycled.includes(name), name)
})

test('the British male still leads, and the male voices rank above the female ones', () => {
  const ranked = rankVoices(WINDOWS).map((v) => v.name.split(' ')[1])
  assert.equal(ranked[0], 'George')
  const lastMale = Math.max(...['David', 'Mark', 'Ravi'].map((n) => ranked.indexOf(n)))
  const firstFemale = Math.min(...['Zira', 'Hazel', 'Heera'].map((n) => ranked.indexOf(n)))
  assert.ok(lastMale < firstFemale, ranked.join(', '))
})

test('non-English and penalised voices stay out of the list', () => {
  const ranked = rankVoices(WINDOWS).map((v) => v.name)
  assert.ok(!ranked.some((n) => n.includes('Hortense')))
  assert.ok(!ranked.some((n) => n.includes('Susan')))
})

test('a preferred voice wins whenever it is installed', () => {
  assert.equal(chooseVoice(WINDOWS, 'Microsoft Zira - English (United States)')?.name, named('Zira').name)
  // Even one the ranking would never offer.
  assert.equal(chooseVoice(WINDOWS, 'Microsoft Susan - English (United Kingdom)')?.name, named('Susan').name)
})

test('a missing preferred voice falls back to the ranking', () => {
  assert.equal(chooseVoice(WINDOWS, 'Microsoft Ryan - English (United Kingdom)')?.name, named('George').name)
  assert.equal(chooseVoice(WINDOWS, null)?.name, named('George').name)
})

test('with only unranked English voices, any English voice beats none', () => {
  const odd = [
    { name: 'Some Robot', lang: 'en-US' },
    { name: 'Hortense', lang: 'fr-FR' },
  ]
  assert.equal(chooseVoice(odd, null)?.name, 'Some Robot')
  assert.equal(chooseVoice([{ name: 'Hortense', lang: 'fr-FR' }], null), null)
})
