// Browser-safe labels (no Node imports).
import type { ExclusionReasonKey } from "./eligibility";

export const EXCLUSION_LABELS: Record<ExclusionReasonKey, string> = {
  MISSING_EMAIL: "Missing email",
  MISSING_PHONE: "Missing phone",
  INVALID_EMAIL: "Invalid email",
  INVALID_PHONE: "Invalid phone",
  UNSUBSCRIBED: "Unsubscribed",
  NO_CONSENT: "No recorded consent",
  SUPPRESSED: "On suppression list",
  CRM_OPT_OUT: "CRM email opt-out",
  CONFLICT_EXCLUDED: "Template conflict (excluded)",
  CONFLICT_UNRESOLVED: "Template conflict (needs review)",
  CLIENT_INACTIVE: "Inactive / deleted in CRM",
  DUPLICATE_IDENTITY: "Duplicate contact",
  MISSING_TEMPLATE_DATA: "Missing template data",
};
