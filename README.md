# gas-gmail-triage

Google Apps Script project that runs on a Gmail account and does two things on a shared 15-minute trigger:

1. **Alias labeler** — detects which alias or custom domain a thread was addressed to and files it under a matching Gmail label hierarchy.
2. **Booking scanner** — detects travel/accommodation/event/appointment confirmation emails and creates Google Calendar events automatically.

Both features are independent and can be toggled off in `Config.js` without touching any other file.

---

## File map

| File | Purpose |
|---|---|
| `Config.js` | **Start here.** Feature flags, core booking scanner settings, `setupConfig()`, `installTrigger()`. |
| `Code.js` | Entry point. Owns thread fetching, `_ckd` processing gate, and feature-flag guards. |
| `src/AliasLabeler.js` | Alias-labeling logic. Exported as `labelAliasThread(thread)`. |
| `src/BookingScanner.js` | Entry points, main pipeline, eligibility filter. Exported as `processBookings(thread)`, `runBookingScanner()`, `processThread()`. |
| `src/BookingParsers.js` | The 3 detection layers: schema.org, ICS, AI extraction. |
| `src/BookingCalendar.js` | Calendar event create/upgrade/enrich/dedup, Drive ticket attachments. |
| `src/BookingUtils.js` | HTML/date/timezone/ICS low-level parsing, connecting-leg detection. |
| `src/BookingDetectionRules.js` | Word lists, sender/subject exclusions, emoji rules, active categories — rarely edited. |
| `appsscript.json` | GAS manifest — timezone, Calendar advanced service, V8 runtime. |

---

## How it works

### Shared trigger flow (`Code.js`)

Every 15 minutes `runAll()`:
1. Fetches threads from the last hour that don't carry the `_ckd` label.
2. Passes each thread to `processBookings()` if `FEATURES.bookingScanner` is true.
3. Passes it to `labelAliasThread()` if `FEATURES.aliasLabeler` is true.
4. Applies `_ckd` — the shared "done" signal that prevents reprocessing.

Each thread (and each message within it) is processed in its own try/catch — one broken or unparseable email can't block `_ckd` for anything else, so it can't get stuck retrying forever on every trigger run.

### Alias labeler (`src/AliasLabeler.js`)

`labelAliasThread(thread)` inspects `To` and `Cc` fields of every message and checks for addresses matching configured domains. On a match it creates a two-level label hierarchy:

```
@yourdomain.com/newsletter     ← local@domain
@yourdomain.com                ← parent domain group
```

Subdomain addresses get an extra level:
```
@yourdomain.com:sub/alias
@yourdomain.com:sub
@yourdomain.com
```

Works with Google Workspace accounts too — set `GMAIL_DOMAIN` to your Workspace domain instead of `gmail.com`.

### Booking scanner (`src/BookingScanner.js` + `BookingParsers.js`)

Three-layer detection pipeline, tried in order per message:

| Layer | Technique | Confidence |
|---|---|---|
| **0** | Eligibility filter — sender/subject exclusions, body red flags | gate |
| **1** | schema.org structured data (JSON-LD + microdata) | high |
| **2** | ICS attachment(s), `.ics` URL, or Google Calendar add-link — extracts every event from every attachment | medium |
| **3** | AI extraction from body + PDF attachments (Claude or Gemini) | medium |

A batch run (`runBookingScanner()` / the scheduled trigger) always finishes layers 0–2 for every message first, and only runs AI extraction afterwards for whatever's left — so later, more complete emails in the same batch are already on the calendar by the time any AI call happens. Before spending an AI call at all, the scanner also checks:
- whether a high-confidence event with a clearly similar title already exists on the dates mentioned in the email (found via regex, no AI needed) — skips the call as a likely weaker duplicate;
- whether a loose PDF attachment's filename (e.g. a rail ticket named `STATION_A_STATION_B_2026-10-06_...`) matches a leg already created by the ICS layer — if so, the PDF is just filed onto that event instead of triggering AI extraction.

Emails that are Google Calendar invite notifications, or are themselves a Zoom/Teams/Webex/etc. join invitation, are excluded before any detection layer runs.

**Active categories** (`bcActiveCategories` in `src/BookingDetectionRules.js`):

| Category | Default |
|---|---|
| transport (train, flight) | ✅ |
| accommodation (hotel, Airbnb) | ✅ |
| show (concert, match, theatre) | ✅ |
| appointment_medical (Doctolib, vet) | ✅ |
| appointment_personal (Square, etc.) | ✅ |
| meeting (Cal.com, Calendly) | ❌ disabled — already creates its own events |

**Pre-departure blockers**: a calendar blocker is automatically created before transport events — 1 h for Eurostar, 2 h for short/medium-haul flights, 3 h for long-haul (classified by IATA continent).

**Connecting legs**: consecutive flight/train legs from the same email that are close enough in time to be one journey get a "Connection" blocker instead of each leg carrying its own full pre-departure buffer. A flight-to-flight connection (airside, no re-clearing security) gets one block spanning the whole layover. Any other combination (train→flight, flight→train, train→train) keeps the normal buffer for the next leg and fills only the remaining time before it — the two never overlap.

