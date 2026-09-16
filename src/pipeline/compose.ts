import { generateJson } from '../gemini.js';
import { COMPANY_CONTEXT, PROOF_POINTS, PRICING_GUIDANCE, VOICE_RULES, enforceVoice, voiceViolations } from '../brand.js';
import { getSettings } from '../settings.js';
import { sql, logEvent, updateSchool, type SchoolRow } from '../db.js';
import type { ResearchBrief } from './research.js';
import type { Qualification } from './qualify.js';

export interface SequenceEmail {
  label: string;
  subject: string;
  body: string;
}

export interface Sequence {
  emails: SequenceEmail[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    emails: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['label', 'subject', 'body'],
      },
    },
  },
  required: ['emails'],
} as const;

/** Step 3 of the loop. Writes the full 3-email sequence once, up front. */
export async function composeSequence(
  school: SchoolRow,
  brief: ResearchBrief,
  qualification: Qualification | null,
  tone = 'warm and direct',
): Promise<Sequence> {
  const settings = await getSettings();
  const system = `${COMPANY_CONTEXT}

${PROOF_POINTS}

${PRICING_GUIDANCE}

${VOICE_RULES}`;

  const prompt = `Write a 3-email cold outreach sequence to the proprietor or head of school at a Lagos private school. The goal is a 20 minute call or a visit.

SCHOOL DETAILS:
- Name: ${school.name}
- Location: ${school.area ?? 'Lagos'}
- Tier: ${school.tier ?? brief.tier}
- Contact: ${school.contact_name ?? 'unknown, address the proprietor or head of school'}
- Notes: ${school.notes ?? 'none'}

RESEARCH BRIEF:
- Profile: ${brief.inferred_profile}
- Recommended angle: ${brief.recommended_angle}
- Verified signals you may reference: ${brief.signals.length ? brief.signals.join('; ') : 'none, so keep it general and do not invent specifics'}
- Watch out: ${brief.watch_out}
- Programs to lead with: ${(qualification?.priority_program ? [qualification.priority_program, ...brief.best_programs] : brief.best_programs).slice(0, 3).join(', ')}
- Tone: ${tone}

SEQUENCE SHAPE:
- Email 1, first contact. Open on the angle above. One clear ask.
- Email 2, sent day ${settings.followUp1Days}. A short follow up that adds one new piece of value, a proof point or a specific outcome. Never say "just following up" or "circling back". Do not repeat Email 1.
- Email 3, sent day ${settings.followUp2Days}. A brief, graceful final nudge. Make it easy to say no or to redirect you to the right person.

Each body must be plain text, signed off as Joy. No markdown, no placeholders like [Name] or [School], no em dashes.`;

  const seq = await generateJson<Sequence>({
    system,
    prompt,
    schema: SCHEMA,
    temperature: 0.75,
    maxOutputTokens: 3000,
  });

  seq.emails = seq.emails.slice(0, 3).map((e, i) => ({
    label: `Email ${i + 1}`,
    subject: enforceVoice(e.subject),
    body: enforceVoice(e.body),
  }));

  if (seq.emails.length < 3) throw new Error(`Sequence generation returned ${seq.emails.length} emails, expected 3`);

  // Voice rules are commercial constraints, so a violation is a hard flag, not a nit.
  for (const e of seq.emails) {
    const issues = voiceViolations(`${e.subject}\n${e.body}`);
    if (issues.length) await logEvent(school.id, 'compose.voice_warning', { label: e.label, issues });
  }
  return seq;
}

export async function runCompose(school: SchoolRow, brief: ResearchBrief, q: Qualification | null): Promise<Sequence> {
  const seq = await composeSequence(school, brief, q);
  const to = school.contact_email ?? '';
  const s = sql();

  // Only overwrite drafts that have not gone out yet.
  for (const [i, e] of seq.emails.entries()) {
    await s`
      INSERT INTO emails (school_id, step, subject, body, to_email, status)
      VALUES (${school.id}, ${i + 1}, ${e.subject}, ${e.body}, ${to}, 'queued')
      ON CONFLICT (school_id, step) DO UPDATE
        SET subject = EXCLUDED.subject, body = EXCLUDED.body, to_email = EXCLUDED.to_email
        WHERE emails.status = 'queued'`;
  }

  await updateSchool(school.id, {
    status: 'sequenced',
    sequence_json: JSON.stringify(seq),
    next_action_at: new Date().toISOString(),
    last_error: null,
  });
  await logEvent(school.id, 'compose.done', { subjects: seq.emails.map((e) => e.subject) });
  return seq;
}
