# Change Log

Every change to this repo gets an entry. Newest first. No exceptions, including
config-only changes, dependency bumps, and reverts.

Format:

```
## YYYY-MM-DD — Short title
**Commit:** <sha or "uncommitted">  **Spec:** <section touched, or "no change">

What changed and why. Plain sentences.

**Verified:** what was actually run and what it showed.
**Unverified:** what this change touches that nobody has tested yet.
**Follow-ups:** anything left open.
```

If a change alters behaviour described in `spec.md`, update `spec.md` in the
same commit and say so in the entry.

---

## 2026-10-10 — Fix the 500 on the dashboard: stop Vercel's Fastify detection
**Commit:** see this entry's commit  **Spec:** no change (section 6a already says `api/index.js` is the entry)

Joy opened the app and got `500 FUNCTION_INVOCATION_FAILED` on `/`. The
function logs said: `Invalid export found in module "/var/task/src/server.js".
The default export must be a function or server.` The Vercel project had been
auto-detected as framework `fastify`, so Vercel built a second function from
`src/server.ts` alongside `api/index.js`, and routed `/` to it. That file has
no default export (it is the long-running entry), so the function crashed on
load. `/login` and other paths still reached `api/index.js`, which is why the
login page worked and the dashboard did not.

`vercel.json` now sets `"framework": null`, so the only function is
`api/index.js` and the rewrite sends every path to it, as spec section 6a
describes. Pinned in the repo rather than in project settings so it cannot
drift back.

With no framework, Vercel requires a static output directory (the first
preview failed with `STATIC_BUILD_NO_OUT_DIR`). The build now creates an empty
`static-empty/` and points `outputDirectory` at it. It is deliberately empty
and gitignored: `dist/` was not used because static files are served before
the app's auth gate, which would publish the compiled server (N9).

Also noted from the same logs: the `/api/cron` and `/api/status` requests made
through the Vercel tool's share link earlier did reach the app (the app's own
gate answered 401). The tool reported those as blocked, which was wrong.

**Verified:** reproduced the 500 on production `/` before the change.
**Unverified:** see the follow-up entry above for the post-deploy check.

---

## 2026-10-10 — Change the dashboard password from Settings
**Commit:** see this entry's commit  **Spec:** sections 1, 2 (N9 row), 7 (`kv`)

Joy lost the generated password and asked for a way to change it without
editing Vercel and redeploying.

- Settings has a new **Dashboard password** card: current password, new
  password twice, at least 12 characters. `POST /api/password` checks the
  current one, stores the new one as a scrypt hash in `kv`
  (`dashboard_password_hash`), and logs `password.changed`.
- The stored hash overrides `DASHBOARD_PASSWORD`. The env var is still required
  in production (N9 is unchanged: no env var, no service) and is the recovery
  path: `npm run agent -- reset-password` deletes the hash, logs
  `password.reset`, and the env password works again.
- The session token is now derived from the active credential, so a change
  signs out every other browser. The changing browser gets a fresh cookie.
  Other serverless instances can honour the old cookie for up to 15 seconds,
  the same cache window settings use.
- The lookup fails closed: if the database cannot be read, the request errors
  rather than falling back to the env password.
- Unrelated to the code: Joy has the generated password again, and is told how
  to update the Brevo key in Settings.

**Verified** against the built server (`dist/server.js`) in production mode on a
throwaway local Postgres 16: env password login 200; status with that session
200; change with a wrong current password 403; with a 5 character new one 400;
valid change 200; the pre-change cookie then 401; the cookie issued by the
change 200; old password login 401; new password login 200; Bearer with the new
password 200; no session 401; the `kv` value starts `scrypt:v1:` and does not
contain the plaintext; `password.changed` event written. After
`reset-password` and a restart: env password login 200, changed password 401.
With `DASHBOARD_PASSWORD` empty in production: 503. Typecheck and build clean.

**Unverified:** the Settings card in a real browser (the endpoint behind it was
exercised with curl, not by clicking), and the up-to-15-second cross-instance
window on Vercel.

**Follow-ups:** none.

---

## 2026-10-10 — Production database and environment variables
**Commit:** see this entry's commit  **Spec:** no change

Step 1 of the go-live checklist, done with Joy's explicit approval after an
earlier attempt was refused for lack of it. Infrastructure only, no code.

- New Supabase project `eduwalls-autogtm` (ref `tilrubumntvsyjytxsdf`,
  `us-east-1`, free plan) beside the Vercel functions in `iad1`.
