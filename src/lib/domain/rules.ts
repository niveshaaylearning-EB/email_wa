/**
 * Dashboard-defined dynamic category rules, evaluated against mirrored CRM data.
 * Rules only ever add/remove memberships with source = RULE for their own rule id;
 * manual, bulk and CSV memberships are never touched by rule evaluation.
 */
import { z } from "zod";

export const RULE_FIELDS = {
  crmStatus: "CRM status",
  city: "City",
  phoneCountry: "Phone country (ISO)",
  crmOwner: "CRM owner",
  emailDomain: "Email domain",
  hasEmail: "Has email",
  hasValidPhone: "Has valid phone",
  crmField: "Custom CRM field",
} as const;
export type RuleField = keyof typeof RULE_FIELDS;

export const RULE_OPERATORS = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  starts_with: "starts with",
  in: "is one of",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  is_true: "is true",
  is_false: "is false",
} as const;
export type RuleOperator = keyof typeof RULE_OPERATORS;

export const RuleConditionSchema = z
  .object({
    field: z.enum(Object.keys(RULE_FIELDS) as [RuleField, ...RuleField[]]),
    crmFieldKey: z.string().max(100).optional(),
    op: z.enum(Object.keys(RULE_OPERATORS) as [RuleOperator, ...RuleOperator[]]),
    value: z.union([z.string().max(500), z.array(z.string().max(200)).max(100)]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.field === "crmField" && !c.crmFieldKey) ctx.addIssue({ code: "custom", message: "crmFieldKey required for custom CRM field" });
    const needsValue = !["is_empty", "is_not_empty", "is_true", "is_false"].includes(c.op);
    if (needsValue && (c.value === undefined || (typeof c.value === "string" && c.value === ""))) {
      ctx.addIssue({ code: "custom", message: `Operator "${c.op}" needs a value` });
    }
    if ((c.field === "hasEmail" || c.field === "hasValidPhone") && !["is_true", "is_false"].includes(c.op)) {
      ctx.addIssue({ code: "custom", message: "Boolean fields support is true / is false only" });
    }
  });

export const RuleDefinitionSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(RuleConditionSchema).min(1).max(25),
});
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

export interface RuleSubject {
  crmStatus: string | null;
  city: string | null;
  phoneCountry: string | null;
  crmOwner: string | null;
  emailNormalized: string | null;
  phoneValid: boolean;
  crmFields: Record<string, unknown>;
}

function fieldValue(s: RuleSubject, c: RuleCondition): string | boolean | null {
  switch (c.field) {
    case "crmStatus":
      return s.crmStatus;
    case "city":
      return s.city;
    case "phoneCountry":
      return s.phoneCountry;
    case "crmOwner":
      return s.crmOwner;
    case "emailDomain":
      return s.emailNormalized?.split("@")[1] ?? null;
    case "hasEmail":
      return !!s.emailNormalized;
    case "hasValidPhone":
      return s.phoneValid;
    case "crmField": {
      const v = s.crmFields?.[c.crmFieldKey ?? ""];
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") return v;
      if (typeof v === "object" && v && "name" in v) return String((v as { name: unknown }).name);
      return String(v);
    }
  }
}

export function evaluateCondition(s: RuleSubject, c: RuleCondition): boolean {
  const raw = fieldValue(s, c);
  if (c.op === "is_true") return raw === true || raw === "true";
  if (c.op === "is_false") return raw === false || raw === "false" || raw === null;
  const v = raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
  const target = Array.isArray(c.value) ? c.value.map((x) => x.trim().toLowerCase()) : (c.value ?? "").trim().toLowerCase();
  switch (c.op) {
    case "is_empty":
      return v === "";
    case "is_not_empty":
      return v !== "";
    case "equals":
      return Array.isArray(target) ? target.includes(v) : v === target;
    case "not_equals":
      return Array.isArray(target) ? !target.includes(v) : v !== target;
    case "contains":
      return typeof target === "string" && v.includes(target);
    case "starts_with":
      return typeof target === "string" && v.startsWith(target);
    case "in":
      return (Array.isArray(target) ? target : target.split(",").map((x) => x.trim())).includes(v);
  }
  return false;
}

export function evaluateRule(s: RuleSubject, rule: RuleDefinition): boolean {
  return rule.match === "all"
    ? rule.conditions.every((c) => evaluateCondition(s, c))
    : rule.conditions.some((c) => evaluateCondition(s, c));
}

export function describeRule(rule: RuleDefinition): string {
  const parts = rule.conditions.map((c) => {
    const field = c.field === "crmField" ? `CRM.${c.crmFieldKey}` : RULE_FIELDS[c.field];
    const val = Array.isArray(c.value) ? c.value.join(", ") : c.value;
    return `${field} ${RULE_OPERATORS[c.op]}${val ? ` "${val}"` : ""}`;
  });
  return parts.join(rule.match === "all" ? " AND " : " OR ");
}
