To resume this session: read this file completely, then read all files in the trashapp-mastermind repo, then continue from the Next Steps section.

# TrashApp Mastermind — Context File

## Build Status

| Build Item | Status |
|-----------|--------|
| BUILD 1 — Core Infrastructure (firestore, logger, twilio, stripe) | ✅ Complete |
| BUILD 2 — Pricing Config (pricing.json) | ✅ Complete |
| BUILD 3 — Job State Machine (pipeline.js, ai-verify.js) | ✅ Complete |
| BUILD 4 — SMS Conversation Handler (sms-conversation.js) | ✅ Complete |
| BUILD 5 — Webhook Receivers (stripe, twilio, twilio-inbound) | ✅ Complete |
| BUILD 6 — Scheduler (all cron jobs + nightly maintenance) | ✅ Complete |
| BUILD 13 — Slot Booking System (job_slots, schedule config, hold expiry) | ✅ Complete |
| BUILD 14 — Job Status SMS (status-triggered SMS templates) | ✅ Complete |
| BUILD 15 — Intel Scraper (weather, estate sales, Craigslist, permits) | ✅ Complete |
| BUILD 16 — Territory Engine (AI assignment + briefing SMS) | ✅ Complete |
| BUILD 17 — Twilio Inbound Webhook (two-way SMS, admin alerts) | ✅ Complete |
| BUILD 18 — AI Operating System (10 agents, meeting runner, approval queue) | ✅ Complete |
| BUILD 19 — One-Command Installer (setup.sh, setup.bat, verify.js) | ✅ Complete |
| BUILD 20 — SaaS-Level UX Overhaul (all 4 frontends, design system, bug fixes) | ✅ Complete |
| BUILD 7 — Dispatch Dashboard (server.js + index.html) | ✅ Complete |
| BUILD 8 — PC Setup PDF Generator (generate-pdf.js) | ✅ Complete |
| BUILD 9 — Service Installer (install-service.js) | ✅ Complete |
| BUILD 10 — Context File (this file) | ✅ Complete |
| BUILD 11 — Package.json + index.js startup | ✅ Complete |
| BUILD 12 — Environment Config (.env.example, .gitignore) | ✅ Complete |

## Frontend Platform Versions

| Platform | Current Version | Netlify Site | Deploy Target |
|----------|----------------|-------------|---------------|
| Homepage | v1.2 | superlative-seahorse-56e6b1 | homepage.html → index.html |
| Quote Page | v1.4 | chic-panda-ef55db | quote.html → index.html |
| Rep Platform | v1.6 | flourishing-hotteok-596592 | rep-platform.html → index.html |
| Admin Console | v1.7.4 | lucent-pithivier-3b52fb | admin-console.html → index.html |
| Crew Dashboard | v1.0 | crew-trashapp (pending deploy) | crew-dashboard.html → index.html |

## Apr 13 2026 — Session Changes

### Part 1 — Firebase ADC
- `core/firestore.js` now tries service account → ADC (`admin.credential.applicationDefault()`) → mock
- `install/verify.js` detects gcloud ADC file at `%APPDATA%\gcloud\application_default_credentials.json` (Windows) or `~/.config/gcloud/application_default_credentials.json` (Mac/Linux); marks Firebase creds satisfied in ADC mode
- `index.js` startup banner shows `Firebase: ADC` when using applicationDefault()

### Part 2 — Rep Platform beforeunload
- `beforeunload` listener uses `navigator.sendBeacon('/api/rep-inactive', …)`
- New route `POST /api/rep-inactive` in `dashboard/server.js` sets `live_reps/{repId}.active = false`
- rep-platform.html → v1.6

