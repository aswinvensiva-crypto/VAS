import { writeFileSync } from 'node:fs'

/**
 * A stand-in for the Agent SDK's query(), loaded by the bridge when
 * JARVIS_FAKE_SDK=1. It answers every message with "echo: <text>" through the
 * same stream_event / result messages the real SDK emits, and records the
 * options it was given (to JARVIS_FAKE_SDK_DUMP) so tests can check what the
 * bridge would have asked Claude Code for — without spending a turn.
 *
 * Only the shape of the options is recorded: functions and server instances
 * are reduced to their type, and env to its variable names, so no secret is
 * ever written to disk by a test.
 *
 * JARVIS_FAKE_SDK_DELAY_MS pauses mid-answer, the way a real turn spends
 * seconds between its first and last words, so tests can land a second
 * question while the first is still being answered.
 *
 * Two questions act out a PC where Claude cannot answer: one containing
 * "fake:not-logged-in" gets Claude Code's whole-message "Not logged in"
 * result with nothing streamed, and "fake:crash" ends the session the way a
 * claude.exe that dies does.
 */
const DELAY_MS = Number(process.env.JARVIS_FAKE_SDK_DELAY_MS) || 0
function describe(options) {
  return {
    ...options,
    mcpServers: Object.keys(options.mcpServers ?? {}),
    env: options.env ? Object.keys(options.env) : undefined,
    canUseTool: typeof options.canUseTool,
  }
}

export function query({ prompt, options }) {
  if (process.env.JARVIS_FAKE_SDK_DUMP) {
    writeFileSync(process.env.JARVIS_FAKE_SDK_DUMP, JSON.stringify(describe(options), null, 2))
  }

  async function* run() {
    yield {
      type: 'system',
      subtype: 'init',
      mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })),
    }
    for await (const m of prompt) {
      const content = m?.message?.content
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      if (text.includes('fake:not-logged-in')) {
        yield { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0 }
        continue
      }
      if (text.includes('fake:crash')) throw new Error('Claude Code process exited with code 1')
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'echo: ' } },
      }
      if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS))
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      }
      yield { type: 'result', subtype: 'success', result: `echo: ${text}`, total_cost_usd: 0 }
    }
  }

  const session = run()
  session.interrupt = async () => {}
  session.close = () => {
    void session.return?.()
  }
  return session
}