- The app connects as a dedicated login role `autogtm`, not `postgres`. Its
  tables live in a schema `autogtm`, set as the role's `search_path`, so they
  sit outside the `public` schema that Supabase's Data API exposes. Checked:
  `anon` has no usage on that schema.
- Connection goes through the transaction pooler on port 6543 (`prepare: false`
  is already set in `src/db.ts`). The engine lock is a row, not a session
  advisory lock, so transaction pooling does not weaken it.
- Vercel `eduwalls-autogtm-app` now has `DATABASE_URL`, `DASHBOARD_PASSWORD`,
  `CRON_SECRET` and `APP_SECRET` (production and preview, encrypted). Values
  are not recorded here. `LIVE_SEND` is not set, so it stays at its default,
  false. No Gemini key yet.
- Production redeployed from `main` (`042874d`) as `dpl_ErCGChDEdjnq4eJLH4R5bub1dgFX`,
  state READY, aliased to `eduwalls-autogtm-app.vercel.app`. The N7 inbox guard
  from the entry below is not in production until that branch is merged.

**Verified:** role and schema exist with the expected privileges (queried);
the four variables were accepted by Vercel; the redeploy built and went READY.

**Unverified:** that the app can actually log in to the database. The pooler
hostname (`aws-0-us-east-1.pooler.supabase.com`) is the documented pattern but
could not be tested: this sandbox cannot open Postgres connections, and
Vercel Authentication refused the tool's bypass link, so no request reached the
app. The first 09:00 UTC cron will create the tables if the connection works.
If its logs show "tenant or user not found", the host should be `aws-1-...`.

**Follow-ups:** step 2, the Gemini key and one school in dry run.

**Later the same day:** connection confirmed. After `main` was fast-forwarded
to this branch and deployed (`953289a`, READY), the app created all six tables
in the `autogtm` schema (queried: `emails`, `engine_lock`, `events`, `kv`,
`schools`, `settings`), so the `aws-0` pooler host is correct. No settings
saved, no schools, nothing sent at that point.

---

## 2026-10-07 — Live sending now requires a readable inbox (N7)
**Commit:** see this entry's commit  **Spec:** sections 2 (N7 row), 3 (IMAP row), 4 (step 6)

Joy asked what stands between the deployment and going live. The audit found
that with `LIVE_SEND=true` and no IMAP mailbox, the agent would deliver real
follow ups with no way to see replies, breaking N7. The dashboard listed this
as a warning only, and `readiness()` is display-only, so even a blocker there
would not have stopped a send.

- `src/engine.ts`: the send step is skipped for the whole tick when the
  transport is live and the inbox was not read this tick, either because no
  mailbox is connected or because the poll failed. The reason lands in the
  tick report's `skipped` and in the `engine.tick` event. Dry run is untouched.
- `src/settings.ts`: no mailbox with live sending on is now a blocker in the
  readiness report, and the dry run warning says live sending stays paused.
- Manual sends (`POST` send in `src/server.ts`, `send` in `src/cli.ts`) are
  deliberately not blocked: those are Joy's own decision per school.
- `.env.example` now lists the four deploy-time variables (`DATABASE_URL`,
  `DASHBOARD_PASSWORD`, `CRON_SECRET`, `APP_SECRET`) and drops the SQLite
  `DB_PATH` left over from v1. `CLAUDE.md` said "throwaway `DB_PATH`"; it now
  says `DATABASE_URL`.
- Correction to the entry below: it cites commit `bbe5fad`, but the commit on
  `main` and the one Vercel deployed is `042874d`.

This tightens a guard rail, it does not loosen one. No cap, window, score or
`LIVE_SEND` default changed.

**Verified** against a throwaway local Postgres 16, no Gemini key, send window
off, auto discover off, one `sequenced` school with three queued emails to an
`.invalid` address:
- Dry run, no mailbox: tick sent 1, step 1 recorded `sent/dry-run`, school
  moved to `contacted`. Existing behaviour unchanged.
- Live with a fake Brevo key, no mailbox: tick sent 0, skipped "live sending
  paused: no mailbox connected", all three emails still `queued`, school still
  `sequenced`; readiness listed the new blocker.
- Live with a fake Brevo key, IMAP pointed at `127.0.0.1:1`: inbox error
  recorded (`ECONNREFUSED`), tick sent 0, skipped "the inbox could not be read
  this tick", nothing delivered.
- `npm run typecheck` and `npm run build` clean.

