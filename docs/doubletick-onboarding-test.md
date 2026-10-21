# DoubleTick onboarding bot: test module

**Temporary.** This module tests DoubleTick's `onboarding_entity_type` bot from this test dashboard. When the flow is confirmed, it moves to the live dashboard and everything below is removed from here.

## What it does

The **Onboarding bot (test)** page (Administration → Onboarding bot) sends
`POST https://bothook.io/v1/public/triggers/webhooks/<trigger id>`
with the header `Authorization: <trigger key>` and the body `{ "customerPhone": "919XXXXXXXXX", "customerName": "Name" }`.
DoubleTick's bot then sends the welcome WhatsApp message with the entity-type options.

## Safety rules (enforced on the server)

- **Hard send lock** (`src/lib/send-allowlist.ts`). Real WhatsApp messages and emails can go **only to the recipients listed in `config/send-allowlist.local.json`**. This local file is git-ignored because it holds personal data; `config/send-allowlist.example.json` shows the format. If the file is missing, every real send is blocked. This covers this trigger, the dashboard's DoubleTick sending and Zoho email, whatever the other settings are.

- Real calls go **only to internal test recipients** who are also on the local allowlist.
- Real clients are refused unless `ALLOW_LIVE_SEND=true` **and** DoubleTick is in LIVE mode. Even then, the client must have WhatsApp consent and must not be suppressed.
- Every real call needs a typed `SEND` confirmation.
- No automatic retries. The same number is blocked for 10 minutes after a successful trigger.
- The bot's own Authorization Key is used. The main DoubleTick API key is never sent to bothook.io.
- Every preview, send, failure and blocked attempt is written to the audit log.
- The trigger returns no message ID. Confirm delivery on the phone, or through DoubleTick status webhooks once they are registered.

## Removal checklist (after testing)

Delete:
- `src/lib/services/onboarding-trigger.ts`
- `src/app/api/v1/automations/` (folder)
- `src/app/(app)/automations/` (folder)
- `tests/integration/onboarding-trigger.test.ts`
- `src/lib/services/test-send-jay.ts` and `scripts/test-email-page.mjs` (email + WhatsApp test to Jay via a temporary Cloudflare tunnel)
- `src/lib/send-allowlist.ts` and `config/send-allowlist.local.json` **only with the owner's approval**; also remove the imports in `onboarding-trigger.ts`, `providers/doubletick/client.ts` and `providers/zoho/marketing-automation.ts`
- this file

Edit:
- `src/components/app/nav.ts`: remove the "Onboarding bot (test)" line and the `BotIcon` import.
- `src/lib/env.ts`: remove the two `DOUBLETICK_ONBOARDING_*` lines.
- `.env` and `.env.example`: remove the `TEST MODULE: DoubleTick onboarding` block. That deletes the trigger URL and key from this machine.

Then:
- Settings → Test recipients: remove the test recipients if this dashboard is kept.
- Run `npm run typecheck && npm test` to confirm a clean removal.

Audit-log entries (`automation.onboarding_trigger`) stay. The audit log is append-only by design.

## Carrying it to the live dashboard

Store the trigger URL and key as encrypted secrets, not in `.env`. Call the trigger only from approved flows that apply the same checks: consent, suppression, duplicate protection and audit logging. Register DoubleTick's status webhook so delivery can be tracked.
