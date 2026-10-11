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
 * @param {{ name: string, phones: string[], boost: number, threshold: number, enabled?: boolean }[]} keywords
 * @param {Set<string>} tokens
 */
export function keywordLines(keywords, tokens) {
  const lines = []
  const errors = []
  for (const k of keywords) {
    if (k.enabled === false) continue
    for (const phones of k.phones) {
      const parts = phones.trim().split(/\s+/)
      const unknown = parts.filter((p) => !tokens.has(p))
      if (unknown.length) {
        errors.push(`${k.name}: unknown phone(s) ${unknown.join(', ')} in "${phones}"`)
        continue
      }
      lines.push(`${parts.join(' ')} :${k.boost} #${k.threshold} @${k.name}`)
    }
  }
  return { lines, errors }
}

/** Write the keywords file the spotter loads; returns its path and any problems. */
export function writeKeywordsFile(keywords, modelDir, outDir) {
  const { lines, errors } = keywordLines(keywords, readTokens(modelDir))
  const path = join(outDir, 'keywords.txt')
  writeFileSync(path, lines.join('\n') + '\n')
  return { path, count: lines.length, errors }
}

/** Phones for a word or phrase, from the model's lexicon (en.phone), or null. */
export function phonesFor(text, modelDir) {
  const lexicon = new Map()
  for (const line of readFileSync(join(modelDir, 'en.phone'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf(' ')
    if (i > 0 && !lexicon.has(line.slice(0, i))) lexicon.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  const out = []
  for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    const p = lexicon.get(word)
    if (!p) return null
    out.push(p)
  }
  return out.join(' ')
}