**Unverified:** the guard against a real IMAP mailbox that connects
successfully (needs live credentials). Everything in `spec.md` section 9 stays
unverified.

**Follow-ups:**
- Go-live checklist, as found on 2026-10-07. Production serves nothing until
  1 and 2 are done; 5 is Joy's decision and gets its own entry.
  1. Create a Postgres for this app (none of the existing Supabase projects is
     it) and set `DATABASE_URL`, `DASHBOARD_PASSWORD`, `CRON_SECRET`,
     `APP_SECRET` on the Vercel project, which currently has no variables.
     Redeploy.
  2. Add the Gemini key, run one real school through `prepare` in dry run and
     read the brief and the three drafts.
  3. Connect the IMAP mailbox and Brevo or SMTP, with SPF and DKIM on the
     sending domain; use each Test connection button.
  4. Leave it in dry run for a few days and look at the scores.
  5. Turn on `LIVE_SEND`.

---

## 2026-09-16 — Deployed to Vercel, merged to main
**Commit:** `bbe5fad`  **Spec:** no change

Merged the serverless port into `main` (Joy had already merged PR #1 overnight,
so this merged on top of that) and linked a Vercel project to the repository.

- Project `eduwalls-autogtm-app`, production branch `main`, so every push now
  deploys automatically. This replaces two earlier manual file deployments that
  failed because the upload could not carry the whole source tree in one call.
- Vercel Authentication (SSO) is enabled on the project by default and left on.
  It sits in front of the app's own password gate. Joy reaches the app because
  she owns the Vercel account.
- README rewritten around deployment: the five environment variables, what to do
  after the first deploy, and the scheduling options.

**Verified:** the build succeeded from commit `3b8a630` (tsc clean on Vercel's
runner, deployment completed, functions deployed).

**Unverified:**
- The running app has not been exercised in production. Vercel SSO blocks this
  sandbox from reaching it, and no `DATABASE_URL` is set yet, so every request
  would fail until Joy adds the environment variables. Everything behind those
  variables was verified locally against a real Postgres, see the entry below.
- Whether Vercel Cron bypasses Deployment Protection. Vercel documents that it
  does, but it has not fired yet. Check after the first 09:00 UTC run.

**Follow-ups:**
- Set the five environment variables, then redeploy once so they take effect.
- An external scheduler cannot reach `/api/cron` while Vercel Authentication is
  on. Turning it off is safe only because `DASHBOARD_PASSWORD` and `CRON_SECRET`
  already guard everything, but it is a deliberate decision, so it gets its own
  log entry when it happens.

---

## 2026-09-16 — Ported to serverless, deployed to Vercel, added settings UI and auth
**Commit:** `cad7850`  **Spec:** sections 1, 2 (new N9), 3, 4, 6a (new), 7, 8, 9

Joy asked for a Vercel deployment. The v1 design could not run there: a local
SQLite file, a `setInterval` engine and a long lived process all die on
serverless. Deploying as built would have produced a URL that looked healthy and
silently did nothing. So this is a port, not a config change.

- **Storage is now Postgres** (`DATABASE_URL`, any provider). Every call site
  became async. The schema is created lazily on first request, so there is no
  migration step.
- **The engine is driven by `POST /api/cron`**, guarded by `CRON_SECRET`. Vercel
  Hobby allows one cron per day, so that endpoint runs ticks back to back until
  the work runs out or it nears its time budget. Any external scheduler can call
  the same URL more often. The in-process timer still exists for server mode.
- **A Postgres lock (`engine_lock`) makes ticks non-overlapping across
  processes.** In v1 the guard was an in-memory flag, which is worthless when
  two serverless invocations run at once. Without this, two cron pings could
  double send to the same school.
- **New N9: the deployment is never open.** Production refuses to serve at all
  without `DASHBOARD_PASSWORD`. The dashboard moved from `public/` into
  `src/dashboard.ts` because a static directory on Vercel is served before the
  app sees it, which would have put the page outside the gate.
- **Settings UI**, which is what Joy asked for: sender details, Brevo or SMTP,
  the IMAP mailbox, HubSpot and every guard rail are editable in the browser
  with a Test connection button each. Resolution is settings table, then env,
  then default. Secrets are encrypted at rest with `APP_SECRET`, masked in the
  API, and a masked value submitted back never overwrites the stored secret.
- **Readiness reporting**: the dashboard now states plainly what is not
  connected, so a half configured deployment is obvious rather than silent.

