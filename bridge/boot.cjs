/**
 * Entry point when the VAS desktop app runs the bridge as an Electron utility
 * process. CommonJS on purpose, so the host never has to care whether its
 * utility processes accept an ES module entry; the bridge itself is ESM and is
 * simply imported. Run from a terminal, `node bridge/server.mjs` is unchanged.
 */
import('./server.mjs').catch((err) => {
  console.error('[jarvis] bridge failed to start:', err)
  process.exit(1)
})
