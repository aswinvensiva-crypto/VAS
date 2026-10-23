/**
 * One boot clock, read by the orb (reactor.ts), the overlay (Boot.tsx) and App,
 * so the three cannot drift apart. Kept out of Boot.tsx so that file only
 * exports components (React Fast Refresh).
 */
export const BOOT = {
  /** The orb's pop (punch, flash, ripples); the wordmark hops and reads SYSTEMS ONLINE. */
  pop: 2100,
  /** The orb's rainbow sweep hands the colour back to the boot phase colour. */
  settle: 2900,
  /** App leaves 'boot' no earlier than this. Was 9200. */
  total: 3600,
} as const

export const BOOT_MS = BOOT.total
