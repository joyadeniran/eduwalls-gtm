import nodemailer, { type Transporter } from 'nodemailer';
import { config, activeTransport } from '../config.js';
import { getDb, logEvent, sentToday, type EmailRow } from '../db.js';

export interface SendResult {
  ok: boolean;
  transport: string;
  messageId: string | null;
  error?: string;
}

let smtp: Transporter | null = null;

function smtpTransport(): Transporter {
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return smtp;
}

async function sendViaBrevo(to: string, subject: string, body: string): Promise<SendResult> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.brevo.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: config.sender.name, email: config.sender.email },
      replyTo: { email: config.sender.replyTo, name: config.sender.name },
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

async function sendViaSmtp(to: string, subject: string, body: string): Promise<SendResult> {
  try {
    const info = await smtpTransport().sendMail({
      from: { name: config.sender.name, address: config.sender.email },
      replyTo: config.sender.replyTo,
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
  const transport = activeTransport();
  if (transport === 'dry-run') {
    return { ok: true, transport: 'dry-run', messageId: `dry-${Date.now()}` };
  }
  if (transport === 'brevo') return sendViaBrevo(to, subject, body);
  return sendViaSmtp(to, subject, body);
}

export class DailyCapReached extends Error {
  constructor(cap: number) {
    super(`Daily send cap of ${cap} reached`);
  }
}

/** Sends one queued email and records the outcome. Enforces the daily cap. */
export async function sendQueuedEmail(email: EmailRow): Promise<SendResult> {
  if (sentToday() >= config.engine.maxSendsPerDay) throw new DailyCapReached(config.engine.maxSendsPerDay);
  if (!email.to_email) {
    const err = 'No recipient address on record';
    getDb().prepare(`UPDATE emails SET status = 'failed', error = ? WHERE id = ?`).run(err, email.id);
    return { ok: false, transport: 'none', messageId: null, error: err };
  }

  const result = await deliver(email.to_email, email.subject, email.body);
  getDb()
    .prepare(
      `UPDATE emails SET status = ?, transport = ?, provider_message_id = ?, error = ?, sent_at = ? WHERE id = ?`,
    )
    .run(
      result.ok ? 'sent' : 'failed',
      result.transport,
      result.messageId,
      result.error ?? null,
      result.ok ? new Date().toISOString() : null,
      email.id,
    );

  logEvent(email.school_id, result.ok ? 'email.sent' : 'email.failed', {
    step: email.step,
    to: email.to_email,
    transport: result.transport,
    error: result.error,
  });
  return result;
}

/** True when it is a weekday inside Lagos business hours. */
export function insideSendWindow(now = new Date()): boolean {
  const w = config.engine.sendWindow;
  if (!w.enabled) return true;
  // WAT is UTC+1 year round, no daylight saving.
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  const day = wat.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = wat.getUTCHours();
  return hour >= w.startHourWat && hour < w.endHourWat;
}
