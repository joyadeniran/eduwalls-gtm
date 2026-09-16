import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { env } from './config.js';
import {
  sql, ensureSchema, getSchool, logEvent, sentToday, updateSchool, upsertSchool,
  type EmailRow, type SchoolRow,
} from './db.js';
import { getSettings, settingsForDisplay, saveSettings, transportFor, imapConfiguredIn, readiness } from './settings.js';
import { secretsEncrypted, safeEqual, sessionToken } from './crypto.js';
import {
  startEngine, stopEngine, engineRunning, safeTick, getLastReport,
  advanceToSequenced, sendNextStep, runTicks,
} from './engine.js';
import { discoverSchools } from './pipeline/research.js';
import { recordReply, pollInbox } from './pipeline/replies.js';
import { verifyTransport } from './pipeline/send.js';
import { healthCheck } from './gemini.js';
import { DASHBOARD_HTML } from './dashboard.js';

const COOKIE = 'autogtm_session';

function isAuthed(req: FastifyRequest): boolean {
  if (!env.dashboardPassword) return !env.isProduction; // open only for local dev
  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (match?.[1] && safeEqual(match[1], sessionToken())) return true;

  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(bearer) && safeEqual(bearer, env.dashboardPassword);
}

function cronAuthorised(req: FastifyRequest): boolean {
  if (!env.cronSecret) return false;
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const query = (req.query as { secret?: string } | undefined)?.secret ?? '';
  return (Boolean(bearer) && safeEqual(bearer, env.cronSecret)) || (Boolean(query) && safeEqual(query, env.cronSecret));
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  // The schema is created lazily so a cold serverless start needs no deploy step.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/cron')) return; // cron has its own guard
    if (env.isProduction && !env.dashboardPassword) {
      return reply.code(503).type('text/plain').send(
        'DASHBOARD_PASSWORD is not set. Refusing to serve an unprotected deployment that can send email and holds API keys.',
      );
    }
    if (req.url === '/login' || req.url === '/api/login') return;
    if (isAuthed(req)) return;
    if (req.url.startsWith('/api/')) return reply.code(401).send({ error: 'unauthorised' });
    return reply.redirect('/login');
  });

  app.get('/login', async (_req, reply) => reply.type('text/html').send(LOGIN_PAGE));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const password = req.body?.password ?? '';
    if (!env.dashboardPassword || !password || !safeEqual(password, env.dashboardPassword)) {
      return reply.code(401).send({ error: 'Wrong password' });
    }
    reply.header(
      'set-cookie',
      `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${env.isProduction ? '; Secure' : ''}`,
    );
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return { ok: true };
  });

  app.get('/', async (_req, reply) => reply.type('text/html').send(DASHBOARD_HTML));

  // --- status ------------------------------------------------------------
  app.get('/api/status', async () => {
    await ensureSchema();
    const s = await getSettings(true);
    const [byStatus, byEmail] = await Promise.all([
      sql()<{ status: string; n: string }[]>`SELECT status, COUNT(*) AS n FROM schools GROUP BY status`,
      sql()<{ status: string; n: string }[]>`SELECT status, COUNT(*) AS n FROM emails GROUP BY status`,
    ]);
    return {
      engine: {
        running: engineRunning(),
        enabled: s.engineEnabled,
        serverless: env.isServerless,
        tickSeconds: s.engineTickSeconds,
        lastReport: getLastReport(),
      },
      sending: {
        transport: transportFor(s),
        live: s.liveSend,
        sentToday: await sentToday(),
        dailyCap: s.maxSendsPerDay,
        from: s.fromEmail ? `${s.fromName} <${s.fromEmail}>` : 'no sender configured',
      },
      integrations: {
        gemini: Boolean(s.geminiApiKey),
        hubspot: Boolean(s.hubspotToken),
        imap: imapConfiguredIn(s),
        secretsEncrypted: secretsEncrypted(),
      },
      readiness: readiness(s),
      pipeline: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      emails: Object.fromEntries(byEmail.map((r) => [r.status, Number(r.n)])),
    };
  });

  // --- settings ----------------------------------------------------------
  app.get('/api/settings', async () => {
    await ensureSchema();
    return { settings: await settingsForDisplay(), secretsEncrypted: secretsEncrypted() };
  });

  app.put<{ Body: Record<string, unknown> }>('/api/settings', async (req) => {
    await ensureSchema();
    const applied = await saveSettings(req.body ?? {});
    return { applied, settings: await settingsForDisplay() };
  });

  /** Tests each connection with the credentials currently saved. */
  app.post<{ Body: { target?: string } }>('/api/settings/test', async (req) => {
    await ensureSchema();
    const target = req.body?.target ?? 'all';
    const s = await getSettings(true);
    const results: Record<string, { ok: boolean; detail: string }> = {};

    if (target === 'all' || target === 'gemini') {
      const h = await healthCheck();
      results.gemini = { ok: h.ok, detail: h.detail };
    }
    if (target === 'all' || target === 'email') {
      results.email = await verifyTransport().then((r) => ({ ok: r.ok, detail: r.detail }));
    }
    if (target === 'all' || target === 'imap') {
      if (!imapConfiguredIn(s)) {
        results.imap = { ok: false, detail: 'No mailbox configured. Replies will be invisible.' };
      } else {
        try {
          const r = await pollInbox();
          results.imap = { ok: true, detail: `Mailbox reachable. Scanned ${r.scanned} new messages, matched ${r.matched}.` };
        } catch (err) {
          results.imap = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    if (target === 'all' || target === 'hubspot') {
      if (!s.hubspotToken) {
        results.hubspot = { ok: false, detail: 'No HubSpot token. Nothing is mirrored to the CRM.' };
      } else {
        const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies?limit=1', {
          headers: { authorization: `Bearer ${s.hubspotToken}` },
        });
        results.hubspot = res.ok
          ? { ok: true, detail: 'HubSpot token accepted.' }
          : { ok: false, detail: `HubSpot rejected the token: ${res.status} ${(await res.text()).slice(0, 160)}` };
      }
    }
    await logEvent(null, 'settings.tested', results);
    return results;
  });

  // --- schools -----------------------------------------------------------
  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/schools', async (req) => {
    await ensureSchema();
    const limit = Math.min(Number(req.query.limit ?? 200), 500);
    return req.query.status
      ? sql()<SchoolRow[]>`SELECT * FROM schools WHERE status = ${req.query.status} ORDER BY updated_at DESC LIMIT ${limit}`
      : sql()<SchoolRow[]>`SELECT * FROM schools ORDER BY updated_at DESC LIMIT ${limit}`;
  });

  app.get<{ Params: { id: string } }>('/api/schools/:id', async (req, reply) => {
    const school = await getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const [emails, events] = await Promise.all([
      sql()<EmailRow[]>`SELECT * FROM emails WHERE school_id = ${school.id} ORDER BY step`,
      sql()`SELECT * FROM events WHERE school_id = ${school.id} ORDER BY id DESC LIMIT 50`,
    ]);
    return { school, emails, events };
  });

  app.post<{ Body: { name?: string; names?: string[]; area?: string; tier?: string; contact_email?: string; contact_name?: string; notes?: string; website?: string } }>(
    '/api/schools',
    async (req, reply) => {
      await ensureSchema();
      const body = req.body ?? {};
      const names = body.names ?? (body.name ? [body.name] : []);
      if (names.length === 0) return reply.code(400).send({ error: 'name or names required' });
      const results = [];
      for (const name of names.slice(0, 100)) {
        if (!name.trim()) continue;
        results.push(
          await upsertSchool({
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
      }
      return { added: results.filter((r) => r.created).length, schools: results.map((r) => r.school) };
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<SchoolRow> }>('/api/schools/:id', async (req, reply) => {
    const school = await getSchool(Number(req.params.id));
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
      await sql()`UPDATE emails SET to_email = ${patch.contact_email} WHERE school_id = ${school.id}`;
    }
    await updateSchool(school.id, patch);
    await logEvent(school.id, 'school.updated', patch);
    return getSchool(school.id);
  });

  app.post<{ Params: { id: string } }>('/api/schools/:id/prepare', async (req, reply) => {
    const school = await getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const outcome = await advanceToSequenced(school);
    return { outcome, school: await getSchool(school.id) };
  });

  app.post<{ Params: { id: string } }>('/api/schools/:id/send-next', async (req, reply) => {
    const school = await getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const sent = await sendNextStep(school);
    return { sent, school: await getSchool(school.id) };
  });

  app.post<{ Params: { id: string }; Body: { subject?: string; body?: string } }>('/api/schools/:id/reply', async (req, reply) => {
    const school = await getSchool(Number(req.params.id));
    if (!school) return reply.code(404).send({ error: 'not found' });
    const triage = await recordReply(school, req.body?.subject ?? '(no subject)', req.body?.body ?? '');
    return { triage, school: await getSchool(school.id) };
  });

  // --- engine ------------------------------------------------------------
  app.post<{ Body: { limit?: number } }>('/api/discover', async (req) => {
    await ensureSchema();
    return discoverSchools(Math.min(req.body?.limit ?? 10, 25));
  });

  app.post('/api/engine/tick', async () => {
    await ensureSchema();
    return (await safeTick()) ?? { skipped: 'a run is already in progress' };
  });

  app.post<{ Body: { on?: boolean } }>('/api/engine', async (req) => {
    if (req.body?.on === false) await stopEngine();
    else await startEngine();
    return { running: engineRunning() };
  });

  /**
   * Scheduler entry point. Guarded by CRON_SECRET, not the dashboard password,
   * so Vercel Cron or any external pinger can drive the loop.
   */
  app.all('/api/cron', async (req, reply) => {
    if (!cronAuthorised(req)) return reply.code(401).send({ error: 'unauthorised' });
    await ensureSchema();
    const result = await runTicks({ timeBudgetMs: 45_000 });
    const totals = result.ticks.reduce(
      (acc, t) => ({
        sent: acc.sent + t.sent,
        researched: acc.researched + t.researched,
        discovered: acc.discovered + t.discovered,
        replies: acc.replies + t.repliesMatched,
      }),
      { sent: 0, researched: 0, discovered: 0, replies: 0 },
    );
    return { ticks: result.ticks.length, stopped: result.stopped, totals, detail: result.ticks };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/events', async (req) => {
    await ensureSchema();
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    return sql()`
      SELECT e.*, s.name AS school_name FROM events e
      LEFT JOIN schools s ON s.id = e.school_id
      ORDER BY e.id DESC LIMIT ${limit}`;
  });

  return app;
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Eduwalls AutoGTM</title>
<style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#0B1C2C;color:#EEF3F7;
font-family:Inter,system-ui,-apple-system,sans-serif}
form{background:#132234;padding:32px;border-radius:12px;width:320px}
h1{font-size:16px;margin:0 0 4px}h1 span{color:#2ECC8F}
p{color:#8BA3B5;font-size:12px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;background:#1A2E44;border:1px solid transparent;border-radius:6px;
color:#EEF3F7;padding:10px;font-family:inherit;margin-bottom:12px}
input:focus{outline:none;border-color:#2ECC8F}
button{width:100%;background:#2ECC8F;color:#06121C;border:0;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;font-family:inherit}
.err{color:#E05252;font-size:12px;margin-top:10px;min-height:16px}
</style></head><body>
<form id="f"><h1>Eduwalls <span>AutoGTM</span></h1><p>Internal tool. Sign in to continue.</p>
<input type="password" id="p" placeholder="Password" autofocus autocomplete="current-password" />
<button>Sign in</button><div class="err" id="e"></div></form>
<script>
document.getElementById('f').onsubmit=async(ev)=>{ev.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok)location.href='/';else document.getElementById('e').textContent='Wrong password';};
</script></body></html>`;

async function main(): Promise<void> {
  await ensureSchema();
  const app = buildServer();
  await app.listen({ port: env.port, host: '0.0.0.0' });
  const s = await getSettings();
  app.log.info(`AutoGTM up. transport=${transportFor(s)} imap=${imapConfiguredIn(s)} cap=${s.maxSendsPerDay}/day`);
  if (s.engineEnabled) await startEngine();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stopEngine().then(() => app.close()).then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
