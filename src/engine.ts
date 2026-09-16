import { getSettings, transportFor, imapConfiguredIn, type Settings } from './settings.js';
import {
  sql, getSchool, logEvent, sentToday, updateSchool,
  acquireEngineLock, releaseEngineLock,
  type EmailRow, type SchoolRow,
} from './db.js';
import { runResearch, discoverSchools, findContactEmail, type ResearchBrief } from './pipeline/research.js';
import { runQualify, type Qualification } from './pipeline/qualify.js';
import { runCompose } from './pipeline/compose.js';
import { sendQueuedEmail, insideSendWindow, DailyCapReached } from './pipeline/send.js';
import { pollInbox } from './pipeline/replies.js';
import { logToCrm } from './crm.js';

export interface TickReport {
  startedAt: string;
  finishedAt?: string;
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

async function recordFailure(school: SchoolRow, stage: string, err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message : String(err);
  const failures = Number(school.last_error?.match(/^\[(\d+)\]/)?.[1] ?? 0) + 1;
  await updateSchool(school.id, {
    last_error: `[${failures}] ${stage}: ${message}`,
    // Back off, then give up rather than burning quota on a broken lead.
    status: failures >= MAX_CONSECUTIVE_FAILURES ? 'error' : school.status,
    next_action_at: failures >= MAX_CONSECUTIVE_FAILURES ? null : plusDays(failures * 0.25),
  });
  await logEvent(school.id, 'pipeline.error', { stage, message, failures });
  return `${school.name}: ${stage}: ${message}`;
}

/** Research, qualify, and write the sequence for one lead. */
export async function advanceToSequenced(school: SchoolRow): Promise<'sequenced' | 'disqualified' | 'blocked'> {
  let current = school;
  let brief = parseBrief(current);

  if (!brief || current.status === 'discovered') {
    brief = await runResearch(current);
    current = (await getSchool(current.id))!;
  }

  if (!brief.qualification) {
    const q = await runQualify(current, brief);
    current = (await getSchool(current.id))!;
    if (current.status === 'disqualified') return 'disqualified';
    brief.qualification = q;
  }

  if (!current.contact_email) {
    await findContactEmail(current);
    current = (await getSchool(current.id))!;
  }
  if (!current.contact_email) {
    // Keep the drafted sequence, but hold the send until Joy supplies an address.
    await updateSchool(current.id, { last_error: 'Awaiting a contact email address', next_action_at: null });
  }

  await runCompose(current, brief, brief.qualification ?? null);
  return (await getSchool(current.id))!.contact_email ? 'sequenced' : 'blocked';
}

async function dueEmail(schoolId: number, step: number): Promise<EmailRow | undefined> {
  const rows = await sql()<EmailRow[]>`
    SELECT * FROM emails WHERE school_id = ${schoolId} AND step = ${step} AND status = 'queued'`;
  return rows[0];
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
export async function sendNextStep(school: SchoolRow, settings?: Settings): Promise<boolean> {
  const s = settings ?? (await getSettings());
  const step = nextStepFor(school);
  if (step === null) return false;
  const email = await dueEmail(school.id, step);
  if (!email) return false;

  if (!school.contact_email) {
    await updateSchool(school.id, { last_error: 'Awaiting a contact email address', next_action_at: null });
    return false;
  }
  if (email.to_email !== school.contact_email) {
    await sql()`UPDATE emails SET to_email = ${school.contact_email} WHERE id = ${email.id}`;
    email.to_email = school.contact_email;
  }

  const result = await sendQueuedEmail(email);
  if (!result.ok) {
    await recordFailure(school, `send step ${step}`, result.error ?? 'unknown send failure');
    return false;
  }

  if (step === 1) {
    await updateSchool(school.id, { status: 'contacted', next_action_at: plusDays(s.followUp1Days), last_error: null });
    await logToCrm((await getSchool(school.id))!, { subject: email.subject, body: email.body });
  } else if (step === 2) {
    const gap = Math.max(1, s.followUp2Days - s.followUp1Days);
    await updateSchool(school.id, { status: 'followup_1', next_action_at: plusDays(gap), last_error: null });
  } else {
    await updateSchool(school.id, { status: 'exhausted', next_action_at: null, last_error: null });
  }
  return true;
}

async function dueForWork(limit: number): Promise<SchoolRow[]> {
  return sql()<SchoolRow[]>`
    SELECT * FROM schools
    WHERE status IN ('discovered', 'researched', 'researching')
      AND (next_action_at IS NULL OR next_action_at <= now())
    ORDER BY COALESCE(score, 50) DESC, id ASC
    LIMIT ${limit}`;
}

async function dueForSend(limit: number): Promise<SchoolRow[]> {
  return sql()<SchoolRow[]>`
    SELECT * FROM schools
    WHERE status IN ('sequenced', 'contacted', 'followup_1')
      AND contact_email IS NOT NULL
      AND (next_action_at IS NULL OR next_action_at <= now())
    ORDER BY
      CASE status WHEN 'followup_1' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END,
      COALESCE(score, 50) DESC
    LIMIT ${limit}`;
}

async function backlogSize(): Promise<number> {
  const rows = await sql()<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM schools WHERE status IN ('discovered', 'researched', 'sequenced')`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * One full pass of the autonomous loop: ingest replies, top up the funnel,
 * research and qualify new leads, then send whatever is due.
 */
export async function tick(): Promise<TickReport> {
  const report: TickReport = {
    startedAt: nowIso(),
    discovered: 0, researched: 0, sequenced: 0, sent: 0, repliesMatched: 0,
    skipped: [], errors: [],
  };
  const s = await getSettings(true);

  if (!s.engineEnabled) {
    report.skipped.push('engine disabled in settings');
    return report;
  }

  // 1. Replies first. A school that answered must not receive a follow up.
  if (imapConfiguredIn(s)) {
    try {
      report.repliesMatched = (await pollInbox()).matched;
    } catch (err) {
      report.errors.push(`inbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Top up the funnel when it runs thin.
  if (s.autoDiscover && (await backlogSize()) < s.discoverTargetBacklog) {
    try {
      report.discovered = (await discoverSchools(10)).added;
    } catch (err) {
      report.errors.push(`discovery: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Research, qualify, and draft.
  for (const school of await dueForWork(s.maxResearchPerTick)) {
    try {
      const outcome = await advanceToSequenced(school);
      report.researched++;
      if (outcome === 'sequenced') report.sequenced++;
    } catch (err) {
      report.errors.push(await recordFailure(school, 'research', err));
    }
  }

  // 4. Send what is due, inside the window and under the cap.
  if (!insideSendWindow(s)) {
    report.skipped.push('outside Lagos business hours, sending paused');
    report.finishedAt = nowIso();
    return report;
  }
  const remainingToday = s.maxSendsPerDay - (await sentToday());
  if (remainingToday <= 0) {
    report.skipped.push(`daily send cap of ${s.maxSendsPerDay} reached`);
    report.finishedAt = nowIso();
    return report;
  }

  const budget = Math.min(s.maxSendsPerTick, remainingToday);
  for (const school of await dueForSend(budget)) {
    try {
      if (await sendNextStep(school, s)) report.sent++;
    } catch (err) {
      if (err instanceof DailyCapReached) {
        report.skipped.push(err.message);
        break;
      }
      report.errors.push(await recordFailure(school, 'send', err));
    }
  }

  report.finishedAt = nowIso();
  await logEvent(null, 'engine.tick', report);
  return report;
}

/**
 * Runs a tick under a database lock, so two cron pings or a manual run
 * colliding with the scheduler can never double send.
 */
export async function lockedTick(lockSeconds = 120): Promise<TickReport | { skipped: string }> {
  if (!(await acquireEngineLock(lockSeconds))) return { skipped: 'another run is in progress' };
  try {
    return await tick();
  } finally {
    await releaseEngineLock();
  }
}

/**
 * Serverless entry point. Vercel Hobby allows one cron per day, so a single
 * invocation works through as many ticks as its time budget allows instead of
 * doing one pass and waiting 24 hours.
 */
export async function runTicks(opts: { maxTicks?: number; timeBudgetMs?: number } = {}): Promise<{
  ticks: TickReport[];
  stopped: string;
}> {
  const maxTicks = opts.maxTicks ?? 10;
  const budget = opts.timeBudgetMs ?? 45_000;
  const started = Date.now();
  const ticks: TickReport[] = [];

  if (!(await acquireEngineLock(Math.ceil(budget / 1000) + 30))) {
    return { ticks, stopped: 'another run is in progress' };
  }
  try {
    for (let i = 0; i < maxTicks; i++) {
      const report = await tick();
      ticks.push(report);
      const didWork = report.sent + report.researched + report.discovered + report.repliesMatched > 0;
      if (!didWork) return { ticks, stopped: 'no work left' };
      if (Date.now() - started > budget) return { ticks, stopped: 'time budget reached' };
    }
    return { ticks, stopped: 'tick limit reached' };
  } finally {
    await releaseEngineLock();
  }
}

// ---------------------------------------------------------------------------
// Long running mode. Used when the app runs as a normal server, not on Vercel.
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastReport: TickReport | null = null;

export function getLastReport(): TickReport | null {
  return lastReport;
}

export function engineRunning(): boolean {
  return timer !== null;
}

export async function safeTick(): Promise<TickReport | null> {
  if (running) return null;
  running = true;
  try {
    const result = await lockedTick();
    if ('startedAt' in result) lastReport = result;
    return 'startedAt' in result ? result : null;
  } catch (err) {
    await logEvent(null, 'engine.crash', err instanceof Error ? err.message : String(err)).catch(() => {});
    return null;
  } finally {
    running = false;
  }
}

export async function startEngine(): Promise<void> {
  if (timer) return;
  const s = await getSettings();
  timer = setInterval(() => void safeTick(), s.engineTickSeconds * 1000);
  timer.unref();
  await logEvent(null, 'engine.started', { tickSeconds: s.engineTickSeconds });
  void safeTick();
}

export async function stopEngine(): Promise<void> {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  await logEvent(null, 'engine.stopped', null);
}

export { transportFor };
