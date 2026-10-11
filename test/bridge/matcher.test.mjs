import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MATCH_TYPES, match, normalize, parseTemplate, rankMatches } from '../../bridge/neurons/matcher.mjs'

const lit = (word) => ({ type: 'lit', word })
const v = (name) => ({ type: 'var', name })

// normalize

test('normalize: norm is lowercase, orig keeps case, and they stay aligned', () => {
  const w = normalize('Open Visual Studio Code')
  assert.deepEqual(w.norm, ['open', 'visual', 'studio', 'code'])
  assert.deepEqual(w.orig, ['Open', 'Visual', 'Studio', 'Code'])
})

test('normalize: punctuation goes, in-word apostrophes stay, quote marks go', () => {
  assert.deepEqual(normalize('What\'s the time?!').norm, ['what\'s', 'the', 'time'])
  assert.deepEqual(normalize('what’s up').norm, ['what\'s', 'up']) // curly apostrophe from the recogniser
  assert.deepEqual(normalize('say \'hello\', world... wi-fi').norm, ['say', 'hello', 'world', 'wi', 'fi'])
})

test('normalize: symbols people say aloud become words', () => {
  assert.deepEqual(normalize('open Notepad++').orig, ['open', 'Notepad', 'plus', 'plus'])
  assert.deepEqual(normalize('learn C+').norm, ['learn', 'c', 'plus'])
  assert.deepEqual(normalize('Tom & Jerry').norm, ['tom', 'and', 'jerry'])
})

test('normalize: NFKC folds full-width letters and ligatures', () => {
  assert.deepEqual(normalize('ｏｐｅｎ the ﬁle').norm, ['open', 'the', 'file'])
})

test('normalize: digits survive, and a decimal or time stays one word', () => {
  assert.deepEqual(normalize('set volume to 0.5.').orig, ['set', 'volume', 'to', '0.5'])
  assert.deepEqual(normalize('timer at 2:30, then 40').orig, ['timer', 'at', '2:30', 'then', '40'])
})

test('normalize: wake phrase is cut, in any listed spelling, with or without a greeting', () => {
  assert.deepEqual(normalize('Hey Jarvis, open notepad').norm, ['open', 'notepad'])
  assert.deepEqual(normalize('Jarvis open notepad').norm, ['open', 'notepad'])
  assert.deepEqual(normalize('okay travis: open notepad').norm, ['open', 'notepad'])
  assert.deepEqual(normalize('Hey Jarvis').norm, [])
})

test('normalize: a greeting with no name after it is not a wake phrase', () => {
  assert.deepEqual(normalize('hey open notepad').norm, ['hey', 'open', 'notepad'])
  assert.deepEqual(normalize('open jarvis notes').norm, ['open', 'jarvis', 'notes'])
})

test('normalize: fillers are cut at the edges only, stacked ones too', () => {
  assert.deepEqual(
    normalize('Hey Jarvis, can you please open notepad for me please').orig,
    ['open', 'notepad'],
  )
  assert.deepEqual(normalize('Could you turn the lights off?').norm, ['turn', 'the', 'lights', 'off'])
  assert.deepEqual(normalize('tell me if you can you know').norm, ['tell', 'me', 'if', 'you', 'can', 'you', 'know'])
})

// parseTemplate

test('parseTemplate: every brace spacing is the same variable', () => {
  const want = [lit('this'), lit('is'), lit('the'), v('order')]
  for (const t of ['this is the {{order}}', 'this is the {{ order }}', 'this is the {{order }}', 'this is the {{ order}}']) {
    assert.deepEqual(parseTemplate(t).tokens, want, t)
  }
})

test('parseTemplate: single or unbalanced braces are plain text', () => {
  assert.deepEqual(parseTemplate('this is the {order}').tokens, [lit('this'), lit('is'), lit('the'), lit('order')])
  assert.deepEqual(parseTemplate('this is the { order}}').tokens, [lit('this'), lit('is'), lit('the'), lit('order')])
})

test('parseTemplate: literals are normalized and trimmed exactly like utterances', () => {
  assert.deepEqual(parseTemplate('Can you open Notepad++, {{ file }} for me').tokens, [
    lit('open'), lit('notepad'), lit('plus'), lit('plus'), v('file'),
  ])
  assert.deepEqual(parseTemplate('Hey Jarvis, what\'s the time?').tokens, [lit('what\'s'), lit('the'), lit('time')])
})

