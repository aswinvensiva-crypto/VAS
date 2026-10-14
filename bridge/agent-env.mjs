/**
 * The environment VAS's own claude.exe runs with: this process's, minus what
 * it must not inherit.
 *
 * - The bridge token. The agent never needs it and must not be able to read
 *   it back out.
 * - A Claude Code session's own wiring, when VAS was started from inside one
 *   — a terminal in the Claude app, an IDE's terminal, a tool that ran the
 *   installer. That session puts its id, its messaging pipe and token, and
 *   flags like "child session" and "the host refreshes sign-in" into the
 *   environment of everything it starts. Passed on, the claude.exe VAS
 *   starts takes itself for part of that session — talking to its pipe,
 *   waiting on its host for sign-in — instead of being VAS's own.
 *
 * Settings a user sets on purpose stay: an API key, a config folder, Bedrock
 * or Vertex, the Git Bash path, an output limit, a long-lived OAuth token.
 */
const KEEP = new Set([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
])

/** Set by a running Claude Code session for the processes it starts. */
const SESSION_WIRING = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_PREVIEW_\w+|CLAUDE_AGENT_SDK_\w+|CLAUDE_CODE_\w+)$/

/** @param {Record<string, string | undefined>} env @returns {Record<string, string>} */
export function agentEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) => v !== undefined && k !== 'JARVIS_BRIDGE_TOKEN' && !(SESSION_WIRING.test(k) && !KEEP.has(k)),
    ),
  )
}
