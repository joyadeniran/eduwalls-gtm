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
