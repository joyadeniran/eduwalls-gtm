# Eduwalls AutoGTM — Specification

**Status:** v2, deployed to Vercel. Unverified against a live Gemini key.
**Owner:** Joy Adeniran, CEO, Eduwalls Africa Ltd
**Last updated:** 2026-09-16

This document is the source of truth for what this system is and is not. Code
that contradicts this file is a bug in one of the two. Resolve it before
building on top of it.

---

## 1. What this is

An autonomous SDR agent for Eduwalls Africa. It runs the Lagos private school
outreach pipeline end to end without a human in the loop for each step:

> find schools → research them → score them → write the emails → send → follow up → stop on reply

It is Joy's internal ops tool. It is not a product and not multi-user. It is
deployed on the public internet, so it sits behind a single shared password
(`DASHBOARD_PASSWORD`). That is a deployment necessity, not a user system. Do
not add tenancy or per-user accounts without a decision recorded in `log.md`.

## 2. Non-negotiables

These are commercial constraints from the business, not preferences. They
outrank convenience, model output, and anything a future prompt suggests.

| # | Rule | Where enforced |
| --- | --- | --- |
| N1 | **The school is the customer.** Never parent-facing features, parent pricing, or parent portals. No parent email fields, ever. | `src/brand.ts` |
| N2 | **Never quote exact prices** in outreach. Invite a conversation. | `src/brand.ts` |
| N3 | **No em dashes** anywhere in generated copy. | `src/brand.ts`, stripped post-generation |
| N4 | **Nigerian English.** Not American, not British. Warm, direct, never salesy. | `src/brand.ts` |
| N5 | **Never state an unverified fact** about a school, and never construct a contact address from a school name or domain. A guess in a cold email costs the meeting. | `src/pipeline/research.ts` |
| N6 | **Nothing sends by accident.** Dry run is the default and every send passes a cap, a window and a score gate. | `src/config.ts`, `src/pipeline/send.ts` |
| N7 | **A school that replied never gets a follow up.** | `src/pipeline/replies.ts` |
| N8 | Tutors are independent contractors. If tutor management is ever added, never structure pay as a monthly salary. | not yet applicable |
| N9 | **The deployment is never open.** In production the server refuses to serve at all without `DASHBOARD_PASSWORD`, and the cron endpoint requires `CRON_SECRET`. Never serve the dashboard from a static directory, which would bypass the gate. | `src/server.ts` |

Proof points available for copy: BOVIC renewal after Term 1; AI Literacy and
Google Workspace teacher training at Christ The Redeemer's School, Oworonshoki;
NAPPS membership; #TheFutureIsPracticed.

## 3. Dependencies

**Required at deploy time:** `DATABASE_URL` (Postgres), `DASHBOARD_PASSWORD`,
`CRON_SECRET`. Recommended: `APP_SECRET`, which encrypts saved credentials at
rest. Without it they sit in the database as plain text.

**Required to do anything useful:** a Gemini API key. It can be set as
`GEMINI_API_KEY` or saved in the dashboard. With only that key the agent
prospects, researches, qualifies and drafts. It just does not deliver.

**Everything else is configured in the dashboard**, not in env vars. Sender
details, Brevo or SMTP, the IMAP mailbox, the HubSpot token and every guard rail
resolve in this order: **settings table, then environment, then default.**
Secrets are encrypted with `APP_SECRET`, masked in the API, and never returned
to the browser.

**Optional, each degrades gracefully when absent:**

| Integration | Absent behaviour |
| --- | --- |
| Brevo or SMTP | Transport falls back to `dry-run`, sends are recorded but not delivered |
| IMAP | No reply detection; replies must be marked by hand or sequences keep running |
| HubSpot | No CRM mirroring; a CRM failure never blocks or repeats a send |

## 4. The loop

One tick, never overlapping. A Postgres lock (`engine_lock`) makes that true
across processes, not just within one, because two cron invocations can
otherwise overlap and double send. Order matters.

1. **Read replies.** IMAP poll. Matches by exact address, then by non-freemail
   domain. Triages intent. A real reply stops the sequence. An out of office
   does not.
2. **Prospect.** If open leads (`discovered` + `researched` + `sequenced`) are
   below `DISCOVER_TARGET_BACKLOG`, search a rotating Lagos area for private
   K-12 schools and add the new ones.
3. **Research.** Grounded search per lead, then structured extraction. Fee tier,
   curriculum, size, existing enrichment, recent news, published contact.
4. **Qualify.** Score 0-100 against the ICP in `src/pipeline/qualify.ts`. Below
   `MIN_SCORE_TO_CONTACT`, disqualify with a written reason.
5. **Draft.** All three emails in one call, so follow ups build rather than repeat.
6. **Send.** What is due, in order of urgency, inside the window, under the cap.

