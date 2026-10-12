import { utterances } from '../../bridge/voice/utterances.mjs'

/**
 * Preloaded into a test bridge (NODE_OPTIONS --import) so its utterance store
 * already knows a few segments, as if /stt had heard them: some in the
 * owner's voice, some in someone else's. Real verdicts need the voice models
 * and two real people, neither of which a protocol test has.
 *
 * The store's get() is wrapped rather than filled, so this leans only on the
 * shared contract — get(id) -> { owner, raw, text } | null — and not on how
 * the voice package's store files new entries.
 *
 * JARVIS_TEST_UTTERANCES is a JSON map of id -> entry.
 */
const fixed = JSON.parse(process.env.JARVIS_TEST_UTTERANCES ?? '{}')
const get = utterances.get.bind(utterances)
utterances.get = (id) => (Object.hasOwn(fixed, id) ? fixed[id] : get(id))