test('parseTemplate: adjacent variables are refused, even with punctuation between', () => {
  assert.throws(() => parseTemplate('play {{song}} {{artist}}'), /adjacent/)
  assert.throws(() => parseTemplate('play {{song}}, {{artist}}'), /adjacent/)
  assert.throws(() => parseTemplate('{{a}}{{b}} now'), /adjacent/)
})

test('parseTemplate: an order with no words is refused', () => {
  for (const t of ['', '   ', '?!', 'please', 'hey jarvis', undefined]) {
    assert.throws(() => parseTemplate(t), /no words/, String(t))
  }
})

test('parseTemplate: the same variable twice is refused', () => {
  assert.throws(() => parseTemplate('copy {{x}} to {{x}}'), /repeats/)
})

// match types

test('normal: all literal words present, any order, extra words allowed', () => {
  assert.ok(match('lights off', 'turn the lights off now'))
  assert.ok(match('lights off', 'off with the lights'))
  assert.equal(match('lights off', 'lights on'), null)
})

test('normal: repeated literal words must be said as many times', () => {
  assert.equal(match('the cat and the dog', 'the cat and dog'), null)
  assert.ok(match('the cat and the dog', 'dog and the cat the'))
})

test('strict: nothing beyond the template, but order is free', () => {
  assert.ok(match('lights off', 'off lights', { type: 'strict' }))
  assert.equal(match('lights off', 'lights off now', { type: 'strict' }), null)
  assert.deepEqual(match('open {{app}}', 'open Visual Studio', { type: 'strict' }).params, { app: 'Visual Studio' })
  assert.equal(match('open {{app}} now', 'um open notepad now', { type: 'strict' }), null)
  assert.deepEqual(match('open {{app}} now', 'um open notepad now').params, { app: 'notepad' }) // normal skips "um"
})

test('ordered-strict: the filled-in template is exactly what was said', () => {
  assert.ok(match('sentence 5 with specific order', 'Sentence 5, with specific order.', { type: 'ordered-strict' }))
  assert.equal(match('sentence 5 with specific order', 'order specific with 5 sentence', { type: 'ordered-strict' }), null)
  assert.ok(match('sentence 5 with specific order', 'order specific with 5 sentence', { type: 'strict' }))
  assert.deepEqual(
    match('remind me to {{task}} at {{time}}', 'remind me to Call Mum at 6:30', { type: 'ordered-strict' }).params,
    { task: 'Call Mum', time: '6:30' },
  )
  assert.equal(match('remind me to {{task}}', 'please remind me to call mum now ok', { type: 'ordered-strict' }).params.task, 'call mum now ok')
  assert.equal(match('open {{app}} now', 'open notepad now please and', { type: 'ordered-strict' }), null)
})

test('not-contain: a normal match with none of the excluded words', () => {
  const opts = { type: 'not-contain', excluded: ['in', 'Out'] }
  assert.ok(match('testing the not contain', 'testing the not contain', opts))
  assert.equal(match('testing the not contain', 'testing the not contain in', opts), null)
  assert.equal(match('testing the not contain', 'in testing the not contain', opts), null)
  assert.equal(match('testing the not contain', 'testing the OUT not contain', opts), null)
  assert.ok(match('testing the not contain', 'testing the not contain in', { excluded: ['in'] })) // only not-contain looks
})

test('unknown match type is an error, not a silent fallback', () => {
  assert.throws(() => match('a', 'a', { type: 'fuzzy' }), /unknown match type/)
  assert.deepEqual(MATCH_TYPES, ['ordered-strict', 'strict', 'normal', 'not-contain'])
})

// parameter extraction

test('params: at the start, in the middle and at the end', () => {
  assert.deepEqual(match('{{ sentence }} this is the end', 'hello world this is the end').params, { sentence: 'hello world' })
  assert.deepEqual(match('this is {{ thing }} the end', 'this is Value the end').params, { thing: 'Value' })
  assert.deepEqual(match('this is the {{ sentence }}', 'this is the value with multiple words').params, {
    sentence: 'value with multiple words',
  })
})

test('params: two variables split on the literals between them', () => {
  assert.deepEqual(
    match('this is the {{ sentence }} with multiple {{ params }}', 'this is the multiple values with multiple values as words').params,
    { sentence: 'multiple values', params: 'values as words' },
  )
})

test('params: the first occurrence of the stop word ends the variable', () => {
  assert.deepEqual(match('play {{song}} by {{artist}}', 'play Stand by Me by Ben E King').params, {
    song: 'Stand', artist: 'Me by Ben E King',
  })
})

