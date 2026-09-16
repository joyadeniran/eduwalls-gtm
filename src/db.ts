import postgres from 'postgres';
import { env } from './config.js';

export type SchoolStatus =
  | 'discovered' | 'researching' | 'researched' | 'disqualified' | 'sequenced'
  | 'contacted' | 'followup_1' | 'followup_2' | 'exhausted'
  | 'replied' | 'meeting_booked' | 'signed' | 'declined' | 'error';

export interface SchoolRow {
  id: number;
  name: string;
  area: string | null;
  tier: string | null;
  website: string | null;
  contact_email: string | null;
  contact_name: string | null;
  status: SchoolStatus;
  score: number | null;
  source: string;
  notes: string | null;
  research_json: string | null;
  sequence_json: string | null;
  disqualified_reason: string | null;
  hubspot_company_id: string | null;
  hubspot_deal_id: string | null;
  last_error: string | null;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailRow {
  id: number;
  school_id: number;
  step: number;
  subject: string;
  body: string;
  to_email: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  transport: string | null;
  provider_message_id: string | null;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

let sqlClient: postgres.Sql | null = null;

export function sql(): postgres.Sql {
  if (!sqlClient) {
    if (!env.databaseUrl) {
      throw new Error('DATABASE_URL is not set. Point it at a Postgres database (Supabase, Neon, or any Postgres).');
    }
    sqlClient = postgres(env.databaseUrl, {
      // Serverless invocations are short lived; a small pool avoids exhausting
      // the database's connection limit across concurrent functions.
      max: env.isServerless ? 1 : 10,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false, // required for transaction-mode poolers such as PgBouncer
    });
  }
  return sqlClient;
}

let migrated: Promise<void> | null = null;

/** Creates the schema if absent. Safe to call on every request; runs once. */
export function ensureSchema(): Promise<void> {
  if (!migrated) migrated = migrate().catch((err) => { migrated = null; throw err; });
  return migrated;
}

async function migrate(): Promise<void> {
  const s = sql();
  await s`
    CREATE TABLE IF NOT EXISTS schools (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      area TEXT, tier TEXT, website TEXT,
      contact_email TEXT, contact_name TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      score INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT, research_json TEXT, sequence_json TEXT,
      disqualified_reason TEXT,
      hubspot_company_id TEXT, hubspot_deal_id TEXT,
      last_error TEXT,
      next_action_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await s`CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_name ON schools (lower(name))`;
  await s`CREATE INDEX IF NOT EXISTS idx_schools_status ON schools (status, next_action_at)`;

  await s`
    CREATE TABLE IF NOT EXISTS emails (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, to_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      transport TEXT, provider_message_id TEXT, error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await s`CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_school_step ON emails (school_id, step)`;

  await s`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await s`CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC)`;

  await s`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

  // Settings the operator edits in the dashboard. Secrets are stored encrypted
  // when APP_SECRET is set, and are never returned to the browser.
  await s`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_secret BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  // A single-row advisory lock target so overlapping cron invocations cannot
  // both run a tick and double send.
  await s`
    CREATE TABLE IF NOT EXISTS engine_lock (
      id INTEGER PRIMARY KEY DEFAULT 1,
      locked_until TIMESTAMPTZ,
      CONSTRAINT engine_lock_single CHECK (id = 1)
    )`;
  await s`INSERT INTO engine_lock (id, locked_until) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`;
}

export async function logEvent(schoolId: number | null, kind: string, detail?: unknown): Promise<void> {
  const text = detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
  await sql()`INSERT INTO events (school_id, kind, detail) VALUES (${schoolId}, ${kind}, ${text})`;
}

export async function kvGet(key: string): Promise<string | null> {
  const rows = await sql()<{ value: string }[]>`SELECT value FROM kv WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await sql()`
    INSERT INTO kv (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

const SCHOOL_COLUMNS = [
  'area', 'tier', 'website', 'contact_email', 'contact_name', 'status', 'score',
  'notes', 'research_json', 'sequence_json', 'disqualified_reason',
  'hubspot_company_id', 'hubspot_deal_id', 'last_error', 'next_action_at',
] as const;

export async function updateSchool(id: number, patch: Partial<SchoolRow>): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => (SCHOOL_COLUMNS as readonly string[]).includes(k));
  if (entries.length === 0) return;
  const payload = Object.fromEntries(entries);
  const s = sql();
  await s`UPDATE schools SET ${s(payload)}, updated_at = now() WHERE id = ${id}`;
}

export async function getSchool(id: number): Promise<SchoolRow | undefined> {
  const rows = await sql()<SchoolRow[]>`SELECT * FROM schools WHERE id = ${id}`;
  return rows[0];
}

export async function upsertSchool(input: {
  name: string;
  area?: string | null; tier?: string | null; website?: string | null;
  contact_email?: string | null; contact_name?: string | null;
  notes?: string | null; source?: string;
}): Promise<{ school: SchoolRow; created: boolean }> {
  const s = sql();
  const existing = (await s<SchoolRow[]>`SELECT * FROM schools WHERE lower(name) = lower(${input.name})`)[0];
  if (existing) {
    // Fill blanks a later discovery pass found, never overwrite what is there.
    const patch: Partial<SchoolRow> = {};
    if (!existing.area && input.area) patch.area = input.area;
    if (!existing.website && input.website) patch.website = input.website;
    if (!existing.contact_email && input.contact_email) patch.contact_email = input.contact_email;
    if (!existing.contact_name && input.contact_name) patch.contact_name = input.contact_name;
    if (Object.keys(patch).length) await updateSchool(existing.id, patch);
    return { school: (await getSchool(existing.id))!, created: false };
  }
  const rows = await s<SchoolRow[]>`
    INSERT INTO schools (name, area, tier, website, contact_email, contact_name, notes, source, status, next_action_at)
    VALUES (${input.name.trim()}, ${input.area ?? null}, ${input.tier ?? null}, ${input.website ?? null},
            ${input.contact_email ?? null}, ${input.contact_name ?? null}, ${input.notes ?? null},
            ${input.source ?? 'manual'}, 'discovered', now())
    RETURNING *`;
  const school = rows[0]!;
  await logEvent(school.id, 'lead.created', { source: school.source });
  return { school, created: true };
}

export async function sentToday(): Promise<number> {
  const rows = await sql()<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM emails WHERE status = 'sent' AND sent_at >= date_trunc('day', now())`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Claims the engine lock for `seconds`. Returns false when another invocation
 * holds it. This is what stops two cron pings from double sending.
 */
export async function acquireEngineLock(seconds: number): Promise<boolean> {
  const rows = await sql()<{ id: number }[]>`
    UPDATE engine_lock
    SET locked_until = now() + (${seconds} || ' seconds')::interval
    WHERE id = 1 AND (locked_until IS NULL OR locked_until < now())
    RETURNING id`;
  return rows.length > 0;
}

export async function releaseEngineLock(): Promise<void> {
  await sql()`UPDATE engine_lock SET locked_until = NULL WHERE id = 1`;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
  }
}
