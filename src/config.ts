import 'dotenv/config';

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const config = {
  // The only hard requirement. Everything else has a safe default.
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  models: {
    // Grounded research and reply triage.
    research: process.env.GEMINI_RESEARCH_MODEL ?? 'gemini-2.5-flash',
    // Qualification and email copy.
    writer: process.env.GEMINI_WRITER_MODEL ?? 'gemini-2.5-flash',
  },

  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH ?? 'data/autogtm.db',

  // Dry run is the default. Nothing leaves the building until Joy flips this.
  liveSend: bool(process.env.LIVE_SEND, false),

  sender: {
    email: process.env.FROM_EMAIL ?? 'hello@myeduwalls.com',
    name: process.env.FROM_NAME ?? 'Joy Adeniran, Eduwalls Africa',
    replyTo: process.env.REPLY_TO_EMAIL ?? process.env.FROM_EMAIL ?? 'hello@myeduwalls.com',
  },

  brevo: { apiKey: process.env.BREVO_API_KEY ?? '' },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },

  // Optional inbound mailbox polling so replies stop sequences on their own.
  imap: {
    host: process.env.IMAP_HOST ?? '',
    port: num(process.env.IMAP_PORT, 993),
    user: process.env.IMAP_USER ?? '',
    pass: process.env.IMAP_PASS ?? '',
  },

  hubspot: { token: process.env.HUBSPOT_ACCESS_TOKEN ?? '' },

  engine: {
    enabled: bool(process.env.ENGINE_ENABLED, true),
    tickSeconds: num(process.env.ENGINE_TICK_SECONDS, 300),
    // Guard rails. Cold outreach that runs hot gets a domain burned.
    maxSendsPerDay: num(process.env.MAX_SENDS_PER_DAY, 25),
    maxResearchPerTick: num(process.env.MAX_RESEARCH_PER_TICK, 3),
    maxSendsPerTick: num(process.env.MAX_SENDS_PER_TICK, 5),
    // Only email schools scoring at or above this out of 100.
    minScoreToContact: num(process.env.MIN_SCORE_TO_CONTACT, 60),
    followUp1Days: num(process.env.FOLLOWUP_1_DAYS, 5),
    followUp2Days: num(process.env.FOLLOWUP_2_DAYS, 10),
    // Autonomous prospecting: keep the funnel topped up to this many leads.
    autoDiscover: bool(process.env.AUTO_DISCOVER, true),
    discoverTargetBacklog: num(process.env.DISCOVER_TARGET_BACKLOG, 20),
    // Lagos business hours only (WAT = UTC+1), Mon-Fri.
    sendWindow: {
      enabled: bool(process.env.SEND_WINDOW_ENABLED, true),
      startHourWat: num(process.env.SEND_START_HOUR_WAT, 8),
      endHourWat: num(process.env.SEND_END_HOUR_WAT, 17),
    },
  },
} as const;

export function assertConfigured(): void {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
}

export type SendTransport = 'brevo' | 'smtp' | 'dry-run';

export function activeTransport(): SendTransport {
  if (!config.liveSend) return 'dry-run';
  if (config.brevo.apiKey) return 'brevo';
  if (config.smtp.host && config.smtp.user) return 'smtp';
  return 'dry-run';
}
