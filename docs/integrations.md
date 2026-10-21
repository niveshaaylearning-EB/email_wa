# Provider integrations

Researched against official documentation on 2026-10-16. Items marked **UNVERIFIED** are not stated in the official docs. The code treats them conservatively and makes them configurable. Confirm each one in staging with real credentials.

## Zoho OAuth (shared by CRM and Marketing Automation)

**How the flow works**
- Server-based web client with `access_type=offline` and `prompt=consent`. Scopes:
  - CRM: `ZohoCRM.modules.contacts.READ`, `ZohoCRM.coql.READ`, `ZohoCRM.settings.fields.READ`
  - MA: `ZohoMarketingAutomation.campaign.ALL`, `ZohoMarketingAutomation.lead.ALL`
- The callback receives `code`, `location` and `accounts-server`. The accounts server is accepted only if it belongs to a known Zoho DC; the list includes the Canada DC `accounts.zohocloud.ca`.
- The token response's `api_domain` sets the CRM host, so regional CRM domains never need to be hard-coded.

**Token handling**
- Access tokens last 1 hour and are refreshed only when less than 2 minutes remain. Concurrent refreshes are coalesced, because Zoho allows at most 10 refreshes per 10 minutes per refresh token.
- A 401 triggers one forced refresh and a retry.
- Tokens are stored encrypted; revocation is done on disconnect.

**Setup**
1. Open the API Console for your DC (e.g. `https://api-console.zoho.in`) and create a *Server-based Application*.
2. Set the redirect URI to `{APP_URL}/api/integrations/zoho/callback`.
3. In Integrations, enter the client ID and secret, then click **Connect**, then **Test connection**.
4. Switch the mode: MOCK, then DRY-RUN. For CRM, which is read-only, LIVE simply means "use the real account".

## Zoho CRM v8 (read-only)

Docs: get-records.html, get-deleted-records.html, api-limits.html

**What the code does**
- Calls `GET /crm/v8/Contacts` with an explicit `fields` list (at most 50), `per_page=200`, and `sort_by=Modified_Time&sort_order=asc`.
- Always paginates with `page_token`, because `page` cannot go past 2,000 records.
- Incremental sync sends `If-Modified-Since` with an IST offset, using the latest stored `Modified_Time`. An HTTP 304 or 204 means no changes.
- Incremental runs also call `GET /crm/v8/Contacts/deleted?type=all` and mark deleted clients `deleted_in_crm_at`; those are excluded from campaigns and their history is kept.
- Mapping: `Mobile` (falling back to `Phone`) is normalised to E.164, defaulting to India; numbers missing the "+" are tolerated. `Email` is normalised, and `Email_Opt_Out` is honoured as an email opt-out.
- Optional status, city and extra fields can be configured for dynamic rules.
- Duplicate identities: an exact email match between CRM records flags the newer record as a duplicate of the oldest. A shared phone number is shown as a possible duplicate and deduplicated per campaign.

**UNVERIFIED**
- The exact `If-Modified-Since` filter semantics. Run a full re-sync periodically if needed (Integrations, or `POST /api/v1/sync/crm {"full": true}`).
- Field API names `Email`, `Phone`, `Mobile` and `Owner` (standard names). Verify them with `GET /crm/v8/settings/fields?module=Contacts`.

## Zoho Marketing Automation v1

**Base URL and conventions**
- Base: `https://marketingautomation.zoho.com/api/v1/`.
- Regional hosts are **UNVERIFIED**. The UI pre-fills `marketingautomation.zoho.<tld>` and flags it, and the value can be edited.
- Requests are form-encoded with `resfmt=JSON`.
- The client self-throttles to about 460 calls per 5 minutes. The documented limit is 500 per 5 minutes per API, and exceeding it locks that API for 30 minutes.

