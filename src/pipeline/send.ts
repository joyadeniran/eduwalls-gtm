import nodemailer, { type Transporter } from 'nodemailer';
import { getSettings, transportFor, type Settings } from '../settings.js';
import { sql, logEvent, sentToday, type EmailRow } from '../db.js';

export interface SendResult {
  ok: boolean;
  transport: string;
  messageId: string | null;
  error?: string;
}

let smtp: { key: string; transport: Transporter } | null = null;

function smtpTransport(s: Settings): Transporter {
  const key = `${s.smtpHost}:${s.smtpPort}:${s.smtpUser}`;
  if (!smtp || smtp.key !== key) {
    smtp = {
      key,
      transport: nodemailer.createTransport({
        host: s.smtpHost,
        port: s.smtpPort,
        secure: s.smtpPort === 465,
        auth: { user: s.smtpUser, pass: s.smtpPass },
      }),
    };
  }
  return smtp.transport;
}

async function sendViaBrevo(s: Settings, to: string, subject: string, body: string): Promise<SendResult> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': s.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: s.fromName, email: s.fromEmail },
      replyTo: { email: s.replyTo || s.fromEmail, name: s.fromName },
      to: [{ email: to }],
      subject,
      textContent: body,
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, transport: 'brevo', messageId: null, error: `Brevo ${res.status}: ${text.slice(0, 300)}` };
  let messageId: string | null = null;
  try {
    messageId = (JSON.parse(text) as { messageId?: string }).messageId ?? null;
  } catch { /* Brevo occasionally returns an empty body on success */ }
  return { ok: true, transport: 'brevo', messageId };
}

async function sendViaSmtp(s: Settings, to: string, subject: string, body: string): Promise<SendResult> {
  try {
    const info = await smtpTransport(s).sendMail({
      from: { name: s.fromName, address: s.fromEmail },
      replyTo: s.replyTo || s.fromEmail,
      to,
      subject,
      text: body,
    });
    return { ok: true, transport: 'smtp', messageId: info.messageId ?? null };
  } catch (err) {
    return { ok: false, transport: 'smtp', messageId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deliver(to: string, subject: string, body: string): Promise<SendResult> {
  const s = await getSettings();
  const transport = transportFor(s);
  if (transport === 'dry-run') return { ok: true, transport: 'dry-run', messageId: `dry-${Date.now()}` };
  if (!s.fromEmail) return { ok: false, transport, messageId: null, error: 'No sender address configured' };
  return transport === 'brevo' ? sendViaBrevo(s, to, subject, body) : sendViaSmtp(s, to, subject, body);
}

/** Verifies credentials without sending anything to a school. */
export async function verifyTransport(): Promise<{ ok: boolean; transport: string; detail: string }> {
  const s = await getSettings();
  const transport = transportFor(s);
  if (transport === 'dry-run') {
    return { ok: true, transport, detail: 'Dry run. Nothing will be delivered until live sending is enabled.' };
  }
  if (transport === 'brevo') {
    const res = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': s.brevoApiKey, accept: 'application/json' } });
    const body = await res.text();
    return res.ok
      ? { ok: true, transport, detail: `Brevo account reachable, sending as ${s.fromName} <${s.fromEmail}>` }
      : { ok: false, transport, detail: `Brevo rejected the key: ${res.status} ${body.slice(0, 200)}` };
  }
  try {
    await smtpTransport(s).verify();
    return { ok: true, transport, detail: `SMTP login succeeded on ${s.smtpHost}:${s.smtpPort}` };
  } catch (err) {
    return { ok: false, transport, detail: err instanceof Error ? err.message : String(err) };
  }
}

export class DailyCapReached extends Error {
  constructor(cap: number) {
    super(`Daily send cap of ${cap} reached`);
  }
}

/** Sends one queued email and records the outcome. Enforces the daily cap. */
export async function sendQueuedEmail(email: EmailRow): Promise<SendResult> {
  const s = await getSettings();
  if ((await sentToday()) >= s.maxSendsPerDay) throw new DailyCapReached(s.maxSendsPerDay);

  if (!email.to_email) {
    const err = 'No recipient address on record';
    await sql()`UPDATE emails SET status = 'failed', error = ${err} WHERE id = ${email.id}`;
    return { ok: false, transport: 'none', messageId: null, error: err };
  }

  const result = await deliver(email.to_email, email.subject, email.body);
  await sql()`
    UPDATE emails SET
      status = ${result.ok ? 'sent' : 'failed'},
      transport = ${result.transport},
      provider_message_id = ${result.messageId},
      error = ${result.error ?? null},
      sent_at = ${result.ok ? new Date().toISOString() : null}
    WHERE id = ${email.id}`;

  await logEvent(email.school_id, result.ok ? 'email.sent' : 'email.failed', {
    step: email.step, to: email.to_email, transport: result.transport, error: result.error,
  });
  return result;
}

/** True when it is a weekday inside Lagos business hours. */
export function insideSendWindow(s: Settings, now = new Date()): boolean {
  if (!s.sendWindowEnabled) return true;
  // WAT is UTC+1 year round, no daylight saving.
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  const day = wat.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = wat.getUTCHours();
  return hour >= s.sendStartHourWat && hour < s.sendEndHourWat;
}
