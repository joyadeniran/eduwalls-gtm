import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, activeTransport, assertConfigured } from './config.js';
import { getDb, getSchool, logEvent, sentToday, updateSchool, upsertSchool, type EmailRow, type EventRow, type SchoolRow } from './db.js';
import { startEngine, stopEngine, engineRunning, safeTick, getLastReport, advanceToSequenced, sendNextStep } from './engine.js';
import { discoverSchools } from './pipeline/research.js';
import { recordReply, imapConfigured } from './pipeline/replies.js';
import { hubspotEnabled } from './crm.js';
import { healthCheck } from './gemini.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.register(fastifyStatic, { root: publicDir });

  app.get('/api/status', async () => {
    const d = getDb();
    const byStatus = d.prepare('SELECT status, COUNT(*) AS n FROM schools GROUP BY status').all() as Array<{ status: string; n: number }>;
    const emails = d.prepare(`SELECT status, COUNT(*) AS n FROM emails GROUP BY status`).all() as Array<{ status: string; n: number }>;
    return {
      engine: {
        running: engineRunning(),
        tickSeconds: config.engine.tickSeconds,
        lastReport: getLastReport(),
      },
      sending: {
        transport: activeTransport(),
        live: config.liveSend,
        sentToday: sentToday(),
        dailyCap: config.engine.maxSendsPerDay,
        from: `${config.sender.name} <${config.sender.email}>`,
      },
      integrations: { hubspot: hubspotEnabled(), imap: imapConfigured() },
      pipeline: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      emails: Object.fromEntries(emails.map((r) => [r.status, r.n])),
    };
  });

  app.get('/api/health', async () => ({ ok: await healthCheck(), model: config.models.writer }));

  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/schools', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 500);
    const rows = req.query.status
      ? (getDb().prepare('SELECT * FROM schools WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(req.query.status, limit) as SchoolRow[])
      : (getDb().prepare('SELECT * FROM schools ORDER BY updated_at DESC LIMIT ?').all(limit) as SchoolRow[]);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/api/schools/:id', async (req, reply) => {
    const school = getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const d = getDb();
    return {
      school,
      emails: d.prepare('SELECT * FROM emails WHERE school_id = ? ORDER BY step').all(school.id) as EmailRow[],
      events: d.prepare('SELECT * FROM events WHERE school_id = ? ORDER BY id DESC LIMIT 50').all(school.id) as EventRow[],
    };
  });

  app.post<{ Body: { name?: string; names?: string[]; area?: string; tier?: string; contact_email?: string; contact_name?: string; notes?: string; website?: string } }>(
    '/api/schools',
    async (req, reply) => {
      const body = req.body ?? {};
      const names = body.names ?? (body.name ? [body.name] : []);
      if (names.length === 0) return reply.code(400).send({ error: 'name or names required' });
      const created = names.map((name) =>
        upsertSchool({
          name,
          area: body.area ?? null,
          tier: body.tier ?? null,
          website: body.website ?? null,
          contact_email: names.length === 1 ? body.contact_email ?? null : null,
          contact_name: names.length === 1 ? body.contact_name ?? null : null,
          notes: body.notes ?? null,
          source: 'manual',
        }),
      );
      return { added: created.filter((c) => c.created).length, schools: created.map((c) => c.school) };
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<SchoolRow> }>('/api/schools/:id', async (req, reply) => {
    const school = getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const allowed = ['contact_email', 'contact_name', 'area', 'tier', 'notes', 'status', 'next_action_at', 'website'] as const;
    const patch: Partial<SchoolRow> = {};
    for (const key of allowed) {
      if (key in (req.body ?? {})) (patch as Record<string, unknown>)[key] = (req.body as Record<string, unknown>)[key];
    }
    // Supplying a missing address should unblock the send on the next tick.
    if (patch.contact_email && !school.contact_email && school.status === 'sequenced') {
      patch.next_action_at = new Date().toISOString();
      patch.last_error = null;
      getDb().prepare(`UPDATE emails SET to_email = ? WHERE school_id = ?`).run(patch.contact_email, school.id);
    }
    updateSchool(school.id, patch);
    logEvent(school.id, 'school.updated', patch);
    return getSchool(school.id);
  });

  // Run research, qualification and drafting for one school, on demand.
  app.post<{ Params: { id: string } }>('/api/schools/:id/prepare', async (req, reply) => {
    const school = getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const outcome = await advanceToSequenced(school);
    return { outcome, school: getSchool(school.id) };
  });

  // Send the next due step now, bypassing the schedule but not the daily cap.
  app.post<{ Params: { id: string } }>('/api/schools/:id/send-next', async (req, reply) => {
    const school = getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const sent = await sendNextStep(school);
    return { sent, school: getSchool(school.id) };
  });

  app.post<{ Params: { id: string }; Body: { subject?: string; body?: string } }>('/api/schools/:id/reply', async (req, reply) => {
    const school = getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const triage = await recordReply(school, req.body?.subject ?? '(no subject)', req.body?.body ?? '');
    return { triage, school: getSchool(school.id) };
  });

  app.post<{ Body: { limit?: number } }>('/api/discover', async (req) => discoverSchools(Math.min(req.body?.limit ?? 10, 25)));

  app.post('/api/engine/tick', async () => (await safeTick()) ?? { skipped: 'a tick is already running' });

  app.post<{ Body: { on?: boolean } }>('/api/engine', async (req) => {
    if (req.body?.on === false) stopEngine();
    else startEngine();
    return { running: engineRunning() };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/events', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    return getDb()
      .prepare(
        `SELECT e.*, s.name AS school_name FROM events e
         LEFT JOIN schools s ON s.id = e.school_id
         ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit);
  });

  return app;
}

async function main(): Promise<void> {
  assertConfigured();
  getDb();
  const app = buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    `AutoGTM up. transport=${activeTransport()} hubspot=${hubspotEnabled()} imap=${imapConfigured()} cap=${config.engine.maxSendsPerDay}/day`,
  );
  if (config.engine.enabled) startEngine();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopEngine();
      void app.close().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
