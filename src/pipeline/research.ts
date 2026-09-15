import { groundedResearch, generateJson } from '../gemini.js';
import { COMPANY_CONTEXT, PROGRAMS } from '../brand.js';
import { config } from '../config.js';
import { getDb, logEvent, upsertSchool, updateSchool, type SchoolRow } from '../db.js';

export interface ResearchBrief {
  school_name: string;
  inferred_profile: string;
  recommended_angle: string;
  best_programs: string[];
  watch_out: string;
  signals: string[];
  contact_email: string | null;
  contact_name: string | null;
  website: string | null;
  area: string | null;
  tier: 'premium' | 'mid' | 'budget' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    school_name: { type: 'string' },
    inferred_profile: { type: 'string', description: '2 to 3 sentences' },
    recommended_angle: { type: 'string' },
    best_programs: { type: 'array', items: { type: 'string' } },
    watch_out: { type: 'string' },
    signals: { type: 'array', items: { type: 'string' }, description: 'Concrete verified facts found during research' },
    contact_email: { type: 'string', nullable: true },
    contact_name: { type: 'string', nullable: true },
    website: { type: 'string', nullable: true },
    area: { type: 'string', nullable: true },
    tier: { type: 'string', enum: ['premium', 'mid', 'budget', 'unknown'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'school_name', 'inferred_profile', 'recommended_angle', 'best_programs',
    'watch_out', 'signals', 'tier', 'confidence',
  ],
} as const;

/**
 * Step 1 of the agent loop. Searches the live web for the school, then shapes
 * what it found into a structured brief. Unverified detail is left null rather
 * than guessed, because a wrong fact in a cold email costs the meeting.
 */
export async function researchSchool(school: SchoolRow): Promise<ResearchBrief> {
  const hint = [school.area && `Area: ${school.area}`, school.website && `Website: ${school.website}`, school.notes]
    .filter(Boolean)
    .join('. ');

  const { text, sources } = await groundedResearch(
    `Research the private K-12 school "${school.name}" in Lagos, Nigeria. ${hint}

Find and report only what you can actually verify from search results:
1. What kind of school it is: size, fee tier, curriculum (British, Nigerian, Montessori, IB), age range, campuses.
2. Its public positioning: what it advertises about itself, its values, its facilities.
3. Any existing extracurricular or enrichment programs it already runs.
4. Recent news, expansions, awards, new leadership, new campuses.
5. Public contact details: an official email address, the proprietor or head of school name, website.

State clearly which items you could not verify. Do not speculate or fill gaps with plausible detail.`,
  );

  const brief = await generateJson<ResearchBrief>({
    model: config.models.research,
    system: `${COMPANY_CONTEXT}\n\nYou are the research analyst for the Eduwalls sales team. You turn raw research notes into a sales brief. You never state as fact anything the notes do not support. Available programs: ${PROGRAMS.join(', ')}.`,
    prompt: `Raw research notes for "${school.name}":\n\n${text}\n\nTurn these notes into a structured brief for an Eduwalls cold outreach sequence.
- best_programs: pick 2 or 3 from the Eduwalls program list that best fit this school.
- recommended_angle: the single most persuasive way in, given what the notes support.
- watch_out: the likeliest objection or sensitivity for this specific school.
- signals: only concrete facts the notes verified. Empty array if none.
- contact_email, contact_name, website, area: only if the notes give them. Otherwise null.
- confidence: how much real, school-specific information the notes contained.`,
    schema: BRIEF_SCHEMA,
    temperature: 0.3,
  });

  brief.sources = sources;
  brief.best_programs = brief.best_programs.filter((p) => PROGRAMS.some((k) => k.toLowerCase() === p.toLowerCase()));
  if (brief.best_programs.length === 0) brief.best_programs = ['Coding', 'AI Literacy'];
  return brief;
}

export async function runResearch(school: SchoolRow): Promise<ResearchBrief> {
  updateSchool(school.id, { status: 'researching' });
  const brief = await researchSchool(school);
  updateSchool(school.id, {
    status: 'researched',
    research_json: JSON.stringify(brief),
    area: school.area ?? brief.area,
    website: school.website ?? brief.website,
    tier: school.tier ?? (brief.tier === 'unknown' ? null : brief.tier),
    contact_email: school.contact_email ?? brief.contact_email,
    contact_name: school.contact_name ?? brief.contact_name,
    last_error: null,
  });
  logEvent(school.id, 'research.done', { confidence: brief.confidence, signals: brief.signals.length });
  return brief;
}

interface DiscoveredSchool {
  name: string;
  area: string | null;
  website: string | null;
  why: string | null;
}

/**
 * Autonomous prospecting. Finds Lagos private schools that are not already in
 * the pipeline, so the funnel refills itself without Joy typing names.
 */
export async function discoverSchools(limit = 10): Promise<{ added: number; seen: number }> {
  const known = (getDb().prepare('SELECT name FROM schools ORDER BY id DESC LIMIT 400').all() as Array<{ name: string }>)
    .map((r) => r.name);

  const areas = ['Lekki', 'Ikeja', 'Yaba', 'Surulere', 'Ikoyi', 'Victoria Island', 'Ajah', 'Magodo', 'Gbagada', 'Ogudu', 'Festac', 'Ikorodu'];
  const focus = areas[Math.floor(Math.random() * areas.length)];

  const { text } = await groundedResearch(
    `List private K-12 schools in ${focus}, Lagos, Nigeria. For each school give the exact name, the specific area or neighbourhood, and the official website if one exists.
Focus on established private schools with their own campus, the kind that run structured extracurricular programs.
Exclude public and government schools, universities, polytechnics, tutorial centres, and creches.
List as many distinct real schools as you can verify, up to ${limit * 2}.`,
  );

  const parsed = await generateJson<{ schools: DiscoveredSchool[] }>({
    prompt: `Extract the schools from these notes into structured records. Only include schools explicitly named in the notes. Do not invent any.

NOTES:
${text}

Already in our pipeline, exclude these and any obvious spelling variant:
${known.join('; ') || '(none yet)'}`,
    schema: {
      type: 'object',
      properties: {
        schools: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              area: { type: 'string', nullable: true },
              website: { type: 'string', nullable: true },
              why: { type: 'string', nullable: true, description: 'Why this is a fit for school enrichment programs' },
            },
            required: ['name'],
          },
        },
      },
      required: ['schools'],
    },
    temperature: 0.2,
  });

  let added = 0;
  for (const s of (parsed.schools ?? []).slice(0, limit)) {
    if (!s.name || s.name.trim().length < 4) continue;
    const { created } = upsertSchool({
      name: s.name,
      area: s.area ?? focus,
      website: s.website ?? null,
      notes: s.why ?? null,
      source: `discovery:${focus}`,
    });
    if (created) added++;
  }
  logEvent(null, 'discovery.run', { area: focus, found: parsed.schools?.length ?? 0, added });
  return { added, seen: parsed.schools?.length ?? 0 };
}