### Part 3 — Crew Dashboard (new)
- `DEPLOY/crew-dashboard.html` — mobile-first field ops app, phone auth, 56px tap targets, PWA-ready
- Daily route (today's jobs from Firestore), dump yard inserted every 2 jobs, Google Maps deep link
- 4-stage pipeline (En Route → Arrived → In Progress → Complete) with `jobs/{jobId}/statusHistory` subcollection; arrival SMS via `POST /api/crew-sms`; visible job timer on IN_PROGRESS
- Before/after photos → Firebase Storage `jobs/{jobId}/photos/{before|after}/{ts}.jpg`
- Canvas signature → base64 saved to `jobs/{jobId}.signature`
- 2-hour delayed Google-review SMS via setTimeout after complete
- GPS tracking every 30s → `crew_locations/{crewId}`; stops on `beforeunload` via `POST /api/crew-inactive`
- Bottom nav: Route / Jobs / Photos / Profile + session summary card
- Admin console (v1.7.4) subscribes to `crew_locations`, renders active crew as gold markers w/ popup showing name + last update

## v1.1 / v1.3 Feature Summary

### Homepage v1.1
- Google Business review link (social proof bar + footer)
- Service area city grid (14 cities, Fresno HQ badge, responsive 4→3→2 columns)
- JSON-LD LocalBusiness schema markup for SEO

### Quote Page v1.1
- $175/$225 minimum price floor (enforceMinimumPrice utility, applied single + multi-location)
- Mobile bottom sheet booking form (slides up on < 768px, overlay dims background)
- Google Places address autocomplete with stored lat/lng for faster distance calc

### Rep Platform v1.1
- $175 minimum price validation on same-day close with inline error
- Smart auto-close: gold toast + panel close on quick log (1.2s), green toast on status save (1s), celebration card on deal close (2s)
- "→ Next Door" button on all 5 panel tabs (52px min-height, full-width gold border)
- Calendly widget integration with customer prefill (name/email/phone/address/quote), graceful iframe fallback, missed-booking banner, confirmation card
- HubSpot contact sync on same-day close (non-blocking POST to HS_URL)

### Quote Page v1.2
- Unified 4-tier travel fee calculation (0-30mi base, 30-100mi +$0.50/mi, 100-200mi +$0.75/mi flagForReview, 200+ blocked)
- Travel-inclusive headline prices via buildAdjustedPrice() — travel baked into displayed price
- Live gas price from Firestore (system_config/gas_price) via Firebase module bridge (window._fbDb)
- Nominatim geocoding for distance calculation (no Google Maps API key needed)
- Blocked job UX: "Custom quote needed" message with manual review request
- Travel note, gas rate indicator, long-distance flag, waive toggle on quote results
- Multi-location quotes include travel cost once across all locations

### Rep Platform v1.3
- Same 4-tier travel fee system as quote page
- calcTravelFee(), estimateTravel() (Google Maps geocoder), buildAdjustedPrice(), buildLongDistanceBanner()
- All 4 quote paths (main quote, door sheet single, door sheet multi, client-facing) show travel-inclusive prices
- Travel note, gas rate, long-distance banner, underwater warning on all quote renders
- Updated negotiation floor: "Do NOT go below $X"
- flagForManualQuote() creates manual_review Firestore doc for 200+ mile jobs
- Door sheet uses calcTravelFee() with raw GPS coords (no geocoding needed)
- loadGasPrice() reads live price from Firestore on auth, falls back to $4.60

### Quote Page v1.3
- Real-time slot picker (buildSlotPicker) with Firestore onSnapshot on job_slots
- Slot states: available (gold), held (pulsing), booked (gray), blocked (dark)
- 5-minute hold timer with countdown display
- bookJob() and bookJobMulti() now create Firestore job documents
- scheduledSlot and scheduledSlotLabel added to HubSpot POST and Firestore
- Expanded Firebase bridge: collection, query, where, orderBy, getDocs, onSnapshot, setDoc, updateDoc, addDoc, serverTimestamp
- Success message shows scheduled pickup time

### Rep Platform v1.4
- ALL Calendly code removed (modal, iframe, functions, buttons, URL constant)
- Inline slot picker in book-success (quote tab) and dq-book-success (door sheet)
- buildSlotPicker() using module-scoped Firebase functions
- Rep session mode: field mode full-screen UI
- Session start modal with zip override
- Field mode: camera → auto-quote → outcome buttons (Book/Interested/Pass)
- Book outcome triggers slot picker inline
- Not interested sub-options: No answer, Not interested, Do not knock
- All outcomes update rep_sessions Firestore doc in real time
- Live counters: doors, quotes, booked in field mode header
- Exit field mode without ending session
- End session → scorecard with stats + vs-average comparison
- Dashboard shows last session stats and all-time stats
- Active session resumes on app reload (checks rep_sessions for status=active)
- Session data persisted: doorsKnocked, quotesGiven, jobsBooked, totalQuoteValue, totalBooked, commissionEarned, closeRate

### BUILD 20 — SaaS-Level UX Overhaul (all 4 frontends)

#### Homepage v1.2 (from v1.1)
- Design system CSS tokens (--brand, --bg-base, --bg-surface, --border, --text-primary, etc.)
- Inter font (primary) + Bebas Neue (headings) + DM Sans (fallback)
- Responsive breakpoints: 375px, 390px, 430px, 768px, 1280px
- Scroll reveal animations on all sections
- Updated social proof bar, FAQ accordion, pricing grid
- Semantic color tokens, shadow system, radius tokens

#### Quote Page v1.4 (from v1.3)
- Full design system token application
- Inter font loaded
- PWA meta tags (manifest.json, apple-mobile-web-app)
- showToast() replaces all alert() calls (2 instances)
- Trust bar below header (Free estimate / Same-day / Upfront pricing)
- Enhanced photo upload zone (larger, more inviting)
- Hero price card for quote results
- Confetti success animation on booking
- Improved step indicator styling

#### Rep Platform v1.5 (from v1.4)
- Full design system token application (30+ CSS custom properties)
- Inter font loaded as primary
- PWA meta tags (manifest.json, apple-mobile-web-app)
- showToast() replaces all 26+ alert() calls
- BUG FIX: rep_sessions compound index fallback (graceful client-side filter when Firestore index missing)
- First-login onboarding tooltip tour (3 steps, localStorage persistence)
- Shimmer skeleton loader CSS
- Page entrance fade-up animation
- Session start button pulse-glow animation
- fmtCurrency() and fmtPct() number formatters

#### Admin Console v1.7 (from v1.6)
- Full design system token application (35 CSS custom properties)
- Inter font loaded as primary
- BUG FIX: initAdminMap callback timing (removed callback= from script URL, deferred init)
- showToast() replaces all 43 alert() calls
- Keyboard shortcuts: N=Jobs, S=Schedule, A=AI OS, ?=Help
- Shimmer skeleton loader CSS
- Page entrance fade-up animation
- Enhanced toast system (typed: success/error/warning/info with icons)

### Admin Console v1.6 (built from v1.5)
- v1.6: AI OS tab with 4 sub-sections: Agent Status Grid, Pending Approvals, Staff Meeting Chat, Content Queue
- v1.6: Agent Status Grid — 3x3 real-time cards via Firestore onSnapshot on agent_state (running/idle/error/meeting states)
- v1.6: Pending Approvals — approve/decline buttons update pending_approvals and notify requesting agent via agent_messages
- v1.6: Staff Meeting Chat — real-time message streaming from agent_messages filtered by weekId, LIVE badge when running
- v1.6: Previous meetings accessible via dropdown (agent_meetings ordered by startedAt desc)
- v1.6: Content Queue — approve/decline/copy-to-clipboard for CMO and HR generated posts in content_queue

### Admin Console v1.5 (built from v1.4)
- v1.2: Social Media Manager tab (composer, caption variants, content queue, connected accounts)
- v1.2: COMMS sidebar section (Broadcasts + Social Media)
- v1.2: Topbar links (View Rep Platform →, Crew Dashboard →)
- v1.3: Leaflet replaced with Google Maps (Live Activity + Territories maps)
- v1.3: Maps centered on Fresno (36.7765, -119.8420) with dark theme
- v1.3: Rep markers (green = in session, purple = online, white/gold = knocking)
- v1.3: Leaderboard conversion rate per rep (e.g. "5 closed · 45% conv.")
- v1.3: Retry banners on 5 critical sections (Reps, Doors, Jobs, Social, Broadcasts)
- v1.4: Removed Calendly references
- v1.5: Schedule tab (settings editor + week grid for slot management)
- v1.5: Schedule settings: operating days, default hours, per-day overrides, slot duration, max jobs/slot, closures, holiday presets
- v1.5: Jobs tab upgraded to Kanban board (Pending → Scheduled → En Route → On Site → Completed → Invoiced → Paid)
- v1.5: Job detail panel with SMS message thread and admin reply functionality
- v1.5: Intel tab with zip code opportunity grid (color-coded by weekScore 0-100)
- v1.5: Territory assignment approval UI (approve/override per rep, approve all)
- v1.5: Status change buttons in job detail (calls POST /api/jobs/:id/status)

## Service Connection Status

### Mastermind — Slot Booking System
- scheduler.js: Sunday 11pm cron generates 7-day slots from system_config/schedule config
- scheduler.js: Every 5 min cron releases expired holds (>5 min old)
- server.js: Full schedule CRUD API (GET/POST config, slot hold/release/book/block/unblock)
- Slot document structure: slotId, date, window, label, status, maxJobs, heldBy, heldAt, jobId, bookedAt, blockedReason
- Calendly fully removed — webhooks/calendly.js contains deprecation notice only

### Mastermind — Job Status SMS
- core/job-status-sms.js: Automated SMS templates for scheduled, en_route, on_site, completed transitions
- webhooks/twilio-inbound.js: Handles customer SMS replies, writes to jobs/{id}/messages, alerts admin
- server.js: POST /api/jobs/:id/status (status update with history tracking), POST /api/jobs/:id/reply (admin reply)

### Mastermind — Intel Scraper
- core/intel-scraper.js: Nightly scraper (5 sources: Open-Meteo weather, estate sales, Craigslist hauling, Craigslist free, Fresno permits)
- Claude API analysis for weekScore and claudeSummary per zip (fallback scoring without API key)
- Writes to zip_intel/{zipCode} in Firestore
- scheduler.js: 2:15 AM cron for nightly scrape
- server.js: GET /api/intel, POST /api/intel/refresh

### Mastermind — Territory Engine
- dispatch/territory-engine.js: Sunday 10pm AI territory assignment
- Pulls rep performance (close_rate_by_zip from last 30 days), zip intel scores, weather forecast
- Claude API generates assignments with reasoning (fallback: assign by profile zip + best neighbor)
- Writes to territory_assignments/{weekId} in Firestore
- scheduler.js: Monday 7am briefing SMS to each rep with territory, intel summary, rain warnings
- server.js: GET /api/territories/assignments, POST approve, POST override

### Mastermind — AI Operating System
- 10 persistent AI agents running 24/7 on the office PC
- agents/base-agent.js: Shared BaseAgent class with run loop, Claude consultation (think/thinkJSON), report writing (writeReport/readReport/readAllReports), message bus (sendMessage/readMessages/sendMeetingMessage), approval queue (queueApproval/checkApproval), state management (updateState)
- Agent intervals: CEO (6hr), CFO (12hr), CMO (4hr), Operations (2hr), HR (8hr), Training (24hr), Customer Success (6hr), Legal (168hr), Pricing (24hr)
- All agents use Anthropic SDK with claude-sonnet-4-20250514 model
- Meeting runner: Monday 9am Pacific, CEO opens, each agent presents in order with 2s delay, CEO closes with approval summary, SMS sent to owner
- Shared message bus: agent_messages collection with from/to/type/priority/weekId
- Approval queue: pending_approvals collection with approve/decline from admin console
- Agent state: agent_state collection updated in real-time for dashboard display
- Content queue: content_queue collection for CMO/HR generated posts awaiting approval
- index.js: All 9 agents started as concurrent async processes with auto-restart after 60s on crash
- dashboard/server.js: 9 new API routes for agent state, approvals, meetings, content queue
- install/setup.sh: One-command Mac installer (checks Node.js, clones repo, npm install, creates .env, runs verify, installs service)
- install/setup.bat: One-command Windows installer (same flow)
- install/verify.js: Post-install verification of all required env vars

### Mastermind — Live Gas Price System
- core/gas-price.js: Fetches West Coast weekly retail gas from EIA API v2, writes to Firestore system_config/gas_price
- scheduler.js: Monday 6:05 AM cron refreshes gas price, nightly maintenance checks staleness (>8 days = refresh)
- index.js: Startup freshness check — refreshes if >24 hours old
- dashboard/server.js: GET /api/gas-price, POST /api/gas-price/override ($2-$8 validation), POST /api/gas-price/refresh
- dashboard/public/index.html: Gas price widget card with live display, manual override input, EIA refresh button, Socket.io real-time updates
- maintenance/known-bugs.js: gas-price-stale bug check (flags if >8 days old)
- Both front-end files (rep-platform.html, quote.html) read gas price from Firestore on load

## Service Connection Status

| Service | Status | Notes |
|---------|--------|-------|
| Firebase | NOT CONFIGURED | Needs FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env |
| Twilio | NOT CONFIGURED | Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER |
| Stripe | NOT CONFIGURED | Needs STRIPE_SECRET_KEY |
| Calendly | REMOVED | Replaced by native Firestore slot booking system (job_slots collection) |
| Claude API | NOT CONFIGURED | Needs ANTHROPIC_API_KEY. Powers AI OS agents, SMS responses, intel analysis, territory optimization |
| EIA API | NOT CONFIGURED | Needs EIA_API_KEY in .env — register at eia.gov/opendata |
| Dashboard | ACTIVE | Runs on port 3000 (configurable via DASHBOARD_PORT) |
| Railway Quote API | EXTERNAL | https://junk-quote-api-production.up.railway.app/api/quote |
| Google Maps | EXTERNAL | API key: AIzaSyDtkh_G25Kr6YaAeNJOd9D9YJuyZnKvu08 (used in admin, quote, rep) |
| HubSpot | EXTERNAL | Portal 245673285, Form b243f733-e7e7-4418-8d99-e5a067d889e6 |

## Core Constants

- Firebase project: trashapp-reps
- Office zip: 93727
- Office coords: 36.7765, -119.8420
- Admin phone: +15597744249
- Minimum job price: $175 (enforced client-side in quote + rep, server-side in Railway)
- Gas price fallback: $4.60 (live price from EIA stored in Firestore)
- MPG constant: 12 (used for travel per-mile calculation)
- Travel minimum: $15 (floor for 0-30 mile tier)
- Travel tiers: 0-30mi (base), 30-100mi (+$0.50/mi), 100-200mi (+$0.75/mi + flagForReview), 200+mi (blocked)
- Target margin: 65%
- AI confidence auto-send: >= 0.60
- AI confidence manual review: 0.45-0.60
- Google Maps API key: AIzaSyDtkh_G25Kr6YaAeNJOd9D9YJuyZnKvu08
- HubSpot portal: 245673285
- HubSpot form ID: b243f733-e7e7-4418-8d99-e5a067d889e6
- Calendly URL: https://calendly.com/trashappjunkremoval

## Important URLs & Endpoints

- Dashboard: http://localhost:3000
- Health check: http://localhost:3000/health
- Webhooks: /webhooks/calendly, /webhooks/stripe, /webhooks/twilio
- API: /api/jobs, /api/stats, /api/services, /api/manual-review, /api/events, /api/social-stats, /api/gas-price
- Manual actions: POST /api/manual/send-quote, POST /api/manual/request-photos
- Gas price: GET /api/gas-price, POST /api/gas-price/override, POST /api/gas-price/refresh
- Schedule: GET /api/schedule/config, POST /api/schedule/config, GET /api/schedule/slots, POST /api/schedule/slots/:id/{hold,release,book,block,unblock}, POST /api/schedule/regenerate
- Jobs: POST /api/jobs/:id/status, POST /api/jobs/:id/reply
- Intel: GET /api/intel, POST /api/intel/refresh
- Territories: GET /api/territories/assignments, POST /api/territories/assignments/:weekId/approve, POST /api/territories/assignments/:weekId/override
- Agent OS: GET /api/agents/state, GET /api/agents/approvals, POST /api/agents/approvals/:id, GET /api/agents/meeting/:weekId, GET /api/agents/meeting-latest, GET /api/content-queue, POST /api/content-queue/:id/approve, POST /api/content-queue/:id/decline, GET /api/agents/messages
- Social connector: /api/social/providers, /api/social/connect/:provider/start
- Railway API: https://junk-quote-api-production.up.railway.app/api/quote
- Rep Platform: https://reps.trashappjunkremoval.com (flourishing-hotteok-596592.netlify.app)
- Admin Console: https://admin.trashappjunkremoval.com (lucent-pithivier-3b52fb.netlify.app)
- Quote Page: https://quote.trashappjunkremoval.com (chic-panda-ef55db.netlify.app)
- Homepage: https://trashappjunkremoval.com (superlative-seahorse-56e6b1.netlify.app)
- GitHub: https://github.com/isaak-stack/trashapp-mastermind

## Firestore Collections

| Collection | Purpose | Written By |
|-----------|---------|-----------|
| reps | Rep profiles, roles, commission rates | Admin console, auth |
| doors | Door knock logs with GPS | Rep platform |
| sessions | Rep knocking sessions | Rep platform |
| jobs | Full job lifecycle (QUOTED → DEAL_CLOSED) | Pipeline, rep same-day close, Calendly webhook |
| social_posts | Social media post drafts/schedule | Admin console social tab |
| live_reps | Real-time rep location/status | Rep platform GPS |
| customers | Customer records | Quote page, rep platform |
| commission_log | Rep commission tracking | Pipeline completion handler |
| financials | Daily financial summaries | Scheduler daily summary |
| manual_review | Flagged low-confidence quotes | Pipeline |
| system_logs | All system events | Logger |
| system_health | Deep health check results | Nightly maintenance |
| client_errors | Frontend JS error reports | All 4 frontends |
| admin_notifications | Real-time admin alerts | Pipeline, scheduler |
| system_config | System settings (gas_price, schedule) | Mastermind gas-price.js, scheduler, dashboard |
| job_slots | Booking time slots (available/held/booked/blocked) | Scheduler weekly gen, quote page, rep platform, admin |
| rep_sessions | Rep field session tracking (doors, quotes, jobs, stats) | Rep platform field mode |
| zip_intel | Weekly zip code intelligence scores + signals | Intel scraper nightly |
| territory_assignments | AI-generated weekly rep territory assignments | Territory engine Sunday |
| schedule_changes | Audit log for schedule config changes | Admin console |
| broadcasts | Admin broadcast messages | Admin console |
| crews | Crew profiles and scheduling | Admin console |
| daily_summary | Leaderboard snapshots | Scheduler |
| daily_reports | Auto-generated daily reports | Admin console |
| agent_reports | Agent cycle reports (agentId_YYYY-MM-DD) | All 9 agents |
| agent_messages | Inter-agent message bus + meeting messages | All agents, meeting runner |
| pending_approvals | Human approval queue from agents | All agents, admin console |
| agent_state | Real-time agent status (running/idle/error) | All agents |
| agent_meetings | Weekly staff meeting metadata (weekId) | Meeting runner |
| content_queue | CMO/HR generated post drafts for approval | CMO agent, HR agent |
| job_applications | Applicant tracking (scored by HR agent) | HR agent |
| customer_follow_ups | Review requests, NPS, loyalty offers | Customer Success agent |
| pricing_intel | Daily competitor pricing data | Pricing agent |

## Pipeline States

```
QUOTED → AI verify → auto_send (QUOTE_SENT) or manual_review
QUOTE_SENT → Customer SMS reply → CONFIRMED or CANCELLED
CONFIRMED → Payment method selected → AWAITING_PAYMENT or SCHEDULED (cash/check)
AWAITING_PAYMENT → Stripe webhook → SCHEDULED
SCHEDULED → Crew arrives → IN_PROGRESS
IN_PROGRESS → Complete → COMPLETED
DEAL_CLOSED → Same-day close from rep platform (skips SMS pipeline, HubSpot synced)
```

## SMS Humanization

All customer-facing SMS templates have been rewritten to sound like a real, friendly human texting from the business. No robotic phrasing. Templates use first names, casual tone, emojis, and natural language across:
- `dispatch/pipeline.js` — quote, payment, receipt, cancel, ETA, crew, admin alerts
- `dispatch/sms-conversation.js` — cash/check, card, clarification, admin unrecognized alerts
- `dispatch/scheduler.js` — crew schedule, quote follow-up, daily summary, ETA reminders
- `dashboard/server.js` — manual quote, photo request

## Claude API Integration

`dispatch/sms-conversation.js` includes a Claude API upgrade path:
- **Activates automatically** when `ANTHROPIC_API_KEY` is set in `.env`
- Uses `claude-sonnet-4-6` to parse customer intent and generate natural responses
- `generateHumanResponse(customerMessage, jobContext)` calls Anthropic API
- Falls back to keyword matching when API key is missing or API call fails
- Never crashes on missing credentials — graceful degradation
- To activate: add `ANTHROPIC_API_KEY=sk-ant-...` to `.env` and restart

## Last Known Issues

- None — all builds complete, not yet tested with live services

## Next Steps (Priority Order)

1. Set up Firebase service account credentials in .env
2. Set up Twilio account, buy a number, configure webhook
3. Set up Stripe account, configure webhook
4. Set up Calendly webhook subscription (rep platform now sends prefill data)
5. Test full pipeline: create job → AI verify → SMS quote → confirm → pay → schedule → complete
6. Test rep same-day close → HubSpot sync → DEAL_CLOSED
7. Test social media composer → Firestore social_posts collection
8. Configure ngrok or static IP for external webhook access
9. Run install-service.js on the dedicated PC
10. Monitor dashboard and nightly maintenance reports for first 48 hours

## File Inventory

```
trashapp-mastermind/
├── index.js
├── .env.example
├── .gitignore
├── package.json
├── install-service.js
├── README.md
├── generate-pdf.js
├── CONTEXT.md
├── DEPENDENCY_REPORT.md         (auto-generated during nightly maintenance)
├── TrashApp_Mastermind_PC_Setup.pdf  (auto-generated on first run)
├── config/
│   └── pricing.json
├── agents/
│   ├── base-agent.js        ← shared agent class all agents extend
│   ├── ceo-agent.js         ← 6hr cycle, strategic synthesis, morning digest
│   ├── cfo-agent.js         ← 12hr cycle, margin analysis, dump site pricing
│   ├── cmo-agent.js         ← 4hr cycle, SEO monitoring, content drafts
│   ├── operations-agent.js  ← 2hr cycle, job monitoring, slot utilization
│   ├── hr-agent.js          ← 8hr cycle, recruiting, rep activity tracking
│   ├── training-agent.js    ← 24hr cycle, coaching tips, playbook updates
│   ├── customer-success-agent.js ← 6hr cycle, reviews, NPS, loyalty
│   ├── legal-agent.js       ← 7-day cycle, deadline tracking, compliance
│   ├── pricing-agent.js     ← 24hr cycle, competitor pricing, market rates
│   └── meeting-runner.js    ← Monday 9am staff meeting orchestrator
├── install/
│   ├── setup.sh             ← one-command Mac/Linux installer
│   ├── setup.bat            ← one-command Windows installer
│   └── verify.js            ← post-install env var verification
├── core/
│   ├── firestore.js
│   ├── twilio.js
│   ├── stripe.js
│   ├── logger.js
│   ├── gas-price.js
│   ├── job-status-sms.js
│   └── intel-scraper.js
├── dispatch/
│   ├── pipeline.js
│   ├── sms-conversation.js
│   ├── ai-verify.js
│   ├── scheduler.js
│   └── territory-engine.js
├── webhooks/
│   ├── calendly.js          (DEPRECATED — native slot booking)
│   ├── stripe.js
│   ├── twilio.js
│   └── twilio-inbound.js
└── dashboard/
    ├── server.js
    └── public/
        └── index.html
```

Last update: ${new Date().toISOString()}

## Firestore Security Rules
File: `firestore.rules` (repo root)
Deploy: `firebase deploy --only firestore:rules`
Requires: firebase CLI installed (`npm install -g firebase-tools`) and logged in (`firebase login`)

Key rules:
- Public create on `jobs` and `job_applications` (customers book without auth)
- Public read on `job_slots` and `system_config` (frontend needs these)
- Rep auth required for `rep_sessions`, `live_reps`, `zip_intel`, `crew_locations`
- Admin only (phone +15597744249) for all AI OS collections (`agent_reports`, `agent_messages`, `pending_approvals`, `agent_state`, `agent_meetings`, `content_queue`)
- Deny-all default on any unmatched collection
- Mastermind server uses ADC (Admin SDK) which bypasses these rules entirely
