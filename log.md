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
