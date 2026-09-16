import { env } from './config.js';
import { sql, logEvent } from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';

/**
 * Runtime configuration. Resolution order: the settings table, then the
 * environment, then the built in default. Anything editable in the dashboard
 * lives here so Joy can connect a mailbox without a redeploy.
 */
export interface Settings {
  geminiApiKey: string;
  researchModel: string;
  writerModel: string;

  liveSend: boolean;
  fromEmail: string;
  fromName: string;
  replyTo: string;

  brevoApiKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;

  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;

  hubspotToken: string;

  maxSendsPerDay: number;
  maxSendsPerTick: number;
  maxResearchPerTick: number;
  minScoreToContact: number;
  followUp1Days: number;
  followUp2Days: number;
  autoDiscover: boolean;
  discoverTargetBacklog: number;
  sendWindowEnabled: boolean;
  sendStartHourWat: number;
  sendEndHourWat: number;
  engineEnabled: boolean;
  engineTickSeconds: number;
}

export const SECRET_KEYS = [
  'geminiApiKey', 'brevoApiKey', 'smtpPass', 'imapPass', 'hubspotToken',
] as const satisfies readonly (keyof Settings)[];

type BoolKey = 'liveSend' | 'autoDiscover' | 'sendWindowEnabled' | 'engineEnabled';
type NumKey =
  | 'smtpPort' | 'imapPort' | 'maxSendsPerDay' | 'maxSendsPerTick' | 'maxResearchPerTick'
  | 'minScoreToContact' | 'followUp1Days' | 'followUp2Days' | 'discoverTargetBacklog'
  | 'sendStartHourWat' | 'sendEndHourWat' | 'engineTickSeconds';

const BOOL_KEYS: BoolKey[] = ['liveSend', 'autoDiscover', 'sendWindowEnabled', 'engineEnabled'];
const NUM_KEYS: NumKey[] = [
  'smtpPort', 'imapPort', 'maxSendsPerDay', 'maxSendsPerTick', 'maxResearchPerTick',
  'minScoreToContact', 'followUp1Days', 'followUp2Days', 'discoverTargetBacklog',
  'sendStartHourWat', 'sendEndHourWat', 'engineTickSeconds',
];

function defaults(): Settings {
  const s = env.seed;
  return {
    geminiApiKey: s.geminiApiKey,
    researchModel: s.researchModel,
    writerModel: s.writerModel,
    liveSend: s.liveSend,
    fromEmail: s.fromEmail,
    fromName: s.fromName,
    replyTo: s.replyTo || s.fromEmail,
    brevoApiKey: s.brevoApiKey,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpUser: s.smtpUser,
    smtpPass: s.smtpPass,
    imapHost: s.imapHost,
    imapPort: s.imapPort,
    imapUser: s.imapUser,
    imapPass: s.imapPass,
    hubspotToken: s.hubspotToken,
    maxSendsPerDay: s.maxSendsPerDay,
    maxSendsPerTick: s.maxSendsPerTick,
    maxResearchPerTick: s.maxResearchPerTick,
    minScoreToContact: s.minScoreToContact,
    followUp1Days: s.followUp1Days,
    followUp2Days: s.followUp2Days,
    autoDiscover: s.autoDiscover,
    discoverTargetBacklog: s.discoverTargetBacklog,
    sendWindowEnabled: s.sendWindowEnabled,
    sendStartHourWat: s.sendStartHourWat,
    sendEndHourWat: s.sendEndHourWat,
    engineEnabled: s.engineEnabled,
    engineTickSeconds: s.engineTickSeconds,
  };
}

let cache: { at: number; value: Settings } | null = null;
const CACHE_MS = 15_000;

