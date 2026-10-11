import * as basic from './lib/basic.mjs'
import * as apps from './lib/apps.mjs'
import * as chrome from './lib/chrome.mjs'
import * as learning from './lib/learning.mjs'

/**
 * Every neuron JARVIS has, by name. Listed explicitly rather than discovered
 * from the filesystem: a neuron is code that acts on your PC, and nothing
 * should become one by being dropped into a folder.
 */
const modules = [basic, apps, chrome, learning]

export const registry = new Map()
for (const mod of modules) {
  for (const value of Object.values(mod)) {
    if (value && typeof value === 'object' && typeof value.run === 'function' && value.name) {
      registry.set(value.name, value)
    }
  }
}
