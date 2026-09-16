// Vercel serverless entry. One function handles every route; vercel.json
// rewrites all traffic here. The Fastify app is built once per cold start and
// reused across invocations on the same instance.
import { buildServer } from '../dist/server.js';
import { ensureSchema } from '../dist/db.js';

let ready = null;

async function getApp() {
  if (!ready) {
    ready = (async () => {
      const app = buildServer();
      await app.ready();
      // Lazy migration: the schema is created on first use, so there is no
      // separate deploy step to forget.
      await ensureSchema().catch((err) => {
        app.log.error({ err }, 'schema creation failed');
      });
      return app;
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    app.server.emit('request', req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}
