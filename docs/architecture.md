# Architecture

## Components

```
Browser ──HTTPS──▶ Next.js 16 (App Router)
                    ├─ Server components: read PostgreSQL through the service layer
                    ├─ /api/v1/*        typed REST (auth → RBAC → CSRF → rate limit → Zod → service)
                    ├─ /api/webhooks/*  DoubleTick status receiver (bearer-authenticated, deduplicated)
                    ├─ /api/integrations/zoho/*   server-side OAuth (state bound to an httpOnly cookie)
                    └─ /api/public/email-content/:token   frozen email HTML fetched by Zoho MA
PostgreSQL (Prisma) ◀── source of truth for categories, memberships, templates, campaigns, consent, audit
Redis + BullMQ ◀── worker (`npm run worker`): execute · wa.send · email.dispatch · email.reconcile · crm.sync · scheduler.tick · webhook.retry
Providers: Zoho CRM v8 (read-only) · Zoho Marketing Automation v1 · DoubleTick API (V2 template send)
```

Without Redis, an **inline queue** runs the same job handlers inside the Next.js process. This is for development and tests only. Every job is idempotent, because state lives in PostgreSQL and each send is claimed with a conditional `UPDATE … WHERE status='QUEUED'`.

## Source-of-truth boundaries

| Data | Owner | Notes |
|---|---|---|
| Client identity and contact details | Zoho CRM | Mirrored into `clients`. Sync overwrites CRM-owned columns only. |
| Categories, memberships, rules | Dashboard | `client_categories` (unique per client and category; soft removal keeps history) and `membership_events`. |
| Template registry and mappings | Dashboard | WhatsApp templates are created and approved in DoubleTick and linked here by name and language. |
| Campaigns, snapshots, deliveries | Dashboard | Immutable once approved. |
| Consent and suppression | Dashboard | Append-only consent history. Provider unsubscribes and hard bounces flow back in. |

## Data model (key tables)

`users`, `roles`, `sessions` · `clients` · `categories`, `client_categories`, `membership_events`, `category_rules` · `templates`, `template_versions`, `category_templates` · `campaigns`, `campaign_categories`, `campaign_snapshots`, `campaign_recipients`, `campaign_message_assignments`, `message_deliveries`, `delivery_events` · `consents`, `suppression_entries`, `internal_test_recipients` · `integration_settings`, `sync_runs`, `webhook_events` · `audit_logs`, `app_settings`.

Database-level guarantees (migration `20261016104300_immutability_guards`):

- `audit_logs` is append-only. `UPDATE` and `DELETE` raise errors; retention purges must set an explicit session flag.
- `campaign_snapshots` cannot be updated or deleted.
- After a snapshot exists, `campaign_recipients` and `campaign_message_assignments` for that campaign reject `INSERT`, `UPDATE` and `DELETE`.
- Active category names are unique (case-insensitive). There is one active suppression per identifier and scope.
- `campaign_message_assignments` is unique on (campaign, recipient, channel, template) and on `idempotency_key`. `message_deliveries` is unique on `assignment_id` and on `provider_message_id`.

## Campaign lifecycle

```
DRAFT ─submit─▶ PENDING_APPROVAL ─approve─▶ (QUEUED | SCHEDULED) ─▶ RUNNING ─▶ COMPLETED
  ▲   ◀─withdraw─┘   └─reject─▶ REJECTED ─edit─▶ DRAFT
RUNNING ⇄ PAUSED · any open state ─cancel─▶ CANCELLED · provider no longer LIVE ─▶ auto-PAUSED
```

All transitions go through `src/lib/domain/campaign-state.ts`.

### Approval (one serializable transaction)

1. The audience is recomputed from current memberships, consent, suppressions and review decisions. Previews are never trusted.
2. The approver's typed message count must equal the recomputed count. A mismatch is rejected with "the audience changed".
3. The transaction writes recipients, per-recipient assignments (template version, rendered WhatsApp payload, idempotency key) and the snapshot (summary, per-category membership counts, template version hashes, content hash).
4. The campaign's liveness is fixed (`is_live`). A campaign approved as non-live can never send real messages.

### Eligibility and overlap engine (`src/lib/domain/eligibility.ts`)

This is a pure, deterministic function, unit-tested up to 50k members. For every member of a selected category and every selected channel it checks:

- contact presence and validity
- CRM opt-out
- consent per policy (WhatsApp opt-in; email opt-out, configurable)
- suppression (per channel or all channels)
- inactive or deleted CRM status
- merged duplicates
- per-campaign contact deduplication
- required template data

It then resolves which template applies. If the client's selected categories map to different templates, the `overlapStrategy` decides; the default holds the recipient for manual review.

### Execution

- **WhatsApp.** One delivery per assignment, throttled by `min(campaign rate, DoubleTick throttle)`. Results are handled as follows:
  - Outcomes are classified as *retryable* (429, 502, 503, connection refused), *permanent* (4xx), or *unconfirmed* (timeout after send, 500).
  - Unconfirmed sends are **never retried automatically**. They are flagged for manual reconciliation to avoid duplicate messages.
  - Status webhooks are deduplicated by (messageId, status, timestamp) and only move status forward.
- **Email.** One Zoho MA campaign per (category, template) group. Each group follows these steps:
  1. Create an isolated list, so no recipient from another category can leak in.
  2. Add the frozen emails in batches of 10.
  3. Check that the provider list count equals the frozen count; on mismatch, abort without sending.
  4. Create the campaign with the frozen hosted content URL, then send.
  5. Reconcile from reports at 15 minutes, 2 hours, 24 hours and 72 hours: sent, bounces, opens, clicks and opt-outs. Opt-outs become consent revocations plus suppressions.
- **Modes.**
  - **MOCK**: simulated provider and events, every row flagged `is_simulated`.
  - **DRY_RUN**: renders and records `DRY_RUN` deliveries; no send endpoint is called.
  - **LIVE**: requires `ALLOW_LIVE_SEND=true`, an admin enabling it, and a campaign approved as live. Real adapters re-check this immediately before every send call.

## Security

- Sessions: random 256-bit token in an httpOnly, SameSite=Lax cookie (Secure in production), stored as a SHA-256 hash. 12-hour TTL; Argon2id passwords; lockout after 5 failures.
- RBAC is enforced in every API route and page (`requireApiUser` / `requirePageUser`). `proxy.ts` is only an optimistic redirect.
- CSRF: mutations require the `x-ncc-request: 1` header, a same-origin `Origin`, and a SameSite cookie.
- Rate limiting per user and route; Redis-backed when configured. Login is limited per IP.
- Secrets: AES-256-GCM envelope encryption (`CREDENTIALS_ENCRYPTION_KEY`). The UI only receives masked hints.
- PII masking (`maskDeep`) is applied to audit metadata, stored webhook headers and payloads, and logs.
- Security headers: HSTS, frame denial, nosniff, referrer and permissions policy.

## Salesforce Marketing Cloud archive

A separate, read-only module (`/salesforce/*`, `src/lib/salesforce`, `src/lib/services/salesforce`, `salesforce_*` tables) preserves the legacy SFMC account for SEBI evidence. It shares auth, RBAC, the queue, crypto and the UI kit with the rest of the app but never touches campaign, client or provider data, and never writes to Salesforce. Jobs: `sfmc.backup.step`, `sfmc.reconcile`; the existing `scheduler.tick` also runs archive schedules and resumes interrupted backups. Full design: [salesforce-archive.md](salesforce-archive.md).
