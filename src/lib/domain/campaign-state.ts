/**
 * Campaign lifecycle state machine. All status changes go through `assertTransition`
 * so the API, the worker and the tests share one definition of what is legal.
 *
 *  DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──queue──▶ QUEUED ──▶ RUNNING ──▶ COMPLETED
 *    ▲                     │                          │  └─schedule─▶ SCHEDULED ──due──▶ QUEUED
 *    └──────revise─────────┴──reject──▶ REJECTED      │
 *  RUNNING ⇄ PAUSED; any pre-completion state ──cancel──▶ CANCELLED; RUNNING ──error──▶ FAILED
 */
export type CampaignStatusKey =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "REJECTED"
  | "APPROVED"
  | "SCHEDULED"
  | "QUEUED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type CampaignAction =
  | "edit"
  | "submit"
  | "withdraw"
  | "approve"
  | "reject"
  | "revise"
  | "schedule"
  | "queue"
  | "start"
  | "pause"
  | "resume"
  | "complete"
  | "fail"
  | "cancel";

const TRANSITIONS: Record<CampaignAction, { from: CampaignStatusKey[]; to: CampaignStatusKey | null }> = {
  edit: { from: ["DRAFT", "REJECTED"], to: null },
  submit: { from: ["DRAFT", "REJECTED"], to: "PENDING_APPROVAL" },
  withdraw: { from: ["PENDING_APPROVAL"], to: "DRAFT" },
  approve: { from: ["PENDING_APPROVAL"], to: "APPROVED" },
  reject: { from: ["PENDING_APPROVAL"], to: "REJECTED" },
  revise: { from: ["REJECTED"], to: "DRAFT" },
  schedule: { from: ["APPROVED"], to: "SCHEDULED" },
  queue: { from: ["APPROVED", "SCHEDULED"], to: "QUEUED" },
  start: { from: ["QUEUED"], to: "RUNNING" },
  pause: { from: ["QUEUED", "RUNNING", "SCHEDULED"], to: "PAUSED" },
  resume: { from: ["PAUSED"], to: "QUEUED" },
  complete: { from: ["RUNNING"], to: "COMPLETED" },
  fail: { from: ["QUEUED", "RUNNING"], to: "FAILED" },
  cancel: {
    from: ["DRAFT", "PENDING_APPROVAL", "REJECTED", "APPROVED", "SCHEDULED", "QUEUED", "RUNNING", "PAUSED"],
    to: "CANCELLED",
  },
};

export class TransitionError extends Error {
  constructor(
    public action: CampaignAction,
    public from: CampaignStatusKey,
  ) {
    super(`Cannot ${action} a campaign that is ${from.replace(/_/g, " ").toLowerCase()}.`);
  }
}

export function canTransition(action: CampaignAction, from: CampaignStatusKey): boolean {
  return TRANSITIONS[action].from.includes(from);
}

export function assertTransition(action: CampaignAction, from: CampaignStatusKey): CampaignStatusKey {
  if (!canTransition(action, from)) throw new TransitionError(action, from);
  return TRANSITIONS[action].to ?? from;
}

export function allowedActions(from: CampaignStatusKey): CampaignAction[] {
  return (Object.keys(TRANSITIONS) as CampaignAction[]).filter((a) => canTransition(a, from));
}

export const TERMINAL_STATUSES: CampaignStatusKey[] = ["COMPLETED", "CANCELLED", "FAILED"];
export const FROZEN_STATUSES: CampaignStatusKey[] = [
  "APPROVED",
  "SCHEDULED",
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
];
