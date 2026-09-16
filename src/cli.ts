/**
 * Operator CLI. Everything the dashboard does, without a browser.
 *   npm run agent -- add "Greensprings School" --area Lekki
 *   npm run agent -- discover 10
 *   npm run agent -- prepare 3
 *   npm run agent -- tick
 *   npm run agent -- status
 *   npm run agent -- show 3
 *   npm run agent -- test
 */
import { closeDb, ensureSchema, getSchool, sql, sentToday, upsertSchool, type EmailRow, type SchoolRow } from './db.js';
import { getSettings, transportFor, imapConfiguredIn, readiness } from './settings.js';
import { advanceToSequenced, safeTick, sendNextStep } from './engine.js';
import { discoverSchools } from './pipeline/research.js';
import { verifyTransport } from './pipeline/send.js';
import { healthCheck } from './gemini.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  await ensureSchema();

  switch (command) {
    case 'add': {
      const name = args[0];
      if (!name) throw new Error('usage: add "School Name" [--area Lekki] [--email head@school.com]');
      const { school, created } = await upsertSchool({
        name,
        area: flag(args, 'area') ?? null,
        tier: flag(args, 'tier') ?? null,
        contact_email: flag(args, 'email') ?? null,
        contact_name: flag(args, 'contact') ?? null,
        notes: flag(args, 'notes') ?? null,
        source: 'cli',
      });
      console.log(`${created ? 'Added' : 'Already tracked'} #${school.id} ${school.name}`);
      break;
    }
    case 'discover': {
      const res = await discoverSchools(Number(args[0] ?? 10));
      console.log(`Discovery found ${res.seen} schools, added ${res.added} new leads.`);
      break;
    }
    case 'prepare': {
      const id = Number(args[0]);
      const school = await getSchool(id);
      if (!school) throw new Error(`No school with id ${id}`);
      console.log(`Researching ${school.name}...`);
      const outcome = await advanceToSequenced(school);
      const after = (await getSchool(id))!;
      console.log(`Outcome: ${outcome}. Status: ${after.status}. Score: ${after.score ?? 'n/a'}.`);
      if (after.disqualified_reason) console.log(`Reason: ${after.disqualified_reason}`);
      if (outcome === 'blocked') console.log('Sequence drafted but no contact email found. Add one to unblock.');
      break;
    }
    case 'send': {
      const id = Number(args[0]);
      const school = await getSchool(id);
      if (!school) throw new Error(`No school with id ${id}`);
      const sent = await sendNextStep(school);
      const s = await getSettings();
      console.log(sent ? `Sent via ${transportFor(s)}. Status now ${(await getSchool(id))!.status}.` : 'Nothing due to send.');
      break;
    }
    case 'tick': {
      console.log(JSON.stringify(await safeTick(), null, 2));
      break;
    }
    case 'show': {
      const id = Number(args[0]);
      const school = await getSchool(id);
      if (!school) throw new Error(`No school with id ${id}`);
      console.log(`\n${school.name}  [${school.status}]  score ${school.score ?? 'n/a'}`);
      console.log(`${school.area ?? 'Lagos'} | ${school.contact_email ?? 'no email yet'}`);
      if (school.research_json) {
        const brief = JSON.parse(school.research_json) as Record<string, unknown>;
        console.log(`\nProfile: ${brief.inferred_profile}`);
        console.log(`Angle:   ${brief.recommended_angle}`);
      }
      const emails = await sql()<EmailRow[]>`SELECT * FROM emails WHERE school_id = ${id} ORDER BY step`;
      for (const e of emails) {
        console.log(`\n--- Email ${e.step} [${e.status}] ---\nSubject: ${e.subject}\n\n${e.body}`);
      }
      break;
    }
    case 'test': {
      const gemini = await healthCheck();
      const email = await verifyTransport();
      console.log(`Gemini:    ${gemini.ok ? 'ok' : 'FAILED'} - ${gemini.detail}`);
      console.log(`Sending:   ${email.ok ? 'ok' : 'FAILED'} - ${email.detail}`);
      const s = await getSettings();
      console.log(`Mailbox:   ${imapConfiguredIn(s) ? 'configured' : 'not connected, replies are invisible'}`);
      console.log(`HubSpot:   ${s.hubspotToken ? 'configured' : 'not connected'}`);
      break;
    }
    case 'status':
    default: {
      const s = await getSettings();
      const rows = await sql()<{ status: string; n: string }[]>`
        SELECT status, COUNT(*) AS n FROM schools GROUP BY status ORDER BY COUNT(*) DESC`;
      console.log(`Transport: ${transportFor(s)}   Sent today: ${await sentToday()}/${s.maxSendsPerDay}\n`);

      const state = readiness(s);
      for (const b of state.blockers) console.log(`BLOCKED: ${b}`);
      for (const w of state.warnings) console.log(`note: ${w}`);
      console.log('');

      if (rows.length === 0) console.log('Pipeline is empty. Run: npm run agent -- discover 10');
      for (const r of rows) console.log(`${r.status.padEnd(14)} ${r.n}`);

      const due = await sql()<SchoolRow[]>`
        SELECT * FROM schools
        WHERE status IN ('sequenced', 'contacted', 'followup_1')
          AND (next_action_at IS NULL OR next_action_at <= now())
        LIMIT 10`;
      if (due.length) {
        console.log('\nDue now:');
        for (const d of due) console.log(`  #${d.id} ${d.name} (${d.status})`);
      }
      break;
    }
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
