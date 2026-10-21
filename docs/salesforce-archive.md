# Salesforce Marketing Cloud Archive

A read-only backup and SEBI audit archive of Niveshaay's Salesforce Marketing Cloud Engagement (SFMC) account, built into the Communication Center. It preserves what the official APIs can expose, verifies it, keeps it searchable after the Salesforce account closes, and produces evidence for internal compliance review.

It does **not** promise a complete copy of everything in Salesforce. Each dataset carries a verification status, and anything that could not be read or is outside a retention window is labelled as such rather than shown as zero.

## Contents

1. [Guarantees](#guarantees)
2. [Setup (Salesforce administrator)](#setup-salesforce-administrator)
3. [What is archived, and how](#what-is-archived-and-how)
4. [Verification](#verification)
5. [Reconciliation (18,000 vs 16,000)](#reconciliation-18000-vs-16000)
6. [Evidence packages and exports](#evidence-packages-and-exports)
7. [Retention and time zones](#retention-and-time-zones)
8. [Manual, authorised workflows](#manual-authorised-workflows)
9. [Architecture](#architecture)
10. [Operations](#operations)
11. [Database encoding](#database-encoding)
12. [Testing](#testing)
13. [Known limitations and open items](#known-limitations-and-open-items)

## Guarantees

| Guarantee | How it is enforced |
|---|---|
| Nothing in Salesforce is modified | `src/lib/salesforce/readonly.ts` rejects every request that is not: `POST /v2/token`, `GET /v2/userinfo`, a SOAP `RetrieveRequestMsg` (SOAPAction `Retrieve`), or a `GET` on allow-listed Journey/Content Builder resources (plus the Content Builder asset *query* search). There is no code path for Create/Update/Delete/Perform/Schedule/Extract, sends, or journey/automation start/stop. Unit-tested. |
| Credentials stay on the server | Client ID/Secret are AES-256-GCM encrypted (`CREDENTIALS_ENCRYPTION_KEY`). The browser only sees masked hints. Access tokens live in process memory only — never in the database, logs, manifests or exports. Credentials are only ever sent to `*.marketingcloudapis.com` hosts over HTTPS. |
| Raw evidence is preserved independently | Every API response page is stored unaltered (gzip + AES-256-GCM) in the archive store with its SHA-256 in PostgreSQL. Normalised tables are derived copies. |
| Archived evidence cannot be altered | Database triggers: extracted rows/events/pages cannot be updated, and cannot be deleted once their dataset is sealed; manifests, evidence packages and the archive audit log are append-only; completed reconciliations are frozen. Only an explicit `SET LOCAL ncc.retention_purge = 'on'` bypasses this (same convention as `audit_logs`). |
| No silent data loss | Values are stored as the exact strings returned (leading zeros, long IDs, decimals); repeated opens/clicks are separate rows; rows Salesforce returns twice are kept and reported; unknown properties are dropped *and recorded*. |
| No over-claiming | A dataset is VERIFIED only when integrity checks pass **and** an independent count matches. A backup is never VERIFIED while requested data is inaccessible or unverified. Reports never certify compliance. |
| Access is controlled and recorded | New permissions `archive:read`, `archive:export`, `archive:reconcile`, `archive:manage`. New role **Compliance Officer** (read + export + reconcile, no campaign or backup control). Viewers, Campaign Creators and Approvers have no archive access. Views of client-level evidence and every export are written to `salesforce_archive_audit_logs`. |

## Setup (Salesforce administrator)

Full UI access does not grant API access. Someone with Marketing Cloud admin rights must do this once:

1. **Setup → Platform Tools → Apps → Installed Packages → New** (e.g. “Niveshaay Archive – read only”).
2. **Add Component → API Integration → Server-to-Server.**
3. Tick **Read** only for: Data Extensions, Email, Tracking Events, List and Subscribers, Journeys, Automations, Saved Content, Documents and Images, Accounts. Grant nothing else — no Write, Send or Execute.
4. Under **Access**, enable the package for every Business Unit to be archived.
5. Copy **Client ID**, **Client Secret** and the **Authentication Base URI** (`https://mc….auth.marketingcloudapis.com/`).

Then in the dashboard: **Salesforce Archive → Salesforce Connection** → enter the values (optionally the BU MID as `account_id`) → **Save** → **Test connection** → **Discover business units** → tick the BUs to back up.

Test connection authenticates, reads `/v2/userinfo`, records the granted scopes, and runs one minimal read per capability (Business Units, Data Extensions, Subscribers, Send jobs, Tracking, Automations, Journeys, Content). A “denied” result names the scope to add.

SFTP / Enhanced FTP is not used anywhere.

## What is archived, and how

| Backup option | Source (official API) | Stored as |
|---|---|---|
| Account & BU inventory | SOAP `BusinessUnit` (QueryAllAccounts); falls back to `/v2/userinfo` ids | `salesforce_business_units` |
| Folders | SOAP `DataFolder` | raw pages; used to build DE folder paths |
| DE metadata & schemas | SOAP `DataExtension` + `DataExtensionField` (one request per DE) | `salesforce_data_extensions`, `salesforce_data_extension_fields` |
| DE rows | SOAP `DataExtensionObject[CustomerKey]`, all schema fields | `salesforce_data_extension_rows` (per dataset, page, row) |
| Subscribers | SOAP `Subscriber` | `salesforce_subscribers` |
| Lists, triggered sends | SOAP `List`, `TriggeredSendDefinition` | raw pages |
| Send jobs | SOAP `Send` (incl. NumberTargeted/Sent/Excluded, Duplicates, ExistingUnsubscribes, …) | `salesforce_email_jobs` |
| Recipient tracking | SOAP `SentEvent`, `NotSentEvent`, `BounceEvent`, `OpenEvent`, `ClickEvent`, `UnsubEvent`, filtered by `SendID` = JobID | `salesforce_tracking_events` |
| Journeys | REST `GET /interaction/v1/interactions?extras=all` (paged) | `salesforce_journeys` (+ raw JSON) |
| Automations, SQL queries | SOAP `Automation`, `QueryDefinition` | `salesforce_automations` |
| Content | REST `GET /asset/v1/content/categories`, `/asset/v1/content/assets` | `salesforce_assets` + original content file (encrypted) |

**Pagination.** SOAP Retrieve returns at most 2,500 objects; `MoreDataAvailable` is followed with `ContinueRequest = RequestID`. A continuation can be consumed only once, so a continuation that fails after it may have reached Salesforce is **not** retried. The dataset restarts from page 1 under a new attempt number (capped at 3), rather than risking a silent gap. REST resources are paged with `$page` and the documented page-size parameter until the reported `count` is reached.

**Resumability.** A backup runs as a chain of short `sfmc.backup.step` jobs, each processing at most *pages per step* pages (default 10). For each page: fetch → store raw payload → one transaction (page record + normalised rows + checkpoint). A crash can never half-write a page, and replaying a page cannot duplicate rows (unique `(dataset, page, row)`). A lease (`lease_until`) ensures one runner per backup; the once-a-minute scheduler tick resumes backups whose lease expired. Cancellation is honoured between pages.

**Rate limits.** Per connection: max parallel calls (default 2) and a minimum gap between calls (default 250 ms). HTTP 429/5xx and network errors on idempotent calls are retried with exponential backoff (Retry-After honoured); expired tokens are refreshed once. After repeated failures a dataset waits and retries at the job level (backoff up to 15 min) before being marked FAILED.

**Stages.** Some data depends on other data, so planning happens in three stages: (1) metadata, subscribers, send jobs, journeys, automations, content folders; (2) DE inventory, content assets, tracking per JobID; (3) DE rows.

**Incremental mode.** Send jobs since the last successful backup, plus re-extraction of tracking for jobs sent in the last 14 days (opens and clicks keep accruing). Metadata and DE rows are always extracted in full. A newer extraction supersedes the older one for search; the older one stays archived. A newer tracking extraction that returns *fewer* events than an earlier one (e.g. events aged out) never displaces the more complete copy.

## Verification

Run automatically when each dataset finishes, and on demand (**Re-verify**). Checks:

| Check | Fails / warns when |
|---|---|
| Page sequence | pages are not contiguous 1…n for the current attempt |
| Pagination completed | a request did not end with OverallStatus `OK` |
| Intermediate page sizes | a non-final SOAP page held fewer than 2,500 records (possible gap) |
| Record counts agree | Σ page counts ≠ dataset counter ≠ rows in the archive tables |
| Raw payload integrity | a stored page fails decryption or its SHA-256 differs |
| Duplicates | DE primary keys repeat (fail); identical rows / events are reported (not removed) |
| Field validation | DE rows miss schema fields; non-numeric values in Number/Decimal fields (warn) |
| Unavailable properties | the account rejected requested properties (warn) |
| Independent count | see below |

**Independent counts** (needed for VERIFIED):

- REST resources: Salesforce's reported `count`.
- Tracking: the job's Send counters. These are distinct SentEvents vs NumberSent, distinct openers vs UniqueOpens, distinct clickers vs UniqueClicks, bounces vs Hard+Soft+Other, and unsubscribes vs Unsubscribes.
- Data Extension rows: there is no documented API row count. A Compliance Officer can **Attest source count**, i.e. record the count shown in Contact Builder or Email Studio together with where and when it was read. Without that, DE snapshots are PARTIALLY VERIFIED (limited).

**Statuses:** VERIFIED · PARTIALLY VERIFIED · UNVERIFIED · FAILED · NOT ACCESSIBLE (permission) · NOT RETRIEVABLE (zero events returned for a send older than the configured retention window — *unknown*, not zero).

**Manifests.** Each dataset gets a canonical JSON manifest. It covers the source MID, request properties and filters, dropped properties, every page's hash, the record count, the schema and the verification results. Manifests are hashed and chained per backup through `previousSha256`, and a job manifest closes the chain. **Verify manifest chain** re-hashes all of them.

## Reconciliation (18,000 vs 16,000)

**SEBI Audit Center → New reconciliation** compares an audience with recipient-level send tracking for one or more JobIDs. The audience is either a sealed DE snapshot or an uploaded CSV.

Each audience row gets exactly one classification:

| Classification | Meaning |
|---|---|
| Matched | a SentEvent exists (shows Salesforce processed a send — **not** inbox delivery) |
| No SentEvent — evidence found | no SentEvent; a recipient-level **NotSentEvent** (verified) and/or a *possible explanation*: current non-active subscriber status, membership of a supplied exclusion snapshot, or an UnsubEvent in an earlier job dated before the send |
| Unresolved | no SentEvent and no evidence either way |
| Tracking not retrievable | send tracking for the job is not archived / outside retention |
| Duplicate audience row | 2nd+ row with the same normalised identity |
| Missing / invalid identifier | empty key, or not an email in email mode |
| Tracking, not in audience | a SentEvent for someone absent from the supplied audience |

Evidence levels are kept separate: a recipient-level NotSentEvent is *verified*; subscriber status, exclusion snapshots and earlier unsubscribes are *possible explanations* (they describe state at extraction time). Nothing is ever concluded to be suppressed or excluded without evidence.

**Audience label.** A DE backup is labelled a *current-state copy*. DEs are often overwritten by automations, and the snapshot is frequently taken after the send. It is called a *historical send-time snapshot* only when a user supplies written evidence and attests to it. Their name and statement then appear in every report.

**Output.** The page shows an arithmetic bridge from audience rows to unique recipients with a SentEvent, next to Salesforce's own Send counters (NumberTargeted, Duplicates, MissingAddresses, ExistingUnsubscribes, ExistingUndeliverables, NumberExcluded, NumberSent). Those counters can explain a gap *in aggregate* but cannot be attributed to individuals. Completed reconciliations are immutable; re-running creates a new one.

In the simulated scenario, an 18,000-row DE reconciles to 16,079 unique recipients. The steps are: 35 duplicates, 12 blank keys, NotSentEvents for unsubscribed and held subscribers, 14 seed-list recipients outside the DE, and **1,338 unresolved**. Those 1,338 are exclusion-list members whom Salesforce counted only in `NumberExcluded`, which is exactly the situation the archive is designed to report honestly.

## Evidence packages and exports

- **Evidence package** (campaign or reconciliation): `report.json`, recipient-level CSV, `summary.pdf` and `package-manifest.json`, all stored write-once with SHA-256. Reports always contain these sections: source records, extracted copies (with manifest hashes), derived calculations, assumptions, missing evidence, limitations, methodology, and a disclaimer that the report is for internal review, not a certification.
- **Exports** (CSV or JSONL) are streamed from PostgreSQL in batches, never built in memory. A download link is HMAC-signed, valid for 5 minutes, and bound to the requesting user; the download re-checks the session and permission and is logged.
- **CSV safety:** the default *spreadsheet-safe* CSV prefixes cells starting with `= + - @` TAB or CR with an apostrophe (formula-injection protection). *Raw* CSV and **JSONL** keep exact values. Spreadsheet apps may still strip leading zeros on open — import as text or use JSONL.
- **PDF:** the built-in PDF fonts cover Windows-1252 only. Other characters (e.g. Devanagari) are replaced in the PDF and flagged on the page; the JSON/CSV files hold the exact values.

## Retention and time zones

Retention is **configuration, not code** (Connection → Evidence settings), and each value is marked *confirmed* or *unconfirmed*. Defaults, all from secondary sources and to be confirmed with Salesforce for this account:

| Source | Default | Basis (unconfirmed) |
|---|---|---|
| SOAP tracking / Email Studio tracking | 730 days | Marketing Cloud Engagement data-retention policy effective 16 Jun 2025, as reported by secondary sources |
| Data views (`_Sent`, `_Open`, …) | 180 days | commonly reported ~6 months (not used by the read-only path) |
| Individual Email Results | 90 days | as reported (not used) |

The value is used only to label missing history as NOT RETRIEVABLE. It never deletes data or invents values. Coverage per event type (jobs extracted, verified, not retrievable, not accessible, not yet archived; observed event window) is on the Archive Overview.

**Time stamps:** SOAP often returns wall-clock time without an offset. The connection setting *source timestamp offset* (default UTC−06:00, the widely reported Marketing Cloud system time) is used to interpret them. The raw string is always stored next to the parsed value, and reports state the assumption until it is marked confirmed.

## Manual, authorised workflows

Some data is only reachable by changing the Salesforce account. The archive never does this automatically:

| Need | Why it is not in the read-only path | Authorised manual workflow |
|---|---|---|
| Data views (`_Sent`, `_Open`, `_Click`, `_Bounce`, `_Job`, `_Subscribers`…) | requires a SQL Query Activity writing to a target DE (creates/overwrites objects) | An administrator, with written approval, creates a dedicated DE (e.g. `ARCHIVE_SENT_<date>`) and a one-off query; once it has run, back up that DE here like any other. Record the approval reference in the DE attestation note. Delete the temporary objects afterwards only under the same approval. |
| Tracking Extract / Data Extract | delivers files to Enhanced FTP, which is unavailable | Not available. |
| Anything only visible in UI reports | no API | Export from the UI (e.g. Email Studio → Tracking → export) and upload as an *audience snapshot* with an evidence note, or keep the file with the evidence package. Label: UI export, not API extraction. |

## Architecture

```
Salesforce Archive screens (src/app/(app)/salesforce/*)        REST API (src/app/api/v1/salesforce/*)
        │  server components → services                              │ apiRoute: auth → RBAC → CSRF → rate limit → Zod
        ▼                                                            ▼
src/lib/services/salesforce/
  connections  backups (plan/stage/lease/schedule)  extract (slice/checkpoint/restart)  normalize
  verification  manifests  reconciliation  evidence (reports/PDF/packages)  exports (stream/signed links)
  operations (uploads, attestation)  queries (read side)  audit (archive audit + extraction logs)  health
        │                                                │
src/lib/salesforce/  client (OAuth, limiter, retries)    src/lib/domain/salesforce-reconcile.ts (pure classifier)
  soap (Retrieve codec)  readonly (allow-list)  objects (catalogue)  dates  storage (encrypted write-once store)
  sanitize (template preview)  simulator (dev/test tenant)
        │
PostgreSQL (salesforce_* tables + guard triggers)      Archive store (ARCHIVE_STORAGE_DIR, encrypted)
Queue: sfmc.backup.step · sfmc.reconcile · scheduler.tick (schedules + resume)  — BullMQ worker or inline in dev
```

Tables: `salesforce_connections`, `_business_units`, `_backup_jobs`, `_backup_schedules`, `_backup_datasets`, `_backup_pages`, `_backup_manifests`, `_data_extensions`, `_data_extension_fields`, `_data_extension_rows`, `_subscribers`, `_email_jobs`, `_tracking_events`, `_assets`, `_journeys`, `_automations`, `_reconciliation_jobs`, `_reconciliation_results`, `_evidence_packages`, `_extraction_errors`, `_extraction_logs`, `_archive_audit_logs`. Indexes cover MID, JobID, SubscriberKey, EmailID, DE CustomerKey, EventDate (B-tree + BRIN) and backup job; DE row values have a GIN (`jsonb_path_ops`) index.

**Partitioning.** Not applied yet. At Niveshaay's scale (on the order of tens of millions of tracking rows at most), B-tree and BRIN indexes are sufficient. If `salesforce_tracking_events` grows well past ~100M rows, convert it to range partitions on `event_date` (one per year). Queries already filter by dataset and date.

## Operations

| Task | How |
|---|---|
| Start a backup | Backup Center → choose BUs and data → Start backup (or Schedule recurring, ≥ 6 h) |
| Watch progress | Backup detail page (auto-refreshes); progress is counts of pages and records, with a percentage only when Salesforce reports a total |
| Interrupted worker | Automatic: the scheduler tick resumes backups with an expired lease; or press **Resume** |
| Failed datasets | **Retry failed** re-extracts them as new datasets; the failed ones stay sealed for the record |
| Production worker | `npm run worker` with `REDIS_URL` (same worker as campaigns) |
| Storage | `ARCHIVE_STORAGE_DIR` (default `~/.niveshaay-cc/archive`). Put it on encrypted, backed-up storage. `ARCHIVE_ENCRYPTION_KEY` (optional, 32-byte base64) separates archive encryption from credential encryption — **losing the key makes the archive unreadable**; escrow it. |
| Demo data (dev only) | `npm run db:seed:salesforce` — simulated tenant, full pipeline. Rows are immutable once sealed, so use a database you are happy to keep it in. |
| Retention purge | Only via a deliberate transaction with `SET LOCAL ncc.retention_purge = 'on'`; record the approval in the audit log first. |

## Database encoding

The archive requires a **UTF8** database. On Windows, the embedded local PostgreSQL inherits the ANSI code page (**WIN1252**) unless told otherwise. WIN1252 cannot store ₹, Devanagari or emoji, which affects client names in the existing app as well as archived Salesforce data. Live backups are blocked on a non-UTF8 database, and the Archive Overview shows a warning.

`scripts/local-postgres.mjs` now creates UTF8 databases for **new** setups. An existing local database has to be recreated:

```bash
# 1. stop `npm run dev`; keep `npm run db:start` running
# 2. back up anything you need from the old dev DB (it contains only dev/mock data by default)
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:'postgresql://postgres:postgres@localhost:5433/postgres'}}});(async()=>{await p.\$executeRawUnsafe('DROP DATABASE niveshaay_cc WITH (FORCE)');await p.\$executeRawUnsafe(\"CREATE DATABASE niveshaay_cc TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'\");await p.\$disconnect()})()"
npx prisma migrate deploy && npm run db:seed
# 3. re-enter integration credentials (DoubleTick / Zoho) in Integrations
```

Production via `docker-compose` uses the official PostgreSQL image, which defaults to UTF8. Confirm with `SHOW server_encoding;`.

## Testing

`npm test` runs everything against a real PostgreSQL test database and the in-process simulator. That is the same wire protocol as production (OAuth token, SOAP Retrieve and ContinueRequest, REST paging, SOAP faults), so no network access is needed. Coverage of the requested cases:

| Case | Test |
|---|---|
| DE with more than one retrieval page | `salesforce-archive.test.ts` › backup › multi-page rows |
| Interrupted extraction and resume | › restarts cleanly when a continuation is interrupted |
| Duplicate subscriber keys / duplicate tracking events | › reconciliation (duplicates); › tracking (duplicate SentEvent rows kept and reported) |
| Same subscriber in multiple campaigns | › tracking timeline & simulator jobs share subscribers |
| Multiple Business Units | › connection › discovers BUs (per-MID tokens via `account_id`) |
| Expired OAuth token / API rate limit / 5xx | › retries rate limits and refreshes expired tokens |
| Partial tracking retention | › old jobs are NOT RETRIEVABLE |
| Missing historical audience snapshot | › audience labelled CURRENT_STATE without evidence |
| 18,000 vs 16,000 | › decomposes the audience-to-send gap and keeps unexplained records UNRESOLVED (full scale via `npm run db:seed:salesforce`) |
| Missing API permissions | › records missing permissions; › NOT_ACCESSIBLE datasets never VERIFIED |
| Backup verification failure | unit/integration: hash, count, sequence checks; immutability triggers |
| Export of large datasets | `salesforce-evidence.test.ts` › exports (streamed); full-scale demo exported 1,338-row and 18,000-row files |
| Archive integrity verification | › manifest chain; › evidence package hashes |
| Read-only source protection | `salesforce.test.ts` › read-only guarantee; integration asserts every SOAP call was a Retrieve |

## Known limitations and open items

- **Not yet run against the real Niveshaay tenant.** Everything is verified against the simulator, which follows the documented protocol. The first live run should be a small backup (one BU, metadata + one DE + one JobID). Check the dropped-property list, the timestamp offset and the retention behaviour before running a full backup.
- Salesforce's developer documentation blocks automated fetching. Object property names were taken from the official SOAP object references as surfaced in search results and from long-standing usage. Unknown properties are handled automatically (dropped and recorded), not assumed.
- Data Extension row counts cannot be verified through the API; use **Attest source count**.
- Journey per-contact history, automation run history and full automation activity definitions are not exposed by the documented read APIs; this is recorded as gaps on each item.
- The archive store has a local encrypted driver only. For production, use encrypted, backed-up storage for `ARCHIVE_STORAGE_DIR`, or add an S3-compatible driver with object lock (the `putObject`/`getObject` interface is the only seam).
- External images referenced by templates are listed but not downloaded (they are often tracking URLs); they will break when the account closes.
