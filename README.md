# Eduwalls AutoGTM

An autonomous SDR agent for Eduwalls Africa. It finds Lagos private schools,
researches them against live web sources, scores them against the ICP, writes a
3-email outreach sequence in Joy's voice, sends email 1, and follows up on day 5
and day 10 unless the school replies.

One API key runs the thinking: **Gemini**. Sending, reply detection and CRM
logging are configured in the dashboard, and each one degrades rather than
breaks when it is missing.

## The loop

Every tick (5 minutes by default) the engine does this, in order:

1. **Read replies.** Polls the inbox over IMAP. A reply from a real person stops
   that school's sequence immediately. An out of office does not.
2. **Prospect.** When the funnel drops below 20 open leads, it searches for
   private schools in a Lagos area it has not worked recently and adds new ones.
3. **Research.** Grounded Google Search on each new lead: size, fee tier,
   curriculum, existing enrichment, recent news, published contact address.
   Anything it cannot verify stays blank rather than being guessed.
4. **Qualify.** Scores the brief 0-100 against the ICP. Below `MIN_SCORE_TO_CONTACT`
   the lead is disqualified with a written reason and never emailed.
5. **Draft.** Writes all three emails at once, so the follow ups build on email 1
   instead of repeating it.
6. **Send.** Delivers what is due, inside Lagos business hours, under the daily
   cap. Email 1 also creates the HubSpot Company, Deal and Note.

## Deployed on Vercel

Project: `eduwalls-autogtm-app`, linked to this repo. Every push to `main`
deploys automatically.

### Environment variables (set these in Vercel, then redeploy)

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Supabase, Neon, or any Postgres. Nothing works without it. |
| `DASHBOARD_PASSWORD` | yes | Guards the dashboard and the API. In production the server refuses to serve at all without it. |
| `CRON_SECRET` | yes | Guards `/api/cron`. Vercel Cron sends it automatically as a bearer token. |
| `APP_SECRET` | strongly recommended | Encrypts saved credentials at rest. Without it, keys you save in Settings sit in your database as plain text. |
| `GEMINI_API_KEY` | optional here | Can be set here or saved in Settings instead. |

Everything else is configured in the dashboard, not here.

### After the first deploy

1. Open the app and sign in with `DASHBOARD_PASSWORD`.
2. Go to **Settings** and fill in the Gemini key, the sender details, the IMAP
   mailbox and, if you want it, HubSpot. Each section has a **Test connection**
   button. Use them.
3. Leave **Live sending** off until you have read a few generated sequences.
4. Add a school, press **Research and draft**, and read what it writes.

### Scheduling

The Vercel Hobby plan allows one cron run per day, so `vercel.json` schedules
`/api/cron` at 09:00 UTC (10:00 WAT). One invocation runs cycles back to back
until the work runs out or it approaches its time limit, so a daily run still
moves the pipeline.

For a tighter loop, either:

- point any external scheduler at `https://<your-app>/api/cron?secret=<CRON_SECRET>`
  every few minutes, which needs Vercel Authentication turned off for the
  project so the request can reach the app, or
- upgrade to Pro and change the schedule in `vercel.json` to `*/10 * * * *`.

## Running it as a normal server instead

The same code runs as a long lived process with an in-process timer, no cron
needed:

```bash
npm install
cp .env.example .env     # add DATABASE_URL and GEMINI_API_KEY
npm run dev              # dashboard on http://localhost:3000
npm run build && npm start
```

Locally, without `DASHBOARD_PASSWORD`, the app is open so you are not fighting a
login on your own machine. In production it refuses to start unprotected.

## Guard rails

These exist because cold outreach that runs hot gets a domain blacklisted.

| Setting | Default | What it does |
| --- | --- | --- |
| `LIVE_SEND` | `false` | Nothing is delivered until you turn this on |
| `MAX_SENDS_PER_DAY` | `25` | Hard daily ceiling across all schools |
| `MAX_SENDS_PER_TICK` | `5` | Stops a burst if the funnel floods |
| `MIN_SCORE_TO_CONTACT` | `60` | Weak fits are never emailed |
| `SEND_WINDOW_*` | 8am-5pm WAT, Mon-Fri | No 3am emails to a proprietor |
| `AUTO_DISCOVER` | `true` | Set false to work only from your own list |

A school with no verified contact address is drafted but held, and shown in the
dashboard with "Awaiting a contact email address". Fill it in and it sends on the
next tick. The agent never invents an address from a school name.

## Reply handling

With IMAP configured the agent matches inbound mail to a school by address (or by
domain, for non-freemail domains), triages the intent, and stops the sequence.
A meeting request moves the school to `meeting_booked`, a clear no to `declined`.

Without IMAP, mark replies yourself in the dashboard or via
`POST /api/schools/:id/reply`. If you skip both, the agent will keep following up
with schools that already answered.

## CLI

```bash
npm run agent -- status                              # pipeline at a glance
npm run agent -- discover 10                         # find new schools now
npm run agent -- add "Greensprings School" --area Lekki --email info@school.com
npm run agent -- prepare 3                           # research, qualify, draft school #3
npm run agent -- show 3                              # read the briefs and emails
npm run agent -- send 3                              # send the next due step
npm run agent -- tick                                # one full engine cycle
npm run agent -- health                              # check the Gemini key
```

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Engine, transport, quota, pipeline counts |
| GET | `/api/schools` | List, optional `?status=contacted` |
| GET | `/api/schools/:id` | School with its emails and event history |
| POST | `/api/schools` | Add one (`name`) or many (`names: []`) |
| PATCH | `/api/schools/:id` | Edit contact details or force a status |
| POST | `/api/schools/:id/prepare` | Research, qualify and draft now |
| POST | `/api/schools/:id/send-next` | Send the next due step now |
| POST | `/api/schools/:id/reply` | Record a reply and triage it |
| POST | `/api/discover` | Prospect for new schools |
| POST | `/api/engine/tick` | Run one cycle |
| POST | `/api/engine` | `{"on": false}` to pause the loop |

## Voice rules

`src/brand.ts` holds the Eduwalls constraints. These are commercial rules, not
style preferences, and every generation path includes them:

- The school is the customer. Never parents, parent pricing, or parent portals.
- Never quote exact prices. Invite a conversation.
- No em dashes. Nigerian English. Warm and direct, never salesy.
- Never state a fact about a school that research did not verify.

Drafts are post-processed to strip em dashes, and flagged in the event log if the
model breaks one of the other rules. Change the rules in one place and every
email follows.

## Layout

```
src/
  config.ts            env, defaults, transport selection
  db.ts                SQLite schema, leads, emails, events
  gemini.ts            grounded search + structured JSON, with retries
  brand.ts             Eduwalls voice and business constraints
  engine.ts            the autonomous loop and state machine
  server.ts            HTTP API
  cli.ts               operator commands
  crm.ts               HubSpot Company + Deal + Note
  settings.ts          runtime settings: table over env over default
  crypto.ts            secret encryption, constant-time password compare
  dashboard.ts         the dashboard, inlined so auth cannot be bypassed
  pipeline/
    research.ts        prospecting, school research, contact finding
    qualify.ts         ICP scoring
    compose.ts         the 3-email sequence
    send.ts            Brevo / SMTP / dry run, cap and window
    replies.ts         IMAP polling and reply triage
api/index.js           Vercel serverless entry
```

State lives in Postgres. The schema is created on first request, so there is no
migration step to run.