**Multi-booking emails**: a single email with multiple ICS files or schema.org blocks (e.g. a travel agent recap with outbound + return flights + hotel) creates one event per booking.

**Duplicate handling**: if a later email covers a booking that already has a calendar event (same real-world instant — timezone-aware, so a leg logged in its departure zone and one logged in its arrival zone still match — and a matching location or a clearly similar title), it's merged rather than duplicated. Each source is scored by layer confidence (schema.org > ICS > AI) plus data completeness, and that score is stored on the event. A better-scoring email, or simply one with a real arrival time where the calendar only had a default-duration guess, replaces the dates/title/location/description outright. A weaker or equal source gets appended as its own clearly separated block instead. Leftover duplicate events from past runs (e.g. a guessed block next to the real one) are detected and cleaned up automatically. This works regardless of which email is processed first.

**Calendar labels**: set `BC_LABEL` in `Config.js` to the name of an existing calendar label (Calendar's own label feature, not a Gmail label) to have every created/matched event tagged with it automatically.

**Subject matching** covers French, English, Spanish, Portuguese, Italian, Polish, Japanese, Chinese, Korean, German, and Scandinavian keywords (`bcSubjects` in `src/BookingDetectionRules.js`); exclusion rules (newsletters, promotions, pre-sale announcements, etc.) cover the same set of languages.

**Idempotency**: handled by `_ckd` — threads already labeled `_ckd` are excluded from the search query. To reprocess a thread, remove its `_ckd` label in Gmail, or call `processThread(threadId, simulate)` directly (bypasses `_ckd` entirely).

**Debugging a specific email**: `runBookingScanner()` and `processThread()` both turn on verbose tracing for the duration of the call (off during the scheduled trigger) — the execution log shows each message's eligibility, which layer matched, the raw source data behind every date/timezone decision, and whether an event was created/upgraded/enriched/skipped and why.

Layer 3 requires `AI_API_KEY` in Script Properties, with `AI_MODEL` picking the provider (any Claude or Gemini model). If `AI_API_KEY` is empty, AI extraction is silently skipped — layers 1–2 still work.

Ticket attachments (PDF, pkpass) are saved to the Drive folder set by `TICKETS_FOLDER_ID` and linked in the calendar event description. Some ticketing sites block or stall automated downloads entirely (server-side bot filtering) — when that happens, the raw ticket link is still included in the description for manual use instead of hanging the whole run.

---

## Setup

### Prerequisites

- [clasp](https://github.com/google/clasp) installed and authenticated.
- A Google Apps Script project linked via `.clasp.json` (not committed — contains credentials).

### First-time setup

```bash
# 1. Clone and push
git clone <repo>
cd gas-gmail-triage
clasp push

# 2. In the GAS editor: add the Calendar advanced service
#    Services (+) → Google Calendar API → identifier: Calendar

# 3. Edit Config.js: fill in setupConfig() with your values, then run it
#    from the GAS editor (or set Script Properties manually).

# 4. Dry run — verify detection without creating any events
runBookingScanner({ simulate: true })
# Or with a custom date range:
runBookingScanner({ from: '2025-01-01', to: '2025-03-01', simulate: true })
# Or on a single thread (also bypasses the _ckd gate):
processThread('<threadId>', true)

# 5. Backfill historical email
runBookingScanner({ days: 60 })

# 6. Install the trigger
installTrigger()
```

### Script Properties

| Key | Example | Description |
|---|---|---|
| `GMAIL_USER` | `yourname` | Gmail username (before @) |
| `GMAIL_DOMAIN` | `gmail.com` | `gmail.com` or your Workspace domain |
| `ALLOWED_DOMAINS_JSON` | `["yourdomain.com","icloud.com"]` | Domains to watch for aliases |
| `TICKETS_FOLDER_ID` | Drive folder ID | Where ticket PDFs/pkpass are saved |
| `AI_MODEL` | `claude-haiku-4-5-20251001` | Optional — booking scanner layer 3 only |
| `AI_API_KEY` | `sk-ant-...` or Gemini key | Optional — matching `AI_MODEL`'s provider |

### Disabling a feature

In `Config.js`:
```js
const FEATURES = {
  aliasLabeler:   false,  // ← disable
  bookingScanner: true,
};
```

No files need to be deleted. The Calendar advanced service can be removed from `appsscript.json` if the booking scanner is permanently disabled.

---

## Local development

```bash
clasp push          # push all .js + appsscript.json to GAS
clasp pull          # pull current GAS state back to disk
clasp logs          # stream execution logs
```

The deployment is `@HEAD`, so every `clasp push` is live immediately — no separate deploy step. A Claude Code hook can automate commit + push on every session stop; see `.claude/settings.json` (gitignored, local-only — not included in this repo since it holds a machine-specific path).

**Quick rollback**:
```bash
git log --oneline
git checkout <commit> -- .
clasp push
```
