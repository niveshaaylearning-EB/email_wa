# REST API

**Request rules**
- Base path: `/api/v1`. All endpoints need a session cookie (`POST /api/auth/login`).
- Mutations need the header `x-ncc-request: 1` and a same-origin `Origin`.
- Bodies are JSON and validated with the Zod schemas in `src/lib/contracts/index.ts`.

**Responses**
- Success: `{ "data": … }`
- Error: `{ "error": { code, message, details? } }`, with these statuses:
  - 400 bad request
  - 401 unauthenticated
  - 403 forbidden or CSRF failure
  - 404 not found
  - 409 conflict or invalid state
  - 422 validation failed
  - 429 rate limited

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` | — | Session |
| `GET /api/health` | — | DB/queue health |
| `GET,POST /categories` | categories:read / write | List (`q`, `archived=1`) / create |
| `GET,PATCH /categories/:id` · `POST …/archive` · `POST …/restore` | categories | Detail / edit / archive (blocked if used by active campaigns) |
| `POST /categories/:id/import` | categories:write | CSV membership import `{csv, dryRun}`, which returns row-level results |
| `POST /categories/:id/rules` · `DELETE /rules/:id` · `POST /rules/:id/evaluate` · `POST /rules/preview` | categories | Dynamic rules |
| `POST /memberships` · `POST /memberships/remove` | clients:write | Bulk add/remove `{clientIds[], categoryIds[], note?}` |
| `GET /clients` · `GET /clients/ids` · `GET /clients/export` · `GET /clients/:id` | clients:read | Directory (filters: `q, categoryId, uncategorized, contact, consent, status, duplicates, page, pageSize, sort, dir`), all matching IDs, CSV export, profile |
| `POST /consents` | clients:write | Append consent `{clientId, channel, status, source, evidence}` |
| `GET,POST /suppressions` · `POST /suppressions/:id/lift` | clients:read / suppression:write | Suppression list |
| `GET,POST /templates` · `GET,PUT /templates/:id` · `POST …/archive` · `POST …/render` | templates | Registry; each content change creates a new version |
| `POST /template-mappings` · `POST /template-mappings/remove` | templates:write | Authorise a template for a category |
| `GET,POST /campaigns` · `GET,PUT,DELETE /campaigns/:id` | campaigns | List / draft create / analytics / draft update (`expectedVersion` optimistic lock) / delete draft |
| `GET /campaigns/:id/preview` | campaigns:read | Live audience, validation, overlap review items, sample mapping |
| `POST /campaigns/:id/review` | campaigns:write | Overlap decisions `{decisions:[{clientId, channel, decision:{categoryId}|{exclude:true}}]}` |
| `POST /campaigns/:id/submit` · `…/withdraw` · `…/duplicate` · `…/test-send` | campaigns:write | Workflow |
| `POST /campaigns/:id/approve` | campaigns:approve | `{confirmMessageCount, confirmLive, note?}`, enforcing maker-checker; freezes the snapshot |
| `POST /campaigns/:id/reject` | campaigns:approve | `{reason}` |
| `POST /campaigns/:id/pause` · `…/resume` · `…/cancel` | campaigns:execute | Execution control (`cancel` needs `{reason}`) |
| `GET /campaigns/:id/recipients` · `GET /campaigns/:id/report` | campaigns:read / analytics:read | Per-recipient deliveries with events / CSV report |
| `GET /analytics/overview?days=` | analytics:read | KPIs, trends, category performance |
| `GET /integrations` · `PATCH /integrations/:provider` · `POST …/test?real=1` · `POST …/disconnect` | integrations | Masked view / config, secrets, mode / non-sending connection test / revoke Zoho |
| `GET /api/integrations/zoho/connect?provider=` · `GET /api/integrations/zoho/callback` | integrations:write | OAuth |
| `POST /sync/crm` · `GET /sync/runs` | sync:run / integrations:read | Manual CRM sync `{full?}` / history |
| `GET,POST /users` · `PATCH /users/:id` | users:manage | Users & roles |
| `GET,POST /test-recipients` · `DELETE /test-recipients/:id` | campaigns:read / settings:write | Internal test recipients |
| `GET,PATCH /settings` | campaigns:read / settings:write | Branding, consent policy, safety, retention, disclosures |
| `GET /audit` | audit:read | Audit log query |
| `POST /api/webhooks/doubletick/status` | Bearer secret | DoubleTick status webhook |
| `GET /api/public/email-content/:token` | token | Frozen email HTML for Zoho MA |

### Salesforce Archive (`/api/v1/salesforce/*`, read-only towards Salesforce)

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET,POST /connections` · `PATCH,DELETE /connections/:id` | archive:read / archive:manage | Masked connection view / configure (secrets encrypted) / erase credentials |
| `POST /connections/:id/test` | archive:manage | Authenticate + one read probe per capability |
| `POST /connections/:id/business-units` `{action: discover\|select\|add}` | archive:manage | BU discovery and selection |
| `GET,POST /backups` · `GET /backups/:id` | archive:read / archive:manage | List / start a backup / status (counts, never invented percentages) |
| `POST /backups/:id/{cancel\|resume\|retry}` · `POST /backups/:id/manifest-chain` | archive:manage / archive:read | Controls / re-hash and check the manifest chain |
| `GET,POST /schedules` · `PATCH /schedules/:id` | archive:read / archive:manage | Recurring incremental backups |
| `GET /datasets?status=&kind=` · `POST /datasets/:id/reverify` | archive:read / archive:reconcile | Dataset inventory with checks / re-verify |
| `POST /data-extensions/:id/attest` `{count, note}` | archive:reconcile | Record the Salesforce UI row count (independent source count) |
| `GET /campaigns?q=&mid=&from=&to=` | archive:read | Archived send jobs |
| `GET /tracking?subscriberKey=&jobId=&eventType=&from=&to=[&timeline=1]` | archive:read | Recipient-level events / subscriber timeline (views logged) |
| `GET,POST /reconciliations` · `GET /reconciliations/:id` | archive:read / archive:reconcile | Audience ↔ tracking reconciliation / structured report |
| `POST /uploads` (multipart `file`, `meta`) | archive:reconcile | Upload an independently preserved audience CSV |
| `GET,POST /evidence` | archive:read / archive:reconcile | Evidence packages |
| `POST /exports` → `GET /download?token=` | archive:export | 5-minute, user-bound signed download (CSV safe/raw, JSONL); every export logged |
| `GET /assets/:id/preview[?images=1\|source=1]` | archive:read | Sanitised, sandboxed template preview (script-free CSP) |
| `GET /logs[?errors=1]` | archive:read | Extraction logs / API errors |

## Roles

| Role | Can |
|---|---|
| Administrator | Everything, including integrations, LIVE mode, users and settings |
| Campaign Creator | Clients and memberships, categories, templates, draft and submit campaigns, test sends, pause/cancel, CRM sync |
| Approver | Read everything, approve or reject (never their own), pause/cancel, audit log, suppressions |
| Viewer | Read-only clients, categories, templates, campaigns, analytics, integrations |
| Compliance Officer | Viewer access plus the Salesforce Archive: read, export, reconcile, evidence packages, audit log. No campaign changes, no backup control |

Only Administrators can configure the Salesforce connection and run backups (`archive:manage`). Viewers, Campaign Creators and Approvers have no access to archived Salesforce data.
