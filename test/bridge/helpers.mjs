import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Speak `phrases` with a Windows SAPI voice into 16 kHz mono WAV files.
 * `voice` picks among the installed English voices (0, 1, ...), so tests can
 * have two different "people". Returns { name: path } or null where speech
 * synthesis (or that voice) is unavailable.
 */
export function synthesize(phrases, { voice = 0 } = {}) {
  if (process.platform !== 'win32') return null
  const dir = mkdtempSync(join(tmpdir(), 'vas-say-'))
  const spec = join(dir, 'spec.json')
  writeFileSync(spec, JSON.stringify({ dir, phrases, voice }))
  const script = join(dir, 'say.ps1')
  writeFileSync(
    script,
    `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$spec = Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' })
if ($spec.voice -ge $voices.Count) { exit 3 }
$s.SelectVoice($voices[$spec.voice].VoiceInfo.Name)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($p in $spec.phrases.PSObject.Properties) {
  $s.SetOutputToWaveFile((Join-Path $spec.dir ($p.Name + '.wav')), $fmt); $s.Speak($p.Value); $s.SetOutputToNull()
}`,
  )
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, spec], { windowsHide: true, stdio: 'ignore' })
  } catch {
    return null
  }
  return Object.fromEntries(Object.keys(phrases).map((k) => [k, join(dir, `${k}.wav`)]))
}
