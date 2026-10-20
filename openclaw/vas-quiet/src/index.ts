import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Keep this Gateway's own agent silent.
 *
 * VAS uses OpenClaw as a messaging engine: your WhatsApp and Telegram accept
 * messages so that VAS can read them, and every one would otherwise start an
 * OpenClaw agent turn that might answer your contacts. This Gateway has no
 * model and `session.sendPolicy` denies automatic replies on both channels;
 * this hook is the third lock — every agent turn is answered here, with
 * nothing, before any model is asked.
 *
 * VAS itself never needs an agent turn: it calls tools directly.
 */
export default definePluginEntry({
  id: "vas-quiet",
  name: "VAS Quiet",
  description: "Silence OpenClaw's own agent: no automatic replies to anyone.",
  register(api) {
    api.on("before_agent_reply", () => ({ handled: true }), { eligibleTriggers: ["user"] });
  },
});
