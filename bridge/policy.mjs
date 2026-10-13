/**
 * The tool gate: which of the agent's tools may run.
 *
 * Voice is a bad interface for a confirmation dialog, so most of the decision
 * is made ahead of time, by name. Read-only and generative tools run freely;
 * anything that writes to disk, runs a shell or changes the world waits for
 * --writes. JARVIS's own in-process servers are allowed by name and enforce
 * their own, finer-grained gates inside their handlers — the place a decision
 * is guaranteed to be consulted, since the CLI can settle some calls without
 * ever asking canUseTool.
 */

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/** MCP tools arrive as `mcp__<server>__<tool>`. */
export const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
export const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * --writes no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

/**
 * JARVIS's own servers, running in the bridge process. Named rather than left
 * to the verb rules, which would read `ui_theme` or `open_app` as writes and
 * hold the whole surface back. Each one gates itself where it matters:
 *   jarvis, jarvis_ui   — the HUD and the interface controls draw on our own
 *                         screen; there is nothing to withhold.
 *   jarvis_chrome       — reading is free; acting on a page asks first.
 *   jarvis_eyes         — looking changes nothing, and the camera's own
 *                         permission and indicator are the real gate.
 *   jarvis_neurons      — apps, routines and corrections, behind the
 *                         per-action permission tiers in the gate.
 */
export const OWN_SERVERS = new Set([
  'jarvis',
  'jarvis_ui',
  'jarvis_chrome',
  'jarvis_eyes',
  'jarvis_neurons',
])

/**
 * The built-in tools the agent is given at all.
 *
 * JARVIS is a voice assistant, not a coding agent: it has no business reading
 * ~/.ssh, editing files or running a shell, and every one of those is a way for
 * a web page it has just read to talk it into something. So by default it gets
 * search and its own planning tools, and the rest are removed from its context
 * entirely — a tool it cannot see is a tool it cannot be tricked into using.
 * --writes restores the full Claude Code toolset, still behind the gate below.
 */
export function sessionTools({ allowWrites }) {
  if (allowWrites) return {}
  return {
    tools: ['WebSearch', 'ToolSearch', 'TodoWrite'],
    disallowedTools: [
      'Bash', 'BashOutput', 'KillShell', 'TaskStop', 'PowerShell',
      'Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      'WebFetch',
    ],
  }
}

/**
 * A tool from an MCP server the user configured rather than one of JARVIS's
 * own — which put any address they send to the taint rule themselves.
 */
export const foreignMcp = (name) => {
  const server = mcpServerOf(name)
  return Boolean(server) && !OWN_SERVERS.has(server)
}

/** Field names that hold an address on their own, scheme or not. */
const ADDRESS_KEY = /^(url|uri|href|link|address|site|domain|website|endpoint)s?$/i

/**
 * Every address a tool's input carries: anything that looks like one in any
 * string, and the whole value of a field named for one ("url": "evil.example/?q=").
 * Generous on purpose — a false hit costs one question.
 *
 * @param {unknown} input
 * @param {(text: string) => string[]} findIn  finds addresses in text (panels.mjs urlsIn)
 */
export function addressesIn(input, findIn) {
  const out = []
  const walk = (value, key) => {
    if (typeof value === 'string') {
      out.push(...findIn(value))
      if (key && ADDRESS_KEY.test(key)) out.push(value)
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, key)
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k)
    }
  }
  walk(input)
  return [...new Set(out)]
}

/** @param {{ allowWrites: boolean }} options */
export function createPolicy({ allowWrites }) {
  function decideTool(name) {
    if (READ_ONLY_BUILTINS.has(name)) return true
    if (WRITE_BUILTINS.has(name)) return allowWrites

    const server = mcpServerOf(name)
    if (server) {
      if (OWN_SERVERS.has(server)) return true

      const tool = mcpToolOf(name)
      if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
        return allowWrites
      }
      // The session tools this bridge is developed inside count as read-only too.
      if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
      return READ_VERB.test(tool) ? true : allowWrites
    }
    return allowWrites
  }
  return { decideTool }
}
