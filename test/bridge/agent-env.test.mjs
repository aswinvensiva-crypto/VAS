import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentEnv } from '../../bridge/agent-env.mjs'

/**
 * VAS's own claude.exe gets this process's environment, minus the bridge
 * token and minus the wiring of a Claude Code session VAS may have been
 * started from (a terminal in the Claude app, a tool that ran the installer).
 */
test('a launching Claude Code session\'s wiring is dropped; user settings and the rest are kept', () => {
  const env = agentEnv({
    PATH: 'C:\Windows',
    APPDATA: 'C:\Users\me\AppData\Roaming',
    JARVIS_BRIDGE_TOKEN: 'secret',
    CLAUDECODE: '1',
    CLAUDE_PID: '123',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\.\pipe\LOCAL\cc-msg',
    CLAUDE_CODE_MESSAGING_TOKEN: 'host-secret',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
    CLAUDE_AGENT_SDK_VERSION: '0.3.295',
    CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1',
    CLAUDE_CONFIG_DIR: 'D:\claude',
    ANTHROPIC_API_KEY: 'sk-test',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\Git\bin\bash.exe',
    CLAUDE_CODE_OAUTH_TOKEN: 'long-lived',
  })
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY',
    'APPDATA',
    'CLAUDE_CODE_GIT_BASH_PATH',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CONFIG_DIR',
    'PATH',
  ])
})
