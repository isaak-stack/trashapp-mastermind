# TrashApp Mastermind — AI Dispatch Brain

A standalone Node.js application that runs 24/7 on a dedicated PC, connecting all TrashApp services into one automated dispatch pipeline with a real-time dashboard at `localhost:3000`.

## Quick Start

```bash
git clone https://github.com/isaak-stack/trashapp-mastermind.git
cd trashapp-mastermind
cp .env.example .env        # Fill in your credentials
npm install
node index.js               # Start the mastermind
```

Open http://localhost:3000 to access the dispatch dashboard.

## What It Does

**Automated Dispatch Pipeline** — Watches Firebase `jobs` collection in real time and routes every job through a state machine: QUOTED → QUOTE_SENT → CONFIRMED → AWAITING_PAYMENT → SCHEDULED → IN_PROGRESS → COMPLETED. Each transition triggers the right SMS, payment link, or crew notification automatically.

**AI Quote Verification** — Every new quote is re-verified through the Railway AI pricing API. High-confidence quotes are auto-sent to customers. Low-confidence ones land in a manual review queue on the dashboard.

**SMS Conversations** — Customers interact via text message. The system parses intent (CONFIRM, CANCEL, CASH, CHECK, CARD) and advances the job through the pipeline. Unrecognized messages get clarification replies; admin gets notified after 2 consecutive unknowns.

**Stripe Payment Links** — When a customer chooses to pay by card, a Stripe Checkout session is created and sent via SMS. The Stripe webhook handler processes successful payments and updates the job.

**Crew Scheduling** — At 6 AM daily, scheduled jobs are grouped by crew and optimized by nearest-neighbor routing from the office (36.7765, -119.8420). Each crew gets their route via SMS.

**Real-Time Dashboard** — Dark-themed dispatch console showing live event feed, 6-column job pipeline board, stats cards, and manual review queue. Powered by Socket.io for instant updates.

**Nightly Maintenance** — 2:00–4:30 AM maintenance window runs deep health checks on all services, npm dependency audits, error log analysis, data integrity verification, and performance reporting. Detection and reporting only — never auto-installs or auto-deploys.

## Architecture

```
trashapp-mastermind/
├── index.js                 # Entry point — startup sequence
├── config/pricing.json      # Pricing tiers, multipliers, thresholds
├── core/
│   ├── firestore.js         # Firebase Admin SDK (graceful degradation)
│   ├── logger.js            # System logging + Socket.io emit
│   ├── twilio.js            # SMS service (graceful degradation)
│   └── stripe.js            # Payment links (graceful degradation)
├── dispatch/
│   ├── pipeline.js          # Job state machine (Firestore watcher)
│   ├── sms-conversation.js  # Inbound SMS intent parser
│   ├── ai-verify.js         # Railway API quote verification
│   └── scheduler.js         # All cron jobs (daily + nightly)
├── webhooks/
│   ├── calendly.js          # POST /webhooks/calendly
│   ├── stripe.js            # POST /webhooks/stripe
│   └── twilio.js            # POST /webhooks/twilio
├── dashboard/
│   ├── server.js            # Express + Socket.io server
│   └── public/index.html    # Dispatch dashboard UI
├── generate-pdf.js          # PC setup guide PDF generator
├── install-service.js       # OS service installer (Win/Mac)
└── CONTEXT.md               # Session resume file
```

## Graceful Degradation

Every external service is wrapped in a configuration check. If the required .env variables are missing, the service logs "SERVICE NOT CONFIGURED: [name]" and continues running with a mock implementation. The dashboard and all other features keep working. Each service activates automatically when its .env variables are filled in and the process restarts.

## Environment Variables

Copy `.env.example` to `.env` and fill in your credentials. See the generated `TrashApp_Mastermind_PC_Setup.pdf` for detailed setup instructions for each service.

## Webhook Endpoints

| Endpoint | Method | Service |
|----------|--------|---------|
| `/webhooks/calendly` | POST | Calendly booking.created events |
| `/webhooks/stripe` | POST | Stripe payment_intent.succeeded |
| `/webhooks/twilio` | POST | Twilio inbound SMS |
| `/health` | GET | Health check |

## Scheduled Jobs

| Time | Task |
|------|------|
| 6:00 AM | Crew schedule + route optimization |
| 8:00 AM | Quote follow-ups (stale >2 hours) |
| 12:00 PM | Door-knocking leaderboard |
| 8:00 PM | Daily financial summary |
| Every hour | Service health checks |
| 2:00 AM | Deep health check (all services) |
| 2:30 AM | npm dependency audit |
| 3:00 AM | Error log analysis |
| 3:30 AM | Data integrity check |
| 4:00 AM | Performance report |
| 4:15 AM | GitHub backup check |
| 4:30 AM | Maintenance complete |

## Running as a System Service

```bash
node install-service.js
```

This registers TrashApp Mastermind to start automatically on boot and restart on crash.

## Contact

Isaak Thammavong, CEO — TrashApp Junk Removal
Phone: (559) 774-4249
Email: isaak@igniscreatives.com
