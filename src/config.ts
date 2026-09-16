import 'dotenv/config';

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Boot-time environment only. Everything an operator can change at runtime
 * lives in the settings table instead, see src/settings.ts.
 */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '',
  port: num(process.env.PORT, 3000),

  // Guards the dashboard and the whole API. Without it the deployment is
  // public, so the server refuses to serve anything in production.
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
  // Guards the cron endpoint so only the scheduler can trigger a run.
  cronSecret: process.env.CRON_SECRET ?? '',
  // Encrypts secrets stored in the settings table. Recommended, not required.
  appSecret: process.env.APP_SECRET ?? '',

  isServerless: Boolean(process.env.VERCEL),
  isProduction: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),

  // Seed values. The settings table wins once a value is saved there.
  seed: {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    researchModel: process.env.GEMINI_RESEARCH_MODEL ?? 'gemini-2.5-flash',
    writerModel: process.env.GEMINI_WRITER_MODEL ?? 'gemini-2.5-flash',
    liveSend: bool(process.env.LIVE_SEND, false),
    fromEmail: process.env.FROM_EMAIL ?? '',
    fromName: process.env.FROM_NAME ?? 'Joy Adeniran, Eduwalls Africa',
    replyTo: process.env.REPLY_TO_EMAIL ?? '',
    brevoApiKey: process.env.BREVO_API_KEY ?? '',
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: num(process.env.SMTP_PORT, 587),
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPass: process.env.SMTP_PASS ?? '',
    imapHost: process.env.IMAP_HOST ?? '',
    imapPort: num(process.env.IMAP_PORT, 993),
    imapUser: process.env.IMAP_USER ?? '',
    imapPass: process.env.IMAP_PASS ?? '',
    hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN ?? '',
    maxSendsPerDay: num(process.env.MAX_SENDS_PER_DAY, 25),
    maxSendsPerTick: num(process.env.MAX_SENDS_PER_TICK, 5),
    maxResearchPerTick: num(process.env.MAX_RESEARCH_PER_TICK, 3),
    minScoreToContact: num(process.env.MIN_SCORE_TO_CONTACT, 60),
    followUp1Days: num(process.env.FOLLOWUP_1_DAYS, 5),
    followUp2Days: num(process.env.FOLLOWUP_2_DAYS, 10),
    autoDiscover: bool(process.env.AUTO_DISCOVER, true),
    discoverTargetBacklog: num(process.env.DISCOVER_TARGET_BACKLOG, 20),
    sendWindowEnabled: bool(process.env.SEND_WINDOW_ENABLED, true),
    sendStartHourWat: num(process.env.SEND_START_HOUR_WAT, 8),
    sendEndHourWat: num(process.env.SEND_END_HOUR_WAT, 17),
    engineEnabled: bool(process.env.ENGINE_ENABLED, true),
    engineTickSeconds: num(process.env.ENGINE_TICK_SECONDS, 300),
  },
} as const;
