import { config } from './config.js';
import { getDb, getSchool, logEvent, sentToday, updateSchool, type EmailRow, type SchoolRow } from './db.js';
import { runResearch, discoverSchools, findContactEmail, type ResearchBrief } from './pipeline/research.js';
import { runQualify, type Qualification } from './pipeline/qualify.js';
import { runCompose } from './pipeline/compose.js';
import { sendQueuedEmail, insideSendWindow, DailyCapReached } from './pipeline/send.js';
import { pollInbox, imapConfigured } from './pipeline/replies.js';
import { logToCrm } from './crm.js';

export interface TickReport {
  startedAt: string;
  discovered: number;
  researched: number;
  sequenced: number;
  sent: number;
  repliesMatched: number;
  skipped: string[];
  errors: string[];
}

const MAX_CONSECUTIVE_FAILURES = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 864e5).toISOString();
}

function parseBrief(school: SchoolRow): (ResearchBrief & { qualification?: Qualification }) | null {
  if (!school.research_json) return null;
  try {
    return JSON.parse(school.research_json) as ResearchBrief & { qualification?: Qualification };
  } catch {
    return null;
  }
}

function recordFailure(school: SchoolRow, stage: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const failures = Number(school.last_error?.match(/^\[(\d+)\]/)?.[1] ?? 0) + 1;
  const stamped = `[${failures}] ${stage}: ${message}`;
  updateSchool(school.id, {
    last_error: stamped,
    // Back off, then give up rather than burning quota on a broken lead.
    status: failures >= MAX_CONSECUTIVE_FAILURES ? 'error' : school.status,
    next_action_at: failures >= MAX_CONSECUTIVE_FAILURES ? null : plusDays(failures * 0.25),
  });
  logEvent(school.id, 'pipeline.error', { stage, message, failures });
  return `${school.name}: ${stage}: ${message}`;
}

/** Research, qualify, and write the sequence for one lead. */
export async function advanceToSequenced(school: SchoolRow): Promise<'sequenced' | 'disqualified' | 'blocked'> {
  let current = school;
  let brief = parseBrief(current);

  if (!brief || current.status === 'discovered') {
    brief = await runResearch(current);
    current = getSchool(current.id)!;
  }

  if (!brief.qualification) {
    const q = await runQualify(current, brief);
    current = getSchool(current.id)!;
    if (current.status === 'disqualified') return 'disqualified';
    brief.qualification = q;
  }

  if (!current.contact_email) {
    await findContactEmail(current);
    current = getSchool(current.id)!;
  }
  if (!current.contact_email) {
    // Keep the drafted sequence, but hold the send until Joy supplies an address.
    updateSchool(current.id, { last_error: 'Awaiting a contact email address', next_action_at: null });
  }

  await runCompose(current, brief, brief.qualification ?? null);
  return getSchool(current.id)!.contact_email ? 'sequenced' : 'blocked';
}

function dueEmail(school: SchoolRow, step: number): EmailRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM emails WHERE school_id = ? AND step = ? AND status = 'queued'`)
    .get(school.id, step) as EmailRow | undefined;
}

function nextStepFor(school: SchoolRow): number | null {
  switch (school.status) {
    case 'sequenced': return 1;
    case 'contacted': return 2;
    case 'followup_1': return 3;
    default: return null;
  }
}

/** Sends the next due email for a school and moves it along the sequence. */
export async function sendNextStep(school: SchoolRow): Promise<boolean> {
  const step = nextStepFor(school);
  if (step === null) return false;
  const email = dueEmail(school, step);
  if (!email) return false;

  if (!school.contact_email) {
    updateSchool(school.id, { last_error: 'Awaiting a contact email address', next_action_at: null });
    return false;
  }
  if (email.to_email !== school.contact_email) {
    getDb().prepare('UPDATE emails SET to_email = ? WHERE id = ?').run(school.contact_email, email.id);
    email.to_email = school.contact_email;
  }

  const result = await sendQueuedEmail(email);
  if (!result.ok) {
    recordFailure(school, `send step ${step}`, result.error ?? 'unknown send failure');
    return false;
  }

  if (step === 1) {
    updateSchool(school.id, { status: 'contacted', next_action_at: plusDays(config.engine.followUp1Days), last_error: null });
    await logToCrm(getSchool(school.id)!, { subject: email.subject, body: email.body });
  } else if (step === 2) {
    const gap = Math.max(1, config.engine.followUp2Days - config.engine.followUp1Days);
    updateSchool(school.id, { status: 'followup_1', next_action_at: plusDays(gap), last_error: null });
  } else {
    updateSchool(school.id, { status: 'exhausted', next_action_at: null, last_error: null });
  }
  return true;
}

function dueForWork(limit: number): SchoolRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM schools
       WHERE status IN ('discovered', 'researched', 'researching')
         AND (next_action_at IS NULL OR next_action_at <= ?)
       ORDER BY COALESCE(score, 50) DESC, id ASC
       LIMIT ?`,
    )
    .all(nowIso(), limit) as SchoolRow[];
}

