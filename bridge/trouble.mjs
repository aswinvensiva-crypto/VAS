/**
 * What Claude Code says when it cannot answer at all — not signed in, out of
 * usage — is written for its own terminal ("Please run /login"). Said aloud by
 * a desktop app that has no /login, it means nothing; these say what to do.
 * Anything else is passed on as it is.
 */
const CANT_REACH_CLAUDE = [
  [
    /not logged in|please run \/login|invalid api key|oauth (token|session) (has )?expired|could not be refreshed|failed to authenticate|authentication[_ ]failed/i,
    "I can't reach Claude: Claude Code isn't signed in on this PC. Open a terminal, run claude and sign in, then ask me again. Things I do myself, like opening apps, still work.",
  ],
  [
    /usage limit|hit your .*limit|rate limit|credit balance|billing/i,
    "Claude's usage limit is used up for now, so I can't answer that. Try again later. Things I do myself, like opening apps, still work.",
  ],
]
export function plainFailure(text) {
  const s = String(text ?? '')
  for (const [pattern, said] of CANT_REACH_CLAUDE) if (pattern.test(s)) return said
  return null
}

/** Why the Claude session itself stopped, in a sentence the face can show. */
export function sessionTrouble(err) {
  const m = String(err?.message ?? err)
  const plain = plainFailure(m)
  if (plain) return plain
  if (/ENOENT|not found|cannot find/i.test(m)) return "I couldn't start Claude: its program is missing from VAS. Reinstalling VAS should fix that."
  if (/EPERM|EACCES|access is denied|blocked/i.test(m)) return 'Windows, or an antivirus, stopped Claude from starting. Allow VAS in it and ask again.'
  return 'Claude stopped unexpectedly. Ask again; if it keeps happening, check that Claude Code is signed in on this PC.'
}
