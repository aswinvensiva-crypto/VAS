import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { authenticate } from "mailauth";

export type MailConfig = {
  user?: string;
  appPassword?: unknown;
  smtpHost?: string;
  imapHost?: string;
};

/** A ToolInputError's message is passed back to VAS and spoken as it is. */
class ToolInputError extends Error {
  override name = "ToolInputError";
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_TEXT = 6000;

function credentials(config: MailConfig) {
  if (!config.user || !ADDRESS.test(config.user)) throw new ToolInputError("VAS Mail has no Gmail address set.");
  // A SecretRef that did not resolve arrives as an object: fail closed.
  if (typeof config.appPassword !== "string" || !config.appPassword) {
    throw new ToolInputError("VAS Mail's Gmail app password isn't set, or OpenClaw couldn't read it.");
  }
  return { user: config.user, pass: config.appPassword };
}

/** The same message, to the same people, within a minute: almost certainly a repeat. */
const recent = new Map<string, number>();
function refuseRepeat(key: string) {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > 60_000) recent.delete(k);
  if (recent.has(key)) throw new ToolInputError("That exact email was just sent; I didn't send it twice.");
  recent.set(key, now);
}

/** How mail leaves: Gmail's SMTP server over TLS. Swappable so tests send nothing. */
type Transport = { sendMail(message: object): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[] }> };
export type CreateTransport = (options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => Transport;

export async function sendMail(
  config: MailConfig,
  { to, cc = [], subject, body }: { to: string[]; cc?: string[]; subject: string; body: string },
  createTransport: CreateTransport = (options) => nodemailer.createTransport(options),
) {
  const auth = credentials(config);
  for (const a of [...to, ...cc]) if (!ADDRESS.test(a)) throw new ToolInputError(`"${a}" isn't an email address.`);
  refuseRepeat(JSON.stringify([to, cc, subject, body]));
  const transport = createTransport({ host: config.smtpHost ?? "smtp.gmail.com", port: 465, secure: true, auth });
  const info = await transport.sendMail({ from: auth.user, to, cc: cc.length ? cc : undefined, subject, text: body });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

async function withInbox<T>(config: MailConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const auth = credentials(config);
  const client = new ImapFlow({ host: config.imapHost ?? "imap.gmail.com", port: 993, secure: true, auth, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Whether the sender is who the From line says, by DMARC — adapted from
 * OpenClaw's extensions/imap/src/sender-gate.ts (MIT). Unknown counts as
 * not verified: a reader is told to be wary, nothing is hidden.
 */
async function verified(raw: Buffer): Promise<boolean> {
  try {
    const result = await authenticate(raw, { trustReceived: false });
    return result?.dmarc ? result.dmarc.status?.result === "pass" : false;
  } catch {
    return false;
  }
}

export async function listMail(
  config: MailConfig,
  { unreadOnly = true, from, sinceHours = 48, limit = 5 }: { unreadOnly?: boolean; from?: string; sinceHours?: number; limit?: number },
) {
  return withInbox(config, async (client) => {
    const query: Record<string, unknown> = { since: new Date(Date.now() - sinceHours * 3600_000) };
    if (unreadOnly) query.seen = false;
    if (from) query.from = from;
    const uids = ((await client.search(query, { uid: true })) || []).slice(-limit).reverse();
    const out = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
      if (!msg) continue;
      const sender = msg.envelope?.from?.[0];
      out.push({
        uid,
        from: sender?.address ?? "",
        fromName: sender?.name ?? "",
        subject: msg.envelope?.subject ?? "",
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        unread: !msg.flags?.has("\\Seen"),
        verified: msg.source ? await verified(msg.source) : false,
      });
    }
    return out;
  });
}

export async function readMail(config: MailConfig, uid: number) {
  return withInbox(config, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new ToolInputError("That email is no longer in the inbox.");
    const parsed = await simpleParser(msg.source);
    const sender = parsed.from?.value?.[0];
    const text = (parsed.text ?? "").trim();
    return {
      uid,
      from: sender?.address ?? "",
      fromName: sender?.name ?? "",
      subject: parsed.subject ?? "",
      date: parsed.date?.toISOString() ?? null,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
      verified: await verified(msg.source),
    };
  });
}