function dueForSend(limit: number): SchoolRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM schools
       WHERE status IN ('sequenced', 'contacted', 'followup_1')
         AND contact_email IS NOT NULL
         AND (next_action_at IS NULL OR next_action_at <= ?)
       ORDER BY
         CASE status WHEN 'followup_1' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END,
         COALESCE(score, 50) DESC
       LIMIT ?`,
    )
    .all(nowIso(), limit) as SchoolRow[];
}

function backlogSize(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM schools WHERE status IN ('discovered', 'researched', 'sequenced')`)
    .get() as { n: number };
  return row.n;
}

/**
 * One full pass of the autonomous loop: ingest replies, top up the funnel,
 * research and qualify new leads, then send whatever is due.
 */
export async function tick(): Promise<TickReport> {
  const report: TickReport = {
    startedAt: nowIso(),
    discovered: 0,
    researched: 0,
    sequenced: 0,
    sent: 0,
    repliesMatched: 0,
    skipped: [],
    errors: [],
  };

  // 1. Replies first. A school that answered must not receive a follow up.
  if (imapConfigured()) {
    try {
      report.repliesMatched = (await pollInbox()).matched;
    } catch (err) {
      report.errors.push(`inbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Top up the funnel when it runs thin.
  if (config.engine.autoDiscover && backlogSize() < config.engine.discoverTargetBacklog) {
    try {
      report.discovered = (await discoverSchools(10)).added;
    } catch (err) {
      report.errors.push(`discovery: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Research, qualify, and draft.
  for (const school of dueForWork(config.engine.maxResearchPerTick)) {
    try {
      const outcome = await advanceToSequenced(school);
      report.researched++;
      if (outcome === 'sequenced') report.sequenced++;
    } catch (err) {
      report.errors.push(recordFailure(school, 'research', err));
    }
  }

  // 4. Send what is due, inside the window and under the cap.
  if (!insideSendWindow()) {
    report.skipped.push('outside Lagos business hours, sending paused');
    return report;
  }
  const remainingToday = config.engine.maxSendsPerDay - sentToday();
  if (remainingToday <= 0) {
    report.skipped.push(`daily send cap of ${config.engine.maxSendsPerDay} reached`);
    return report;
  }

  const budget = Math.min(config.engine.maxSendsPerTick, remainingToday);
  for (const school of dueForSend(budget)) {
    try {
      if (await sendNextStep(school)) report.sent++;
    } catch (err) {
      if (err instanceof DailyCapReached) {
        report.skipped.push(err.message);
        break;
      }
      report.errors.push(recordFailure(school, 'send', err));
    }
  }

  logEvent(null, 'engine.tick', report);
  return report;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastReport: TickReport | null = null;

export function getLastReport(): TickReport | null {
  return lastReport;
}

export function engineRunning(): boolean {
  return timer !== null;
}

/** Runs a tick unless one is already in flight. Ticks never overlap. */
export async function safeTick(): Promise<TickReport | null> {
  if (running) return null;
  running = true;
  try {
    lastReport = await tick();
    return lastReport;
  } catch (err) {
    logEvent(null, 'engine.crash', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    running = false;
  }
}

export function startEngine(): void {
  if (timer) return;
  timer = setInterval(() => void safeTick(), config.engine.tickSeconds * 1000);
  timer.unref();
  logEvent(null, 'engine.started', { tickSeconds: config.engine.tickSeconds });
  void safeTick();
}

export function stopEngine(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logEvent(null, 'engine.stopped', null);
}
