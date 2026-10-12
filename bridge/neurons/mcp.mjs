import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { registry } from './registry.mjs'

/**
 * The same neurons, offered to Claude as tools — so "can you get WhatsApp up
 * for me?", which no fixed order matches, still opens WhatsApp the safe way:
 * through the Start-menu catalog and the permission gate, never a shell.
 * The gate asks the user itself, so Claude must not ask first.
 */
const EXPOSED = [
  ['open_app', 'Open a Windows app by its name (as the user says it). Asks the user the first time per app.'],
  ['focus_app', 'Bring an already-open Windows app to the front.'],
  ['close_app', 'Close a Windows app gracefully. Always asks the user first.'],
  ['list_apps', 'How many apps are installed and which are already okayed.'],
  ['chrome_open', "Open a website in a new tab of the user's Chrome."],
  ['list_routines', 'The routines the user has taught.'],
  [
    'teach_routine',
    'Save a routine the user describes: a spoken trigger of two words or more, and the steps it runs, each one ' +
      'thing JARVIS can do directly ("open Spotify", "close Notepad", "switch to VS Code", "go to github.com", ' +
      '"search for the weather", "say good morning", "what time is it"). Asks the user before saving.',
  ],
]

/**
 * The tools themselves, apart from the server so they can be called
 * directly (the tests do). A neuron's answer becomes the tool's text; a
 * refusal or a stop is an error, so Claude does not report it as done.
 */
export function neuronTools(contextFor) {
  return EXPOSED.map(([name, description]) => {
    const neuron = registry.get(name)
    return tool(name, description, neuron.params, async (args) => {
      try {
        const r = (await neuron.run(args, contextFor())) ?? {}
        if (r.fallthrough) return { isError: true, content: [{ type: 'text', text: 'No matching app or site.' }] }
        const text = r.say || 'Done.'
        return r.stop ? { isError: true, content: [{ type: 'text', text }] } : { content: [{ type: 'text', text }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Failed: ${err.message}` }] }
      }
    })
  })
}

export function neuronsServer(contextFor) {
  return createSdkMcpServer({
    name: 'jarvis_neurons',
    version: '1.0.0',
    instructions:
      "JARVIS's own actions on this Windows PC. Use these — never a shell — to open, " +
      'focus or close apps, to open sites, and to save a routine the user asks for. They put ' +
      'any needed yes-or-no to the user themselves; do not ask first, and do not retry ' +
      'something the user refused.',
    alwaysLoad: true,
    tools: neuronTools(contextFor),
  })
}
