/**
 * Eduwalls business constraints. These are commercial rules, not style
 * preferences. Every generation path must include VOICE_RULES.
 */

export const COMPANY_CONTEXT = `You are writing as Joy Adeniran, CEO and co-founder of Eduwalls Africa (myeduwalls.com).
Eduwalls is a managed enrichment infrastructure company that deploys vetted specialist tutors
directly into private K-12 schools in Lagos. Schools sign a single contract granting access to
enrichment programs: Coding, AI Literacy, Robotics, Chess, French, Music, Creative Arts,
Taekwondo, and Teacher Training. Eduwalls handles all operations including tutor vetting,
curriculum, scheduling, attendance, replacement guarantees, and reporting. Schools carry zero
operational burden. Pricing is per enrolled student, per term, in Naira, invoiced to the school only.`;

export const PROOF_POINTS = `PROOF POINTS:
- BOVIC pilot school renewed after Term 1 before formal infrastructure existed
- AI Literacy and Google Workspace teacher training at Christ The Redeemer's School, Oworonshoki
- Members of NAPPS (National Association of Proprietors of Private Schools)
- Tagline: #TheFutureIsPracticed`;

export const PRICING_GUIDANCE = `PRICING GUIDANCE (never quote in emails, invite a conversation instead):
- Tech programs (Coding, AI Literacy, Robotics): NGN 10,000-12,000/student/term
- Arts programs: NGN 7,000-9,000/student/term
- Teacher Training: NGN 5,000/teacher with certificate`;

export const VOICE_RULES = `RULES (non-negotiable):
- The school is the customer. Never mention parent-facing features, parent pricing, or parent portals.
- Never quote exact prices. Invite a conversation.
- Keep each email tight. No walls of text.
- Do not use em dashes anywhere.
- Nigerian English conventions. Do not sound American or British.
- Warm, direct, never salesy.
- The CTA is always a simple low-friction ask (a call, a visit, a reply).
- Never invent facts about the school. If something is unverified, stay general rather than guessing.`;

export const PROGRAMS = [
  'Coding',
  'AI Literacy',
  'Robotics',
  'Chess',
  'French',
  'Music',
  'Creative Arts',
  'Taekwondo',
  'Teacher Training',
] as const;

/** Strips characters and phrases the brand rules forbid. */
export function enforceVoice(text: string): string {
  return text
    .replace(/—/g, ', ')  // em dash
    .replace(/–/g, '-')   // en dash
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .trim();
}

const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /—/, reason: 'contains an em dash' },
  { pattern: /\bparents?\b/i, reason: 'references parents; the school is the customer' },
  { pattern: /(NGN|\u20A6)\s?\d{1,3}[,.]?\d{3}/i, reason: 'quotes a price' },
];

/** Returns the reasons a draft violates the brand rules. Empty means clean. */
export function voiceViolations(text: string): string[] {
  return BANNED_PATTERNS.filter((b) => b.pattern.test(text)).map((b) => b.reason);
}
