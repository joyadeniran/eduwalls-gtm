import { ImapFlow } from 'imapflow';
import { generateJson } from '../gemini.js';
import { COMPANY_CONTEXT } from '../brand.js';
import { getSettings, imapConfiguredIn } from '../settings.js';
import { sql, kvGet, kvSet, logEvent, updateSchool, type SchoolRow, type SchoolStatus } from '../db.js';

export interface ReplyTriage {
  intent: 'interested' | 'meeting_request' | 'question' | 'referral' | 'not_now' | 'not_interested' | 'auto_reply' | 'unrelated';
  sentiment: 'positive' | 'neutral' | 'negative';
  should_stop_sequence: boolean;
  needs_joy: boolean;
  summary: string;
  suggested_next_step: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['interested', 'meeting_request', 'question', 'referral', 'not_now', 'not_interested', 'auto_reply', 'unrelated'],
    },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    should_stop_sequence: { type: 'boolean' },
    needs_joy: { type: 'boolean', description: 'True when a human must respond personally' },
    summary: { type: 'string' },
    suggested_next_step: { type: 'string' },
  },
  required: ['intent', 'sentiment', 'should_stop_sequence', 'needs_joy', 'summary', 'suggested_next_step'],
} as const;

export async function triageReply(school: SchoolRow, subject: string, body: string): Promise<ReplyTriage> {
  return generateJson<ReplyTriage>({
    system: `${COMPANY_CONTEXT}\n\nYou triage replies to Eduwalls cold outreach. An out of office bounce is an auto_reply and must never stop a sequence. Anything from a real person at the school stops it, including a soft no.`,
    prompt: `Reply from ${school.name}.\n\nSUBJECT: ${subject}\n\nBODY:\n${body.slice(0, 4000)}`,
    schema: SCHEMA,
    temperature: 0.1,
  });
}

const INTENT_TO_STATUS: Partial<Record<ReplyTriage['intent'], SchoolStatus>> = {
  meeting_request: 'meeting_booked',
  not_interested: 'declined',
};

/** Records a reply, triages it, and halts the sequence unless it is automated. */
export async function recordReply(school: SchoolRow, subject: string, body: string): Promise<ReplyTriage> {
  const triage = await triageReply(school, subject, body);
  await logEvent(school.id, 'reply.received', { subject, intent: triage.intent, summary: triage.summary });

  if (triage.should_stop_sequence && triage.intent !== 'auto_reply') {
    const status = INTENT_TO_STATUS[triage.intent] ?? 'replied';
    await updateSchool(school.id, { status, next_action_at: null });
    await sql()`UPDATE emails SET status = 'skipped' WHERE school_id = ${school.id} AND status = 'queued'`;
    await logEvent(school.id, 'sequence.stopped', { reason: triage.intent });
  }
  return triage;
}

async function matchSchoolByAddress(from: string): Promise<SchoolRow | undefined> {
  const address = from.toLowerCase().match(/[^\s<>"]+@[^\s<>"]+/)?.[0];
  if (!address) return undefined;
  const s = sql();
  const exact = (await s<SchoolRow[]>`SELECT * FROM schools WHERE lower(contact_email) = ${address}`)[0];
  if (exact) return exact;
  // Someone else at the school may answer from the same domain.
  const domain = address.split('@')[1];
  if (!domain || ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'].includes(domain)) return undefined;
  return (await s<SchoolRow[]>`
    SELECT * FROM schools
    WHERE contact_email LIKE ${'%@' + domain}
      AND status NOT IN ('discovered', 'disqualified')
    ORDER BY updated_at DESC LIMIT 1`)[0];
}

export async function imapConfigured(): Promise<boolean> {
  return imapConfiguredIn(await getSettings());
}

/**
 * Polls the inbox for replies from schools in the pipeline. Optional: without
 * IMAP credentials Joy marks replies by hand in the dashboard.
 */
export async function pollInbox(): Promise<{ scanned: number; matched: number }> {
  const settings = await getSettings();
  if (!imapConfiguredIn(settings)) return { scanned: 0, matched: 0 };

  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: true,
    auth: { user: settings.imapUser, pass: settings.imapPass },
    logger: false,
  });

  let scanned = 0;
  let matched = 0;
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const lastUid = Number((await kvGet('imap:last_uid')) ?? 0);
    let highest = lastUid;
    // On a cold start only look at recent mail, never the whole mailbox history.
    const range = lastUid > 0 ? `${lastUid + 1}:*` : undefined;
    const search = range ? { uid: range } : { since: new Date(Date.now() - 7 * 864e5) };

    for await (const msg of client.fetch(search, { uid: true, envelope: true, source: true })) {
      if (msg.uid <= lastUid) continue;
      highest = Math.max(highest, msg.uid);
      scanned++;
      const from = msg.envelope?.from?.[0]?.address ?? '';
      const school = await matchSchoolByAddress(from);
      if (!school) continue;
      const subject = msg.envelope?.subject ?? '(no subject)';
      const body = msg.source?.toString('utf8') ?? '';
      // Strip headers so the model triages the message, not the envelope.
      const text = body.split(/\r?\n\r?\n/).slice(1).join('\n\n').slice(0, 6000);
      await recordReply(school, subject, text);
      matched++;
    }
    if (highest > lastUid) await kvSet('imap:last_uid', String(highest));
  } finally {
    lock.release();
    await client.logout();
  }

  if (scanned) await logEvent(null, 'inbox.polled', { scanned, matched });
  return { scanned, matched };
}