| Step | Endpoint | Notes |
|---|---|---|
| Create isolated list + first ≤10 emails | `POST addlistandleads` | `signupform=private`, `mode=newlist` |
| Add remaining emails | `POST addleadsinbulk` | **at most 10 emails per call** (documented) |
| Verify list size | `GET getmailinglists` | match `listkey`, compare `noofleads` |
| Create campaign | `POST createCampaign` | `content_url` = dashboard-hosted frozen HTML; `list_details={listkey:[]}` |
| Send | `POST sendcampaign?campaignkey=` | |
| Report | `campaignreports` | sent, delivered, opens, clicks, bounces, unsubscribes |
| Recipient data | `POST getcampaignrecipientsdata` | `sentleads`, `openedleads`, `clickedleads`, `optoutleads`, `senthardbounce`, `sentsoftbounce` |

**Limitations reflected in the design**
- Content can only be supplied as a public `content_url`; no API to attach an existing template was found. The dashboard therefore hosts approved, version-frozen HTML at `/api/public/email-content/{unguessable token}`. The URL is served only for approved campaigns and is not indexed.
- Bulk add accepts email addresses only. Email templates may use campaign-level variables only; put per-recipient merge tags inside Zoho content if you need them.
- Zoho reports per-recipient *sent*, *opened*, *clicked* and *bounced*, but not per-recipient *delivered*. The dashboard shows delivered only at campaign level, from the report.
- No email-event webhooks are documented, so reconciliation polls the reports.
- No single-recipient test-send API is documented. Test sends for email are an assisted workflow: preview here, then use "Send test email" in Zoho.
- **UNVERIFIED**:
  - Whether `addleadsinbulk` triggers a double opt-in confirmation email. If it does, the list-count check fails and the group is not sent (fail-safe). Confirm in staging.
  - Response key casing (sample responses in the docs are old).

## DoubleTick WhatsApp

**Base and auth**
- Base URL: `https://public.doubletick.io`.
- Auth header: `Authorization: <apiKey>`. The docs also show `key <apiKey>`; this is configurable. The provided key **passed the non-sending probe using the raw format** on 2026-10-16.

**Send**
- Endpoint: `POST /v2/whatsapp/message/template` with
  `{messages:[{from,to,content:{templateName,language,templateData:{header,body:{placeholders:[{k:v}]},buttons:[{type:"URL",parameter}]}},customData}]}`.
- Response 201: `messages[].status` is `SENT`, `ENQUEUED` or `FAILED`, plus `messageId`. This is recorded as **provider accepted**, not delivered.
- V2 accepts no client `messageId`, and idempotency is not documented. Duplicate sends are prevented on our side by a unique assignment key and a database claim before each call. Correlation uses `customData.nccDeliveryId`.

**Webhooks**
- Status webhook: `MESSAGE_STATUS_UPDATE` → `POST {APP_URL}/api/webhooks/doubletick/status`, with payload `{messageId,to,status,statusTimestamp,failMessage?,…customData}`.
- **Authenticity:** DoubleTick documents no signature or HMAC. Register the webhook with `authorization: {type: "BEARER", payload: DOUBLETICK_WEBHOOK_SECRET}`. The receiver compares this in constant time and rejects (401) and logs anything else. Serve it over HTTPS only.
- Duplicate and out-of-order webhooks are deduplicated and applied forward-only. If a webhook arrives before the send response is stored, it is retried internally.

**Other notes**
- Connection test: `GET /whatsapp/message/status?messageId=<random uuid>`. A 404 means the key was accepted. This endpoint is limited to 1 request per second, so it is not used for bulk polling.
- Rate limit: about 600 template sends per second (help-center figure). The default throttle is 600 per minute and can be configured.
- Language codes in the V2 enum: `en`, `en_US`, `en_GB`, `pt_BR`, `es`, `id`.
- Templates are created and approved in DoubleTick/Meta. Register the name and language in the Template Library.

**UNVERIFIED**: webhook retry and backoff behaviour, the expected response code, ordering guarantees, and whether a 429 is returned on the send endpoint.

## Go-live checklist (per provider)

1. Enter credentials, then **Test connection** (green).
2. Mode **DRY-RUN**. Run a real campaign end to end: approval, rendering, recipient mapping, with no sends.
3. Add internal test recipients. Set `ALLOW_LIVE_SEND=true` **on staging only**, switch the provider to LIVE, and test-send to internal recipients.
4. Verify webhooks arrive and update statuses. For email, verify the list count, the hosted content, and report reconciliation.
5. Complete the compliance review ([compliance.md](compliance.md)), then enable in production.
