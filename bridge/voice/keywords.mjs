import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The wake phrase, as the keyword spotter needs it written.
 *
 * The spotter listens for a sequence of phones, not for letters, so "Hey
 * Jarvis" is configured as `HH EY1 JH AA1 R V AH0 S` (with alternatives for how
 * people actually say it). Each line of the keywords file is
 *   <phones> :<boost> #<threshold> @<NAME>
 * — no space after ':' or '#'. A phone the model does not know would make the
 * whole spotter fail to load, so every phone is checked against the model's
 * own token list first and a bad entry is reported and skipped, not fatal.
 *
 * A keyword can also be given as plain words ("hey friday"): those are looked
 * up in the model's own pronouncing dictionary (en.phone) when the file is
 * built, so nobody has to learn ARPAbet to add a wake word.
 */

/** The model's phone inventory, from its tokens.txt ("<token> <id>" per line). */
export function readTokens(modelDir) {
  const set = new Set()
  for (const line of readFileSync(join(modelDir, 'tokens.txt'), 'utf8').split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/)[0]
    if (tok) set.add(tok)
  }
  return set
}

/**
 * The model's pronouncing dictionary, en.phone ("WORD PH ON ES" per line),
 * keeping the first pronunciation of each word. About 126,000 words, so it is
 * read only when some keyword is written as words.
 * @returns {Map<string, string>}
 */
export function readLexicon(modelDir) {
  const lexicon = new Map()
  for (const line of readFileSync(join(modelDir, 'en.phone'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf(' ')
    if (i > 0 && !lexicon.has(line.slice(0, i))) lexicon.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  return lexicon
}

/** A phrase as the dictionary spells its words: upper case, punctuation gone, apostrophes kept ("WHAT'S"). */
const wordsOf = (text) =>
  String(text ?? '')
    .replace(/[‘’]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z0-9']+/g, ' ')
    .split(' ')
    .filter(Boolean)

/**
 * Phones for a word or phrase, from the model's lexicon (en.phone), or null
 * when any of its words is not in it. Pass `lexicon` (readLexicon) to look up
 * several phrases without reading the dictionary each time.
 */
export function phonesFor(text, modelDir, lexicon = readLexicon(modelDir)) {
  const words = wordsOf(text)
  const phones = words.map((w) => lexicon.get(w))
  return words.length && phones.every(Boolean) ? phones.join(' ') : null
}

/**
 * Every phone sequence a keyword can be heard as: its own `phones`, then each
 * of its `phrases` looked up in the dictionary. A phrase that cannot be looked
 * up is reported, not fatal.
 */
function variantsOf(k, lexicon, errors) {
  const out = [...(k.phones ?? [])]
  for (const phrase of k.phrases ?? []) {
    const phones = lexicon ? phonesFor(phrase, null, lexicon) : null
    if (phones) {
      out.push(phones)
      continue
    }
    const missing = lexicon ? wordsOf(phrase).filter((w) => !lexicon.has(w)) : []
    errors.push(
      `${k.name}: cannot say "${phrase}" — ` +
        (lexicon ? (missing.length ? `no pronunciation for ${missing.join(', ')}` : 'no words in it') : 'the dictionary (en.phone) is missing'),
    )
  }
  return out
}

/**
 * @param {{ name: string, phones?: string[], phrases?: string[], boost: number, threshold: number, enabled?: boolean }[]} keywords
 * @param {Set<string>} tokens
 * @param {Map<string, string> | null} [lexicon]  needed only for keywords given as phrases
 */
export function keywordLines(keywords, tokens, lexicon = null) {
  const lines = []
  const errors = []
  for (const k of keywords) {
    if (k.enabled === false) continue
    // A phrase that comes out the same as a phone string already listed is one line, not two.
    for (const phones of new Set(variantsOf(k, lexicon, errors).map((p) => p.trim().split(/\s+/).join(' ')))) {
      const parts = phones.split(' ')
      const unknown = parts.filter((p) => !tokens.has(p))
      if (unknown.length) {
        errors.push(`${k.name}: unknown phone(s) ${unknown.join(', ')} in "${phones}"`)
        continue
      }
      lines.push(`${phones} :${k.boost} #${k.threshold} @${k.name}`)
    }
  }
  return { lines, errors }
}

/**
 * Write a keywords file the spotter loads (keywords.txt, unless `name` says
 * otherwise); returns its path and any problems.
 */
export function writeKeywordsFile(keywords, modelDir, outDir, name = 'keywords.txt') {
  const wantsWords = keywords.some((k) => k.enabled !== false && k.phrases?.length)
  let lexicon = null
  if (wantsWords) {
    try {
      lexicon = readLexicon(modelDir)
    } catch {
      // Reported per phrase by keywordLines; keywords written as phones still work.
    }
  }
  const { lines, errors } = keywordLines(keywords, readTokens(modelDir), lexicon)
  const path = join(outDir, name)
  writeFileSync(path, lines.join('\n') + '\n')
  return { path, count: lines.length, errors }
}
