/**
 * Download JARVIS's local voice models into %LOCALAPPDATA%\VAS\models.
 *
 *   npm run models                     # everything
 *   npm run models -- kws speaker      # just these
 *
 * The desktop app does the same thing from its "Download voice models" button.
 */
import { MODELS, fetchModels, modelsDir } from '../bridge/voice/models.mjs'

const asked = process.argv.slice(2)
const names = asked.length ? asked : Object.keys(MODELS)
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`

console.log(`models folder: ${modelsDir()}`)
console.log(`fetching: ${names.map((n) => `${n} (${mb(MODELS[n]?.size ?? 0)})`).join(', ')}`)

const results = await fetchModels(names, ({ file, received, total }) => {
  process.stdout.write(`\r  ${file}: ${mb(received)} / ${mb(total)}   `)
})
process.stdout.write('\n')
for (const [name, r] of Object.entries(results)) {
  const extra = r.prunedBytes ? `, pruned ${mb(r.prunedBytes)} of fp32 duplicates` : ''
  console.log(`${name}: ${r.status}${r.sha256 ? ` sha256 ${r.sha256.slice(0, 16)}…` : ''}${extra}`)
}