test('params: case, digits and apostrophes come back as said', () => {
  assert.deepEqual(match('open {{app}}', 'Open VS Code 2022').params, { app: 'VS Code 2022' })
  assert.deepEqual(match('set volume to {{level}}', 'set volume to 0.75').params, { level: '0.75' })
  assert.deepEqual(match('what\'s on {{day}}', 'What’s on Valentine\'s Day?').params, { day: 'Valentine\'s Day' })
})

test('params: symbols spoken as words, through to the value', () => {
  assert.deepEqual(match('open {{app}}', 'open Notepad++').params, { app: 'Notepad plus plus' })
  assert.deepEqual(match('open notepad plus plus', 'open notepad++', { type: 'ordered-strict' }).params, {})
})

test('params: wake phrase and fillers never leak into a value', () => {
  assert.deepEqual(match('open {{app}}', 'Hey Jarvis, could you open Spotify for me please').params, { app: 'Spotify' })
  assert.deepEqual(match('{{query}} on youtube', 'Jarvis, please lo-fi beats on YouTube').params, { query: 'lo fi beats' })
})

test('params: a variable that captures nothing is no match', () => {
  assert.equal(match('open {{app}}', 'open'), null)
  assert.equal(match('open {{app}}', 'Jarvis open please'), null)
  assert.equal(match('{{song}} by {{artist}}', 'by Queen'), null)
  assert.equal(match('play {{song}} by {{artist}}', 'play by Queen'), null)
})

test('params: a stop word that never comes after the variable is no match', () => {
  assert.equal(match('play {{song}} by {{artist}}', 'by the way play something'), null)
})

test('a template of only variables matches nothing unless allowed', () => {
  assert.equal(match('{{anything}}', 'do the thing'), null)
  assert.deepEqual(match('{{anything}}', 'Do the thing', { allowVarOnly: true }), {
    params: { anything: 'Do the thing' }, literals: 0, coverage: 0,
  })
})

test('empty input never matches', () => {
  assert.equal(match('{{anything}}', 'Hey Jarvis', { allowVarOnly: true }), null)
  assert.equal(match('open', ''), null)
})

test('coverage is literal words over input words', () => {
  assert.equal(match('open {{app}}', 'open notepad').coverage, 1 / 2)
  assert.equal(match('work mode', 'work mode').coverage, 1)
  assert.deepEqual(match('lights off', 'please turn the lights off'), { params: {}, literals: 2, coverage: 2 / 4 })
})

test('accepts a parsed template and a normalized input', () => {
  const t = parseTemplate('open {{app}}')
  const said = normalize('Jarvis, open Paint')
  assert.deepEqual(match(t, said).params, { app: 'Paint' })
  assert.deepEqual(match(t, said), match('open {{app}}', 'Jarvis, open Paint'))
})

// ranking

test('rank: an exact routine beats a general one', () => {
  const neurons = [
    { order: 'open {{app}}', type: 'normal', source: 'default', index: 0 },
    { order: 'work mode', type: 'normal', source: 'user', index: 1 },
  ]
  const candidates = (said) => neurons.flatMap((n) => {
    const m = match(n.order, said, { type: n.type })
    return m ? [{ ...n, ...m }] : []
  })
  const exact = rankMatches(candidates('work mode'))
  assert.equal(exact[0].order, 'work mode')
  assert.equal(exact[0].coverage, 1)
  // Both fit here; the routine explains 2 of 3 words, "open {{app}}" only 1.
  const both = rankMatches(candidates('open work mode'))
  assert.deepEqual(both.map((c) => c.order), ['work mode', 'open {{app}}'])
  assert.deepEqual(both[1].params, { app: 'work mode' })
})

test('rank: coverage, then user before default, then match type, then index', () => {
  const c = (id, coverage, source, type, index) => ({ id, coverage, source, type, index })
  const cands = [
    c('a', 0.5, 'default', 'ordered-strict', 0),
    c('b', 0.5, 'user', 'not-contain', 9),
    c('c', 1, 'default', 'normal', 5),
    c('d', 0.5, 'user', 'strict', 3),
    c('e', 0.5, 'user', 'strict', 1),
    c('f', 0.5, 'user', 'ordered-strict', 7),
  ]
  const before = cands.map((x) => x.id)
  assert.deepEqual(rankMatches(cands).map((x) => x.id), ['c', 'f', 'e', 'd', 'b', 'a'])
  assert.deepEqual(cands.map((x) => x.id), before) // a new array; the input is untouched
})

test('rank: user beats default at equal coverage, whatever the index', () => {
  const ranked = rankMatches([
    { coverage: 1, source: 'default', type: 'normal', index: 0 },
    { coverage: 1, source: 'user', type: 'normal', index: 12 },
  ])
  assert.equal(ranked[0].source, 'user')
})
