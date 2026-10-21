# Compliance controls

The controls below are technical. **Legal and compliance must review them before production use.** They are designed for an Indian SEBI-registered entity: a Research Analyst or Investment Adviser. Confirm which regulations apply to Niveshaay.

## Consent & preferences

- Consent is recorded per client and per channel, append-only, with source and evidence. The latest record wins.
- **WhatsApp** requires an explicit opt-in record by default, in line with WhatsApp Business policy.
- **Email** is allowed unless the client is opted out (configurable to opt-in). Zoho CRM `Email_Opt_Out`, recorded revocations, and Zoho MA unsubscribe reports are always honoured. Provider unsubscribes automatically become a consent revocation plus a suppression.
- The suppression list (per channel or all channels) covers DND, complaints, hard bounces, legal holds and manual entries. It overrides consent.

## Governance

- **Maker-checker.** The approver must differ from the creator and the submitter, and must re-type the exact message count. Live campaigns require an extra explicit confirmation.
- **Frozen evidence.** Each approved campaign stores what was approved, for whom, with which template version, and why each client was included or excluded. Database triggers make this immutable.
- **Audit trail.** Logins, membership changes, consent changes, template versions, approvals, executions, provider responses (masked), delivery status changes, retries and reconciliation are all logged. The log is append-only at database level.
- **Purpose tagging.** Every campaign records a purpose (research update, advisory, disclosure, marketing and so on). Marketing campaigns show a compliance warning in the wizard.
- **Disclosures.** The SEBI registration line and disclaimer configured in Settings are appended to every hosted email. A missing disclaimer blocks live email campaigns.
- **Quiet hours** (default 21:00–08:00 IST). Live execution is deferred during this window.

## Data protection (DPDP Act 2023 alignment, to be confirmed by counsel)

- Data minimisation: only CRM fields needed for identity, contact and configured rules are mirrored.
- PII is masked in logs, audit metadata and stored webhook payloads. Secrets are encrypted at rest.
- Exports are permission-gated and audited. CSV exports neutralise spreadsheet formula injection.
- Client data is never sent to providers beyond what the channel needs: email address, phone number and template parameters.

## Retention defaults (configurable in Settings)

- Campaign records: 5 years (minimum enforced). SEBI RA regulations require records be maintained for at least five years.
- Audit log: 8 years (minimum 5).
- Raw webhook payloads: 180 days.
- Sessions: 30 days.

## Items for legal & compliance review

1. Wording and placement of SEBI registration details and disclaimers for email and WhatsApp. WhatsApp templates must include them in the Meta-approved body.
2. Whether research or recommendation communications need additional record-keeping, for example archiving rendered content per recipient. Rendered WhatsApp payloads are stored per recipient; email content is stored per template version.
3. Lawful basis and consent evidence standard for existing clients (DPDP Act), including notice and withdrawal mechanics.
4. Data residency of providers (Zoho DC choice, DoubleTick hosting) and data processing agreements.
5. Retention periods and deletion procedures for client data once a client leaves.
6. TRAI / DND considerations if SMS or other channels are added later.

## Salesforce archive evidence

Historical Salesforce Marketing Cloud communications are preserved in the read-only Salesforce Archive. Its reports separate source records, extracted copies, derived calculations, assumptions, missing evidence and retention limitations, and never certify compliance. Access and exports are logged in `salesforce_archive_audit_logs` (append-only). Items for legal review: confirm the SFMC tracking retention period with Salesforce for this account, and decide the retention period for the archive itself (the archive keeps everything until an explicit, audited purge). See [salesforce-archive.md](salesforce-archive.md).