Steps 3-6 are capped per tick. Failures are per lead and never abort the tick.

## 5. State machine

```
discovered → researching → researched ─┬→ disqualified          (score gate)
                                       └→ sequenced
sequenced  --send 1--> contacted   (+5d)  [+ HubSpot Company/Deal/Note]
contacted  --send 2--> followup_1  (+5d)
followup_1 --send 3--> exhausted
any of the above --reply--> replied | meeting_booked | declined
any of the above --3 failures--> error
```

- `next_action_at` is the only scheduler. Null means "not due, waiting on something".
- A lead with no contact address reaches `sequenced` and holds there with
  `last_error = "Awaiting a contact email address"` until one is supplied.
- Supplying that address via `PATCH /api/schools/:id` unblocks the send on the next tick.
- Three consecutive failures on a lead move it to `error` and stop spending quota on it.

## 6. Guard rails

| Setting | Default | Purpose |
| --- | --- | --- |
| `LIVE_SEND` | `false` | Nothing is delivered until explicitly enabled |
| `MAX_SENDS_PER_DAY` | 25 | Hard ceiling, counted from `emails.sent_at` |
| `MAX_SENDS_PER_TICK` | 5 | Stops a burst if the funnel floods |
| `MAX_RESEARCH_PER_TICK` | 3 | Caps Gemini spend per tick |
| `MIN_SCORE_TO_CONTACT` | 60 | Weak fits are never emailed |
| `SEND_WINDOW_*` | 08:00-17:00 WAT, Mon-Fri | No 3am email to a proprietor |
| `AUTO_DISCOVER` | `true` | False to work only from Joy's own list |

Loosening any of these is a decision, not a tweak. Record it in `log.md`.

## 6a. Deployment

Runs in two modes from one codebase:

- **Serverless (Vercel, current).** `api/index.js` wraps the Fastify app; all
  routes rewrite to it. The engine is driven by `POST /api/cron`, guarded by
  `CRON_SECRET`. Because Vercel Hobby allows only one cron per day, that
  endpoint runs ticks back to back until the work runs out or it approaches its
  time budget, rather than one pass per day. Any external scheduler can call the
  same URL more often.
- **Long running (any Node host).** `npm start` runs the same app with an
  in-process timer on `engineTickSeconds`.

## 7. Data

Postgres, via `DATABASE_URL`. Any provider works; the schema is created lazily
on first request, so there is no migration step to run.

- `schools` — the lead and its whole state. `research_json` holds the brief plus
  the nested `qualification`. `sequence_json` holds the drafted emails.
- `emails` — one row per step, unique on `(school_id, step)`. `sent_at` drives
  the daily cap.
- `events` — append-only audit trail. Every decision the agent makes lands here.
- `kv` — small runtime state, currently the IMAP high water mark.
- `settings` — operator-editable configuration. Secrets encrypted at rest.
- `engine_lock` — the single-row cross-process lock that prevents double sends.

## 8. Layout

```
src/config.ts          boot-time env only
src/settings.ts        runtime settings: table over env over default
src/crypto.ts          secret encryption, password comparison
src/db.ts              Postgres schema, lead helpers, engine lock
src/dashboard.ts       the dashboard, inlined so auth cannot be bypassed
src/gemini.ts          grounded search + structured JSON, retry on 429/5xx
src/brand.ts           voice and business constraints (N1-N4)
src/engine.ts          the loop, the state machine, failure backoff
src/server.ts          HTTP API
src/cli.ts             operator commands
src/crm.ts             HubSpot, best effort
src/pipeline/          research, qualify, compose, send, replies
api/index.js           Vercel serverless entry
vercel.json            rewrites, function limits, cron schedule
```

## 9. Verified vs unverified

Honesty here prevents a future session trusting something untested.

**Verified** against a real Postgres 16, in dry run with a dummy Gemini key:
state machine transitions across all three steps; daily cap and send window
enforcement; the auth gate (401 on the API, redirect on the page, wrong password
rejected); settings round trip; secrets encrypted at rest and masked in the API;
a masked value not overwriting a stored secret; the cron endpoint rejecting an
unauthenticated call; the engine lock rejecting a second concurrent run;
graceful degradation when Gemini rejects the key; typecheck and build.

**Unverified:** research quality, qualification calibration, email copy quality,
Brevo delivery, SMTP delivery, IMAP polling and reply matching, HubSpot writes,
and the Vercel cron firing on schedule. All need live credentials or elapsed
time. Until each is exercised, say so rather than implying it works.

## 10. Out of scope for v1

Batch CSV import, deal stage auto-progression beyond first contact, Brevo
sequence enrollment, CSV export, multi-user auth, a tutor-facing surface,
anything parent-facing (permanently, see N1).
