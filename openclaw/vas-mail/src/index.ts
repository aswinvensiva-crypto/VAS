import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { listMail, readMail, sendMail, type MailConfig } from "./mail.js";

/**
 * Gmail for VAS: send, list and read, over SMTP and IMAP with an app password.
 *
 * OpenClaw has no email sender (its imap extension only starts an agent when
 * mail arrives), so VAS brings these three tools. They are meant to be called
 * by VAS alone, through the Gateway's /tools/invoke as the `vas` agent, after
 * VAS has read the message back to you and you said yes. The `main` agent is
 * configured to deny them (agents.entries.main.tools.deny), and this Gateway
 * has no model, so nothing else can reach them.
 *
 * Reading never changes the mailbox: messages are fetched with BODY.PEEK and
 * stay unread.
 */
const Secret = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    { source: Type.String(), provider: Type.String(), id: Type.String() },
    { additionalProperties: false },
  ),
]);

export default defineToolPlugin({
  id: "vas-mail",
  name: "VAS Mail",
  description: "Gmail send, list and read for the VAS desktop assistant.",
  configSchema: Type.Object({
    user: Type.String({ description: "Your Gmail address." }),
    appPassword: Secret,
    smtpHost: Type.Optional(Type.String({ default: "smtp.gmail.com" })),
    imapHost: Type.Optional(Type.String({ default: "imap.gmail.com" })),
  }),
  tools: (tool) => [
    tool({
      name: "vas_mail_send",
      label: "Send email",
      description: "Send a plain-text email from the configured Gmail account. VAS confirms with the user first.",
      optional: true,
      parameters: Type.Object({
        to: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
        cc: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
        subject: Type.String({ maxLength: 300 }),
        body: Type.String({ maxLength: 20000 }),
      }),
      async execute(params, config, context) {
        context.signal?.throwIfAborted();
        return sendMail(config as MailConfig, params);
      },
    }),
    tool({
      name: "vas_mail_list",
      label: "List email",
      description: "Recent messages in the inbox: sender, subject, date, whether unread, and whether the sender is verified.",
      optional: true,
      parameters: Type.Object({
        unreadOnly: Type.Optional(Type.Boolean()),
        from: Type.Optional(Type.String({ maxLength: 200 })),
        sinceHours: Type.Optional(Type.Number({ minimum: 1, maximum: 720 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
      }),
      async execute(params, config, context) {
        context.signal?.throwIfAborted();
        return { messages: await listMail(config as MailConfig, params) };
      },
    }),
    tool({
      name: "vas_mail_read",
      label: "Read email",
      description: "One message's text by uid, without marking it read.",
      optional: true,
      parameters: Type.Object({ uid: Type.Number() }),
      async execute({ uid }, config, context) {
        context.signal?.throwIfAborted();
        return readMail(config as MailConfig, uid);
      },
    }),
  ],
});
