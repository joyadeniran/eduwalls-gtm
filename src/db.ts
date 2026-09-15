import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export type SchoolStatus =
  | 'discovered'
  | 'researching'
  | 'researched'
  | 'disqualified'
  | 'sequenced'
  | 'contacted'
  | 'followup_1'
  | 'followup_2'
  | 'exhausted'
  | 'replied'
  | 'meeting_booked'
  | 'signed'
  | 'declined'
  | 'error';

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

export interface EventRow {
  id: number;
  school_id: number | null;
  kind: string;
  detail: string | null;
  created_at: string;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT,
      tier TEXT,
      website TEXT,
      contact_email TEXT,
      contact_name TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      score INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT,
      research_json TEXT,
      sequence_json TEXT,
      disqualified_reason TEXT,
      hubspot_company_id TEXT,
      hubspot_deal_id TEXT,
      last_error TEXT,
      next_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_name ON schools (lower(name));
    CREATE INDEX IF NOT EXISTS idx_schools_status ON schools (status, next_action_at);

    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      to_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      transport TEXT,
      provider_message_id TEXT,
      error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_school_step ON emails (school_id, step);
    CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails (sent_at);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function logEvent(schoolId: number | null, kind: string, detail?: unknown): void {
  const text = detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
  getDb().prepare('INSERT INTO events (school_id, kind, detail) VALUES (?, ?, ?)').run(schoolId, kind, text);
}

export function kvGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function updateSchool(id: number, patch: Partial<SchoolRow>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
  getDb()
    .prepare(`UPDATE schools SET ${setSql}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id } as Record<string, unknown>);
}

export function getSchool(id: number): SchoolRow | undefined {
  return getDb().prepare('SELECT * FROM schools WHERE id = ?').get(id) as SchoolRow | undefined;
}

/** Insert a lead, ignoring duplicates by name. Returns the row either way. */
export function upsertSchool(input: {
  name: string;
  area?: string | null;
  tier?: string | null;
  website?: string | null;
  contact_email?: string | null;
  contact_name?: string | null;
  notes?: string | null;
  source?: string;
}): { school: SchoolRow; created: boolean } {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM schools WHERE lower(name) = lower(?)').get(input.name) as SchoolRow | undefined;
  if (existing) {
    // Fill in blanks a later discovery pass may have found, never overwrite.
    const patch: Partial<SchoolRow> = {};
    if (!existing.area && input.area) patch.area = input.area;
    if (!existing.website && input.website) patch.website = input.website;
    if (!existing.contact_email && input.contact_email) patch.contact_email = input.contact_email;
    if (!existing.contact_name && input.contact_name) patch.contact_name = input.contact_name;
    if (Object.keys(patch).length) updateSchool(existing.id, patch);
    return { school: getSchool(existing.id)!, created: false };
  }
  const info = d
    .prepare(
      `INSERT INTO schools (name, area, tier, website, contact_email, contact_name, notes, source, status, next_action_at)
       VALUES (@name, @area, @tier, @website, @contact_email, @contact_name, @notes, @source, 'discovered', datetime('now'))`,
    )
    .run({
      name: input.name.trim(),
      area: input.area ?? null,
      tier: input.tier ?? null,
      website: input.website ?? null,
      contact_email: input.contact_email ?? null,
      contact_name: input.contact_name ?? null,
      notes: input.notes ?? null,
      source: input.source ?? 'manual',
    });
  const school = getSchool(Number(info.lastInsertRowid))!;
  logEvent(school.id, 'lead.created', { source: school.source });
  return { school, created: true };
}

export function sentToday(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM emails WHERE status = 'sent' AND date(sent_at) = date('now')`)
    .get() as { n: number };
  return row.n;
}
