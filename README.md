# Niveshaay Communication Center

Internal platform for category-driven client communications over **email (Zoho Marketing Automation)** and **WhatsApp (DoubleTick)**, with **Zoho CRM** as the source of client identity.

- Categories and memberships live only in this dashboard. They are unlimited, and a client can belong to many categories. CRM sync never touches them.
- Each category is authorised for specific email and WhatsApp templates. Campaigns can only use those templates.
- Maker-checker approval: the approver cannot be the creator or the submitter, and must re-type the message count. Approval freezes the exact audience: recipients, template versions, rendered content and consent decisions. Database triggers make the frozen snapshot immutable.
- Overlap handling is explicit for clients in more than one selected category: manual review (the default), priority, one message per category, or exclude.
- Consent, suppression, CRM opt-out and duplicate-identity checks run on every send. Delivery is tracked per recipient. Provider acceptance is never counted as delivery.
- **Salesforce Archive** (read-only): preserves the legacy Salesforce Marketing Cloud account — Data Extensions, send jobs, recipient-level tracking, journeys, automations and templates — with verified, hash-chained backups, an audience-vs-send reconciliation engine and SEBI evidence packages. It never writes to Salesforce. See [docs/salesforce-archive.md](docs/salesforce-archive.md).
- Safe by default. Providers start in **MOCK** mode and the deployment-wide `ALLOW_LIVE_SEND` switch is off. Nothing reaches a real client until an administrator enables LIVE and a campaign is approved as live.

> **Status:** staging-ready. Real-provider code paths are implemented against verified documentation (see [docs/integrations.md](docs/integrations.md)). The DoubleTick API key has passed the non-sending credential probe. Zoho OAuth needs your API-console credentials. No real message has been sent.

## Quick start (local, no Docker required)

Prerequisites: Node.js ≥ 20.9 (22 recommended).

```bash
npm install
cp .env.example .env          # then set CREDENTIALS_ENCRYPTION_KEY (command inside the file)
npm run db:start              # embedded PostgreSQL on :5433 (keep this terminal open)
npx prisma migrate deploy     # apply migrations
npm run db:test:prepare       # migrate the test database
npm run db:seed               # MOCK dataset — 241 clients, 6 categories, simulated campaigns
npm run dev                   # http://localhost:3000
```

Seeded sign-ins all use the password `Niveshaay@Dev2026` (or the `SEED_ADMIN_PASSWORD` you set):

| Role | Email |
|---|---|
| Administrator | `admin@niveshaay.local` |
| Campaign Creator | `creator@niveshaay.local` |
| Approver | `approver@niveshaay.local` |
| Viewer | `viewer@niveshaay.local` |

Without `REDIS_URL`, background jobs run in-process (development only). With Redis, run `npm run worker` alongside the app.

> The project folder is inside OneDrive. The embedded database stores its data **outside** the synced folder, in `~/.niveshaay-cc/`. For day-to-day work, consider moving the repo out of OneDrive or excluding `node_modules`/`.next` from sync.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run worker` | BullMQ worker: execution, sends, reconciliation, CRM sync, scheduler (needs `REDIS_URL`) |
| `npm run db:start` | Local embedded PostgreSQL |
| `npm run db:migrate` / `db:deploy` | Prisma migrations (dev / deploy) |
| `npm run db:seed` | Load the clearly labelled MOCK dataset (refuses in production) |
| `npm run db:seed:salesforce` | Run the Salesforce Archive end to end against the built-in SIMULATED tenant (dev only) |
| `npm test` | Unit + integration tests (Vitest, real PostgreSQL test DB) |
| `npm run test:e2e` | Playwright end-to-end tests (desktop + tablet) against the seeded app |
| `npm run typecheck` / `lint` | Static checks |

## Screens

**Salesforce Archive:** Archive Overview · Backup Center · Data Extensions · Email Campaign Archive · Recipient Tracking · Journey & Automation · Template Archive · SEBI Audit Center · Backup Verification · Extraction Logs · Salesforce Connection.

Overview · Clients (directory, profile) · Categories (members, CSV import, dynamic rules, template mapping, history) · Templates (registry, editor, live preview, versions) · Campaign Studio (7-step wizard) · Scheduled · Approvals · Analytics · Activity Logs · Integrations · Settings (branding, compliance & safety, users & roles, test recipients, suppression list).

## Documentation

- [docs/architecture.md](docs/architecture.md): system design, data model, campaign lifecycle, safety model
- [docs/integrations.md](docs/integrations.md): verified provider capabilities, setup steps, and what is unverified or unsupported
- [docs/api.md](docs/api.md): REST API reference
- [docs/deployment.md](docs/deployment.md): staging and production deployment, go-live checklist
- [docs/salesforce-archive.md](docs/salesforce-archive.md): Salesforce Marketing Cloud archive — read-only guarantees, setup, verification, reconciliation, retention, operations
- [docs/compliance.md](docs/compliance.md): consent, privacy and SEBI-oriented controls, plus items for legal review

## Project layout

```
prisma/              schema, migrations (incl. immutability triggers), dev seed
scripts/             local Postgres launcher, BullMQ worker
src/app/(app)/       authenticated screens          src/app/api/   REST API, webhooks, OAuth
src/lib/domain/      pure logic: eligibility/overlap engine, template rendering, state machine, rules
src/lib/services/    persistence + orchestration     src/lib/providers/  Zoho CRM / MA, DoubleTick, mocks
src/lib/queue/       BullMQ / inline queue           src/components/     UI kit (shadcn/ui) + app components
tests/unit · tests/integration · tests/e2e
```