export async function getSettings(force = false): Promise<Settings> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const resolved = defaults();
  const rows = await sql()<{ key: string; value: string; is_secret: boolean }[]>`SELECT key, value, is_secret FROM settings`;

  for (const row of rows) {
    if (!(row.key in resolved)) continue;
    const key = row.key as keyof Settings;
    let raw = row.value;
    if (row.is_secret) {
      try {
        raw = decryptSecret(raw);
      } catch {
        // A rotated APP_SECRET makes old secrets unreadable. Fall back to the
        // environment rather than handing a corrupt key to a provider.
        continue;
      }
    }
    if (BOOL_KEYS.includes(key as BoolKey)) {
      (resolved as unknown as Record<string, unknown>)[key] = raw === 'true';
    } else if (NUM_KEYS.includes(key as NumKey)) {
      const n = Number(raw);
      if (Number.isFinite(n)) (resolved as unknown as Record<string, unknown>)[key] = n;
    } else {
      (resolved as unknown as Record<string, unknown>)[key] = raw;
    }
  }

  if (!resolved.replyTo) resolved.replyTo = resolved.fromEmail;
  cache = { at: Date.now(), value: resolved };
  return resolved;
}

export function invalidateSettings(): void {
  cache = null;
}

const EDITABLE = new Set<string>([...Object.keys(defaults())]);

/** Writes settings from the dashboard. Empty string clears back to the env value. */
export async function saveSettings(patch: Record<string, unknown>): Promise<string[]> {
  const s = sql();
  const applied: string[] = [];

  for (const [key, rawValue] of Object.entries(patch)) {
    if (!EDITABLE.has(key)) continue;
    const isSecret = (SECRET_KEYS as readonly string[]).includes(key);
    const value = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue ?? '').trim();

    // An empty value means "stop overriding", not "set to blank".
    if (value === '') {
      await s`DELETE FROM settings WHERE key = ${key}`;
      applied.push(key);
      continue;
    }
    // A masked field that came back unchanged must not overwrite the real secret.
    if (isSecret && /^[*]+$/.test(value)) continue;

    const stored = isSecret ? encryptSecret(value) : value;
    await s`
      INSERT INTO settings (key, value, is_secret, updated_at)
      VALUES (${key}, ${stored}, ${isSecret}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = now()`;
    applied.push(key);
  }

  invalidateSettings();
  if (applied.length) await logEvent(null, 'settings.updated', { keys: applied });
  return applied;
}

/** Dashboard-safe view: secrets become a configured flag, never a value. */
export async function settingsForDisplay(): Promise<Record<string, unknown>> {
  const s = await getSettings(true);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      out[key] = value ? '********' : '';
      out[`${key}_configured`] = Boolean(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type SendTransport = 'brevo' | 'smtp' | 'dry-run';

export function transportFor(s: Settings): SendTransport {
  if (!s.liveSend) return 'dry-run';
  if (s.brevoApiKey) return 'brevo';
  if (s.smtpHost && s.smtpUser) return 'smtp';
  return 'dry-run';
}

export function imapConfiguredIn(s: Settings): boolean {
  return Boolean(s.imapHost && s.imapUser && s.imapPass);
}

/**
 * Reasons the agent cannot currently do its job end to end. Surfaced in the
 * dashboard so a half-connected deployment is obvious rather than silent.
 */
export function readiness(s: Settings): { ready: boolean; blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!s.geminiApiKey) blockers.push('No Gemini API key. The agent cannot research, qualify or write.');
  if (s.liveSend && transportFor(s) === 'dry-run') {
    blockers.push('Live sending is on but no Brevo key or SMTP host is configured, so nothing can be delivered.');
  }
  if (s.liveSend && !s.fromEmail) blockers.push('Live sending is on but no sender address is set.');

  if (!s.liveSend) warnings.push('Dry run: everything runs except delivery.');
  if (!imapConfiguredIn(s)) {
    warnings.push('No mailbox connected, so replies are invisible. The agent will keep following up with schools that answered.');
  }
  if (!s.hubspotToken) warnings.push('HubSpot not connected, so nothing is mirrored to the CRM.');

  return { ready: blockers.length === 0, blockers, warnings };
}
