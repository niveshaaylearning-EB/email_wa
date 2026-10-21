/** Human explanations for failure codes recorded by the orchestration layer. */
export const FAILURE_EXPLANATIONS: Record<string, string> = {
  UNCONFIRMED_SUBMISSION:
    "The provider’s response was ambiguous (timeout after sending or HTTP 5xx). Not retried automatically to avoid duplicate messages — check DoubleTick before any manual resend.",
  RETRIES_EXHAUSTED: "Temporary errors (rate limiting / service unavailable) persisted through all retry attempts.",
  PROVIDER_REJECTED: "DoubleTick rejected the message (e.g. template/parameter mismatch or recipient not on WhatsApp).",
  PROVIDER_FAILED: "DoubleTick reported delivery failure via webhook. See per-recipient reason.",
  PROVIDER_ERROR: "The provider API returned an error. See per-recipient detail.",
  NO_SENDER: "The sender number / from-address is not configured in Integrations.",
  INVALID_SNAPSHOT: "The frozen recipient snapshot lacked a contact or rendered template.",
  LIST_SYNC_FAILED: "Adding recipients to the isolated Zoho list failed, so the email group was not sent.",
  AUDIENCE_VERIFICATION_FAILED: "The Zoho list did not contain exactly the frozen audience, so the email group was not sent.",
  NO_SUBJECT: "The frozen email template has no subject.",
  SENTHARDBOUNCE: "Hard bounce reported by Zoho — the address was added to the suppression list.",
  SENTSOFTBOUNCE: "Soft bounce reported by Zoho (temporary mailbox issue).",
  SIMULATED_BOUNCE: "Simulated bounce from the MOCK adapter (not real).",
};
