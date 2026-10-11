import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Start a real bridge process on an OS-assigned loopback port, with the fake
 * SDK and a throwaway data folder. Resolves once it reports the port.
 * Always call stop() — it kills exactly this child, by its own handle.
 */
export async function startBridge({ token = 'test-token-0123456789abcdef', env = {}, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vas-test-'))
  const dump = join(dir, 'sdk-options.json')
  const child = spawn(process.execPath, [join(ROOT, 'bridge', 'server.mjs'), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      JARVIS_FAKE_SDK: '1',
      JARVIS_FAKE_SDK_DUMP: dump,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_DATA_DIR: join(dir, 'data'),
      ...(token ? { JARVIS_BRIDGE_TOKEN: token } : { JARVIS_BRIDGE_TOKEN: '' }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start:\n${log}`)), 20_000)
    const onData = (chunk) => {
      log += chunk
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`bridge exited (${code}):\n${log}`)))
  })
  return {
    port,
    token,
    dump,
    dataDir: join(dir, 'data'),
    log: () => log,
    stop: async () => {
      child.removeAllListeners('exit')
      child.kill()
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