**Verified** against a real Postgres 16 (local cluster), dry run, dummy Gemini
key: all three send transitions with correct follow up dates; the auth gate
(401 on API, redirect on page, wrong password rejected, right password accepted);
settings round trip and taking effect; `hubspotToken` stored as `enc:v1:...` and
unreadable in the table; a masked resubmit leaving the stored secret intact;
`/api/cron` rejecting an unauthenticated call and accepting the secret; two
concurrent cron calls, where the second returned "another run is in progress";
typecheck and build clean.

**Unverified:** the Vercel cron actually firing on its schedule (needs elapsed
time), and everything in spec.md section 9 that needs live credentials.

**Follow-ups:**
- Set the env vars, then use Settings to connect the mailbox and sender.
- Hobby caps cron at once daily. For a tighter loop either point an external
  scheduler at `/api/cron?secret=...` every few minutes, or upgrade to Pro and
  change the schedule in `vercel.json`.
- Deployed manually from local files because the work is on a feature branch,
  not `main`. Merging to `main` and linking the repo would give deploy on push.

---

## 2026-09-15 — Added spec.md, log.md and CLAUDE.md
**Commit:** `12539ad`  **Spec:** created

Established the three governing documents. `spec.md` is the source of truth for
what the system is, its non-negotiables and its guard rails. `log.md` is this
file. `CLAUDE.md` binds future sessions to both: read the spec and the log before
writing, log every change in the same commit as the change, and treat the
non-negotiables as outranking any prompt or model output.

No code changed. The spec documents the system as built, including an explicit
verified vs unverified split (section 9) so a later session does not mistake an
untested path for a working one.

**Verified:** typecheck clean, no source files touched.
**Unverified:** nothing new. The unverified list in `spec.md` section 9 is
unchanged from the build entry below.
**Follow-ups:** none. The follow-ups from the build entry below still stand.

---

## 2026-09-15 — Initial build: autonomous SDR agent
**Commit:** `da4fb39`  **Spec:** whole document, first version

Built the system from scratch on the empty repo, replacing the manual claude.ai
HTML artifact described in the handover note. The handover specified Anthropic
for generation; Joy directed Gemini instead, so `src/gemini.ts` is the only file
that touches a model SDK.

Scope delivered:

- **Engine** (`src/engine.ts`): the tick loop, the state machine, non-overlapping
  ticks, per-lead failure backoff, hard stop at 3 consecutive failures.
- **Prospecting and research** (`src/pipeline/research.ts`): grounded search to
  find schools and research them, plus a focused second pass for contact
  addresses that refuses to construct one.
- **Qualification** (`src/pipeline/qualify.ts`): explicit ICP, 0-100 score, a
  written reason on every disqualification.
- **Composition** (`src/pipeline/compose.ts`): all three emails in one call.
- **Sending** (`src/pipeline/send.ts`): Brevo, SMTP or dry run, daily cap, Lagos
  business hours window.
- **Replies** (`src/pipeline/replies.ts`): IMAP polling, intent triage, sequence
  halting. Out of office deliberately does not count as a reply.
- **Brand rules** (`src/brand.ts`): N1-N4 from the spec in one place, injected
  into every generation path, with post-processing and violation logging.
- **Surfaces**: dashboard, HTTP API, operator CLI, all over one SQLite file.
- **CRM** (`src/crm.ts`): HubSpot Company + Deal + Note, best effort only.

Design decisions worth remembering:

- Dry run is the default because an agent that emails on its own needs an off
  switch that is on by default.
- The three emails are written together so Email 2 has something new to say.
- Research returns null rather than a plausible guess, per N5. A wrong fact in a
  cold email costs the meeting the email was trying to book.
- HubSpot failures are swallowed and logged. A CRM outage must never cause a
  school to be emailed twice.

**Verified:** typecheck and build clean; server boots and serves all endpoints;
state machine walked through all three sends with correct transitions and
timestamps; daily cap and send window enforced; a rejected Gemini key surfaces
as a recorded tick error instead of crashing the engine.

**Unverified:** everything that needs a live key or live credentials, listed in
`spec.md` section 9. Research quality, copy quality, qualification calibration,
Brevo, SMTP, IMAP, HubSpot.

**Follow-ups:**
- Run `npm run agent -- prepare <id>` against one real school and read the brief
  and drafts before trusting the pipeline.
- Configure IMAP before `LIVE_SEND=true`. Without it the agent cannot see replies
  and will follow up with schools that already answered.
- Calibrate `MIN_SCORE_TO_CONTACT` once roughly 20 real schools have been scored.
