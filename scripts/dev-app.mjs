/**
 * Develop the desktop app: Vite for the face (with hot reload), then VAS
 * itself pointed at it. Closing VAS stops Vite.
 *
 *   npm run dev              # window shown
 *   npm run dev -- --hidden  # start in the tray, as it will at login
 *
 * Vite runs on 5174 so it can sit alongside a plain browser `npm start`
 * (5173); both are inside the dev-port range the bridge accepts.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vendorWasm } from './vendor-wasm.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.VAS_DEV_PORT ?? 5174)
const URL_ = `http://localhost:${PORT}`

vendorWasm()

const vite = spawn(
  process.execPath,
  [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'inherit' },
)
vite.on('exit', (code) => {
  console.log(`vite exited (${code})`)
  process.exit(code ?? 0)
})

// Wait until the dev server actually answers before opening the window.
for (let i = 0; ; i++) {
  try {
    const res = await fetch(URL_)
    if (res.ok) break
  } catch {
    /* not up yet */
  }
  if (i > 150) {
    console.error(`vite did not come up on ${URL_}`)
    vite.kill()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 200))
}

const electron = createRequire(import.meta.url)('electron')
const app = spawn(electron, ['.', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, VAS_DEV_URL: URL_, ELECTRON_RUN_AS_NODE: '' },
})
app.on('exit', (code) => {
  vite.kill()
  process.exit(code ?? 0)
})