/**
 * Focused second pass for schools whose brief came back without an address.
 * Only accepts an address that plausibly belongs to the school.
 */
export async function findContactEmail(school: SchoolRow): Promise<{ email: string | null; name: string | null }> {
  const { text } = await groundedResearch(
    `Find the official contact email address for the private school "${school.name}" in ${school.area ?? 'Lagos'}, Nigeria.
Check its website contact page, its Facebook or Instagram page, and any school directory listing.
Also find the name of the proprietor, principal, or head of school.
Report the exact email address as published. If you cannot find a real published address, say so plainly and do not guess one.`,
  );

  const parsed = await generateJson<{ email: string | null; name: string | null; verified: boolean }>({
    prompt: `From these notes, extract the school's official contact email and the head of school's name.
Set verified to false and email to null unless the notes show an actual published address.
Never construct an address from the school name or domain.

NOTES:
${text}`,
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', nullable: true },
        name: { type: 'string', nullable: true },
        verified: { type: 'boolean' },
      },
      required: ['verified'],
    },
    temperature: 0,
  });

  const email = parsed.verified && parsed.email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(parsed.email)
    ? parsed.email.toLowerCase()
    : null;

  if (email || parsed.name) {
    updateSchool(school.id, {
      contact_email: school.contact_email ?? email,
      contact_name: school.contact_name ?? parsed.name ?? null,
    });
    logEvent(school.id, 'contact.found', { email, name: parsed.name });
  } else {
    logEvent(school.id, 'contact.not_found', null);
  }
  return { email, name: parsed.name ?? null };
}
