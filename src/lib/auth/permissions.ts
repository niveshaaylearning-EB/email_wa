export type RoleKey = "ADMIN" | "CAMPAIGN_CREATOR" | "APPROVER" | "VIEWER" | "COMPLIANCE_OFFICER";

export const PERMISSIONS = [
  "clients:read",
  "clients:write",
  "categories:read",
  "categories:write",
  "templates:read",
  "templates:write",
  "campaigns:read",
  "campaigns:write",
  "campaigns:approve",
  "campaigns:execute",
  "analytics:read",
  "audit:read",
  "integrations:read",
  "integrations:write",
  "sync:run",
  "suppression:write",
  "users:manage",
  "settings:write",
  // Salesforce Marketing Cloud archive (read-only backup of the legacy platform)
  "archive:read", // browse archived Salesforce data (contains client personal data)
  "archive:export", // download CSV/JSONL/PDF exports and evidence packages
  "archive:reconcile", // run reconciliations, generate evidence packages, attest source counts
  "archive:manage", // Salesforce connection, credentials, backup jobs and schedules
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = [
  "clients:read",
  "categories:read",
  "templates:read",
  "campaigns:read",
  "analytics:read",
  "integrations:read",
];

export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  CAMPAIGN_CREATOR: [
    ...READ,
    "clients:write",
    "categories:write",
    "templates:write",
    "campaigns:write",
    "campaigns:execute",
    "suppression:write",
    "sync:run",
  ],
  APPROVER: [...READ, "campaigns:approve", "campaigns:execute", "audit:read", "suppression:write"],
  VIEWER: READ,
  COMPLIANCE_OFFICER: [...READ, "audit:read", "archive:read", "archive:export", "archive:reconcile"],
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  ADMIN: "Administrator",
  CAMPAIGN_CREATOR: "Campaign Creator",
  APPROVER: "Approver",
  VIEWER: "Viewer",
  COMPLIANCE_OFFICER: "Compliance Officer",
};

export const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  ADMIN: "Full access including integrations, users, settings and live-send enablement.",
  CAMPAIGN_CREATOR: "Manages categories, memberships and templates; drafts and submits campaigns.",
  APPROVER: "Reviews and approves or rejects campaigns (cannot approve own campaigns).",
  VIEWER: "Read-only access to clients, campaigns and analytics.",
  COMPLIANCE_OFFICER: "Read-only access plus the Salesforce archive: audit evidence, reconciliations and exports. Cannot send or change campaigns.",
};

export function hasPermission(role: RoleKey, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
