# Deployment

## Topology

- **app**: `next start`, stateless. Can be scaled horizontally once `REDIS_URL` is set; Redis backs rate limiting and the queue.
- **worker**: `npm run worker`. Runs one or more instances and owns the once-a-minute scheduler. Set `WORKER_CONCURRENCY` (default 5).
- **PostgreSQL 15+** with daily backups and PITR. **Redis 7** with AOF persistence.
- A TLS reverse proxy in front of the app. HTTPS is required for OAuth callbacks, webhooks and secure cookies.

## Staging (Docker Compose)

```bash
cp .env.example .env.staging
# Set: APP_URL=https://ncc-staging.example.com, POSTGRES_PASSWORD, CREDENTIALS_ENCRYPTION_KEY,
#      ZOHO_* (staging API-console app), DOUBLETICK_* ; keep ALLOW_LIVE_SEND=false
docker compose --env-file .env.staging up -d --build
docker compose exec app node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(console.log)"
```

**Create the first administrator.** The seed is development-only and refuses to run in production.

```bash
docker compose exec -e ADMIN_EMAIL=you@niveshaay.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD='<12+ chars, Aa1>' app npm run admin:create
```

Then sign in, add the remaining users in Settings, and follow the per-provider go-live checklist in [integrations.md](integrations.md).

## Environment

See `.env.example`. Key settings:

| Variable | Notes |
|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes, base64. Losing it makes stored secrets unreadable; rotating it requires re-entering them. Keep it in a secret manager. |
| `ALLOW_LIVE_SEND` | Master kill-switch. `false` everywhere except an approved production deployment. |
| `LIVE_SEND_MAX_RECIPIENTS` | Hard cap per live campaign. |
| `APP_URL` | Public HTTPS URL. Used for OAuth redirects, webhooks and hosted email content. |

## Production hardening checklist

- [ ] HTTPS only. HSTS is already sent; also set it at the proxy.
- [ ] Restrict the DoubleTick API key to the server's egress IP. Use a long random webhook secret.
- [ ] Database: least-privilege app user, encrypted at rest, PITR backups, tested restore.
- [ ] Redis is private (no public bind) and password protected.
- [ ] Ship logs to central storage (the app already masks PII). Alert on `campaign.auto_paused`, `campaign.email_group_failed`, `UNCONFIRMED_SUBMISSION` and integration `ERROR` status.
- [ ] Run `prisma migrate deploy` in the release pipeline before rolling out the app and worker.
- [ ] Complete the compliance sign-off ([compliance.md](compliance.md)). Fill in the SEBI registration line and email disclaimer in Settings.
- [ ] Only then set `ALLOW_LIVE_SEND=true` and switch providers to LIVE (admin only, typed confirmation).

## Operations

- **Pausing everything.** Set `ALLOW_LIVE_SEND=false` and restart. Running live campaigns auto-pause at their next send step, and nothing else can send.
- **Unconfirmed WhatsApp submissions** (`UNCONFIRMED_SUBMISSION`). Check the message in DoubleTick before any manual resend. These are never retried automatically.
- **Email group failed verification.** Inspect the Zoho list named in the campaign's reconciliation table and fix it. Then duplicate the campaign to re-run.
- **Retention.** Session and webhook-payload retention run in the scheduler tick. Campaign and audit records are kept at least 5 years. Audit deletions require a deliberate DB-level override (`SET LOCAL ncc.retention_purge = 'on'`) and should go through change control.
