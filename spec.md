# Eduwalls AutoGTM — Specification

**Status:** v1 built, unverified against a live Gemini key
**Owner:** Joy Adeniran, CEO, Eduwalls Africa Ltd
**Last updated:** 2026-09-15

This document is the source of truth for what this system is and is not. Code
that contradicts this file is a bug in one of the two. Resolve it before
building on top of it.

---

## 1. What this is

An autonomous SDR agent for Eduwalls Africa. It runs the Lagos private school
outreach pipeline end to end without a human in the loop for each step:

> find schools → research them → score them → write the emails → send → follow up → stop on reply

It is Joy's internal ops tool. It is not a product, not multi-user, and has no
auth. Do not add auth, tenancy, or user accounts without an explicit decision
recorded in `log.md`.

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

Proof points available for copy: BOVIC renewal after Term 1; AI Literacy and
Google Workspace teacher training at Christ The Redeemer's School, Oworonshoki;
NAPPS membership; #TheFutureIsPracticed.

## 3. Dependencies

**Required:** `GEMINI_API_KEY`. Nothing else. With only this key the agent
prospects, researches, qualifies and drafts. It just does not deliver.

**Optional, each degrades gracefully when absent:**

| Integration | Absent behaviour |
| --- | --- |
| Brevo or SMTP | Transport falls back to `dry-run`, sends are recorded but not delivered |
| IMAP | No reply detection; replies must be marked by hand or sequences keep running |
| HubSpot | No CRM mirroring; a CRM failure never blocks or repeats a send |

## 4. The loop

One tick, default every 300s, never overlapping. Order matters.

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

## 7. Data

One SQLite file at `DB_PATH`. Backing up that file backs up the pipeline.

- `schools` — the lead and its whole state. `research_json` holds the brief plus
  the nested `qualification`. `sequence_json` holds the drafted emails.
- `emails` — one row per step, unique on `(school_id, step)`. `sent_at` drives
  the daily cap.
- `events` — append-only audit trail. Every decision the agent makes lands here.
- `kv` — small runtime state, currently the IMAP high water mark.

## 8. Layout

```
src/config.ts          env, defaults, transport selection
src/db.ts              schema, migrations, lead helpers
src/gemini.ts          grounded search + structured JSON, retry on 429/5xx
src/brand.ts           voice and business constraints (N1-N4)
src/engine.ts          the loop, the state machine, failure backoff
src/server.ts          HTTP API
src/cli.ts             operator commands
src/crm.ts             HubSpot, best effort
src/pipeline/          research, qualify, compose, send, replies
public/index.html      dashboard
```

## 9. Verified vs unverified

Honesty here prevents a future session trusting something untested.

**Verified** (dummy key, dry run): state machine transitions across all three
steps; daily cap and send window enforcement; graceful degradation when Gemini
rejects the key; all HTTP endpoints; typecheck and build.

**Unverified:** research quality, qualification calibration, email copy quality,
Brevo delivery, SMTP delivery, IMAP polling and reply matching, HubSpot writes.
All of these need a live key or live credentials. Until each is exercised, say
so rather than implying it works.

## 10. Out of scope for v1

Batch CSV import, deal stage auto-progression beyond first contact, Brevo
sequence enrollment, CSV export, multi-user auth, a tutor-facing surface,
anything parent-facing (permanently, see N1).
