import { generateJson } from '../gemini.js';
import { COMPANY_CONTEXT } from '../brand.js';
import { getSettings } from '../settings.js';
import { logEvent, updateSchool, type SchoolRow } from '../db.js';
import type { ResearchBrief } from './research.js';

export interface Qualification {
  score: number;
  verdict: 'pursue' | 'hold' | 'skip';
  reasoning: string;
  fit_factors: string[];
  risk_factors: string[];
  priority_program: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: '0 to 100 fit score against the Eduwalls ICP' },
    verdict: { type: 'string', enum: ['pursue', 'hold', 'skip'] },
    reasoning: { type: 'string', description: '1 to 2 sentences' },
    fit_factors: { type: 'array', items: { type: 'string' } },
    risk_factors: { type: 'array', items: { type: 'string' } },
    priority_program: { type: 'string' },
  },
  required: ['score', 'verdict', 'reasoning', 'fit_factors', 'risk_factors', 'priority_program'],
} as const;

const ICP = `IDEAL CUSTOMER PROFILE:
- Private K-12 school in Lagos with its own campus and 150 or more enrolled students
- Mid to premium fee tier. The school must be able to invoice enrichment per student per term
- Proprietor-led or with an engaged head of school who can decide without a long board process
- Already signals that it cares about differentiation: STEM, tech, "21st century skills", competitions, clubs
- Either runs no structured enrichment, or runs it badly through ad hoc individual tutors

POOR FIT:
- Public or government schools, they cannot invoice this way
- Very small schools under roughly 100 students, the per student model does not carry the cost
- Creches and standalone nursery schools, the programs do not apply
- Tutorial centres and exam prep centres, they are not the buyer
- Schools that already run a well established in-house enrichment department with their own specialist staff
- International schools with large in-house budgets that build their own programs`;

/** Step 2 of the loop. Scores the brief against the ICP before spending a send. */
export async function qualifySchool(school: SchoolRow, brief: ResearchBrief): Promise<Qualification> {
  const q = await generateJson<Qualification>({
    system: `${COMPANY_CONTEXT}\n\nYou are a disciplined sales qualifier. You protect the team's time by scoring honestly. A thin brief with no verified detail is not a high score, it is an unknown, so score it in the middle and flag the gap.\n\n${ICP}`,
    prompt: `Qualify this school.

SCHOOL: ${school.name}
AREA: ${school.area ?? 'unknown'}
TIER: ${school.tier ?? brief.tier}
RESEARCH CONFIDENCE: ${brief.confidence}
PROFILE: ${brief.inferred_profile}
VERIFIED SIGNALS: ${brief.signals.length ? brief.signals.join('; ') : 'none verified'}
RECOMMENDED ANGLE: ${brief.recommended_angle}
SUGGESTED PROGRAMS: ${brief.best_programs.join(', ')}
WATCH OUT: ${brief.watch_out}

Score 0 to 100 on ICP fit. Use "skip" only for a clear structural disqualifier such as a public school, a creche, or a tutorial centre. Use "hold" when the research is too thin to justify outreach yet.`,
    schema: SCHEMA,
    temperature: 0.2,
  });
  q.score = Math.max(0, Math.min(100, Math.round(q.score)));
  return q;
}

export async function runQualify(school: SchoolRow, brief: ResearchBrief): Promise<Qualification> {
  const q = await qualifySchool(school, brief);
  const merged = { ...brief, qualification: q };
  const settings = await getSettings();
  const passes = q.verdict === 'pursue' && q.score >= settings.minScoreToContact;

  await updateSchool(school.id, {
    score: q.score,
    research_json: JSON.stringify(merged),
    status: passes ? 'researched' : 'disqualified',
    disqualified_reason: passes ? null : `${q.verdict} at score ${q.score}: ${q.reasoning}`,
  });
  await logEvent(school.id, passes ? 'qualify.pass' : 'qualify.fail', { score: q.score, verdict: q.verdict });
  return q;
}
