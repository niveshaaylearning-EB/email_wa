/**
 * Catalogue of the SFMC objects the archive reads, with the properties requested.
 *
 * Property lists follow the SOAP API object reference. If a tenant rejects a property
 * ("The Request Property(s) X do not match with the fields of Y retrieve"), the extractor
 * removes exactly those properties, retries, and records them in the dataset's
 * `params.droppedProperties` so the gap is visible in verification and manifests.
 */
import type { SfDatasetKind, SfTrackingEventType } from "@prisma/client";

export interface SoapObjectDef {
  channel: "soap";
  objectType: string;
  properties: string[];
  queryAllAccounts?: boolean;
}

export interface RestObjectDef {
  channel: "rest";
  path: string;
  pageSize: number;
  /** Name of the page-size query parameter as documented for the resource. */
  pageSizeParam: string;
  extraQuery?: Record<string, string>;
}

const TRACKING_COMMON = ["SendID", "SubscriberKey", "EventDate", "EventType", "BatchID", "ListID", "TriggeredSendDefinitionObjectID", "PartnerKey", "Client.ID"];

export const SOAP_OBJECTS = {
  BusinessUnit: { channel: "soap", objectType: "BusinessUnit", properties: ["ID", "Name", "ParentID", "CustomerKey", "Description", "CreatedDate", "ModifiedDate"], queryAllAccounts: true },
  DataFolder: { channel: "soap", objectType: "DataFolder", properties: ["ID", "Name", "ParentFolder.ID", "ContentType", "CustomerKey", "Description", "CreatedDate", "ModifiedDate"] },
  DataExtension: {
    channel: "soap",
    objectType: "DataExtension",
    properties: [
      "ObjectID",
      "CustomerKey",
      "Name",
      "Description",
      "CategoryID",
      "CreatedDate",
      "ModifiedDate",
      "IsSendable",
      "IsTestable",
      "SendableDataExtensionField.Name",
      "SendableSubscriberField.Name",
      "DataRetentionPeriodLength",
      "DataRetentionPeriod",
      "RowBasedRetention",
      "ResetRetentionPeriodOnImport",
      "DeleteAtEndOfRetentionPeriod",
      "RetainUntil",
      "Client.ID",
    ],
  },
  DataExtensionField: {
    channel: "soap",
    objectType: "DataExtensionField",
    properties: ["ObjectID", "CustomerKey", "Name", "FieldType", "MaxLength", "Scale", "IsPrimaryKey", "IsRequired", "Ordinal", "DefaultValue", "DataExtension.CustomerKey"],
  },
  Subscriber: { channel: "soap", objectType: "Subscriber", properties: ["ID", "SubscriberKey", "EmailAddress", "Status", "CreatedDate", "UnsubscribedDate", "EmailTypePreference"] },
  List: { channel: "soap", objectType: "List", properties: ["ID", "ListName", "Description", "Type", "ListClassification", "CreatedDate", "ModifiedDate", "Category"] },
  Send: {
    channel: "soap",
    objectType: "Send",
    properties: [
      "ID",
      "Client.ID",
      "Email.ID",
      "EmailName",
      "Subject",
      "FromName",
      "FromAddress",
      "SendDate",
      "SentDate",
      "CreatedDate",
      "ModifiedDate",
      "Status",
      "IsAlwaysOn",
      "IsMultipart",
      "NumberTargeted",
      "NumberSent",
      "NumberDelivered",
      "NumberErrored",
      "NumberExcluded",
      "Duplicates",
      "InvalidAddresses",
      "ExistingUndeliverables",
      "ExistingUnsubscribes",
      "MissingAddresses",
      "HardBounces",
      "SoftBounces",
      "OtherBounces",
      "UniqueOpens",
      "UniqueClicks",
      "Unsubscribes",
      "ForwardedEmails",
      "EmailSendDefinition.CustomerKey",
      "PreviewURL",
    ],
  },
  /** The email definition referenced by Send.Email.ID — includes the HTML and text bodies. */
  Email: {
    channel: "soap",
    objectType: "Email",
    properties: ["ID", "Name", "Subject", "PreHeader", "HTMLBody", "TextBody", "EmailType", "CategoryID", "CharacterSet", "IsHTMLPaste", "Status", "CreatedDate", "ModifiedDate"],
  },
  TriggeredSendDefinition: {
    channel: "soap",
    objectType: "TriggeredSendDefinition",
    properties: ["ObjectID", "CustomerKey", "Name", "Description", "TriggeredSendStatus", "Email.ID", "SendClassification.CustomerKey", "CreatedDate", "ModifiedDate", "CategoryID"],
  },
  SentEvent: { channel: "soap", objectType: "SentEvent", properties: TRACKING_COMMON },
  OpenEvent: { channel: "soap", objectType: "OpenEvent", properties: TRACKING_COMMON },
  ClickEvent: { channel: "soap", objectType: "ClickEvent", properties: [...TRACKING_COMMON, "URL", "URLID"] },
  BounceEvent: { channel: "soap", objectType: "BounceEvent", properties: [...TRACKING_COMMON, "BounceCategory", "BounceType", "SMTPCode", "SMTPReason"] },
  UnsubEvent: { channel: "soap", objectType: "UnsubEvent", properties: TRACKING_COMMON },
  NotSentEvent: { channel: "soap", objectType: "NotSentEvent", properties: TRACKING_COMMON },
  Automation: {
    channel: "soap",
    objectType: "Automation",
    properties: ["ObjectID", "CustomerKey", "Name", "Description", "Status", "CreatedDate", "ModifiedDate", "ScheduledTime", "LastRunTime", "AutomationType", "CategoryID", "IsActive"],
  },
  QueryDefinition: {
    channel: "soap",
    objectType: "QueryDefinition",
    properties: ["ObjectID", "CustomerKey", "Name", "Description", "QueryText", "TargetType", "DataExtensionTarget.Name", "DataExtensionTarget.CustomerKey", "TargetUpdateType", "CategoryID", "CreatedDate", "ModifiedDate"],
  },
} satisfies Record<string, SoapObjectDef>;

export const REST_OBJECTS = {
  Journeys: { channel: "rest", path: "/interaction/v1/interactions", pageSize: 50, pageSizeParam: "$pageSize", extraQuery: { extras: "all" } },
  ContentAssets: { channel: "rest", path: "/asset/v1/content/assets", pageSize: 50, pageSizeParam: "$pagesize" },
  ContentCategories: { channel: "rest", path: "/asset/v1/content/categories", pageSize: 200, pageSizeParam: "$pagesize" },
} satisfies Record<string, RestObjectDef>;

export const TRACKING_KINDS: Record<string, { kind: SfDatasetKind; eventType: SfTrackingEventType; object: keyof typeof SOAP_OBJECTS; label: string }> = {
  sent: { kind: "TRACKING_SENT", eventType: "SENT", object: "SentEvent", label: "Sent events" },
  open: { kind: "TRACKING_OPEN", eventType: "OPEN", object: "OpenEvent", label: "Open events" },
  click: { kind: "TRACKING_CLICK", eventType: "CLICK", object: "ClickEvent", label: "Click events" },
  bounce: { kind: "TRACKING_BOUNCE", eventType: "BOUNCE", object: "BounceEvent", label: "Bounce events" },
  unsub: { kind: "TRACKING_UNSUB", eventType: "UNSUB", object: "UnsubEvent", label: "Unsubscribe events" },
  notsent: { kind: "TRACKING_NOTSENT", eventType: "NOTSENT", object: "NotSentEvent", label: "Not-sent events" },
};

export const TRACKING_KIND_TO_EVENT: Partial<Record<SfDatasetKind, SfTrackingEventType>> = Object.fromEntries(
  Object.values(TRACKING_KINDS).map((t) => [t.kind, t.eventType]),
);

/** Backup scope options shown in the Backup Center. */
export const BACKUP_DATA_TYPES = [
  { key: "business_units", label: "Account & Business Unit inventory", group: "Metadata" },
  { key: "folders", label: "Folders (data folders)", group: "Metadata" },
  { key: "de_metadata", label: "Data Extension metadata & schemas", group: "Data Extensions" },
  { key: "de_rows", label: "Data Extension rows", group: "Data Extensions" },
  { key: "subscribers", label: "Subscribers & subscription status", group: "Audience" },
  { key: "lists", label: "Lists", group: "Audience" },
  { key: "email_jobs", label: "Email send jobs (Send objects)", group: "Email" },
  { key: "triggered_sends", label: "Triggered send definitions", group: "Email" },
  { key: "tracking_sent", label: "Sent events (recipient level)", group: "Tracking" },
  { key: "tracking_open", label: "Open events", group: "Tracking" },
  { key: "tracking_click", label: "Click events", group: "Tracking" },
  { key: "tracking_bounce", label: "Bounce events", group: "Tracking" },
  { key: "tracking_unsub", label: "Unsubscribe events", group: "Tracking" },
  { key: "tracking_notsent", label: "Not-sent events", group: "Tracking" },
  { key: "journeys", label: "Journey Builder configurations", group: "Configuration" },
  { key: "automations", label: "Automation Studio definitions & SQL queries", group: "Configuration" },
  { key: "content", label: "Content Builder templates & assets", group: "Content" },
  { key: "emails", label: "Email content of every sent email (HTML & text)", group: "Content" },
  { key: "content_files", label: "Images & PDFs used in archived content", group: "Content" },
] as const;
export type BackupDataType = (typeof BACKUP_DATA_TYPES)[number]["key"];

/** Read probes run by "Test connection": one minimal call per capability. */
export const CAPABILITY_PROBES: { key: string; label: string; scope: string; soap?: keyof typeof SOAP_OBJECTS; rest?: keyof typeof REST_OBJECTS }[] = [
  { key: "business_units", label: "Business Units", scope: "accounts_read", soap: "BusinessUnit" },
  { key: "data_extensions", label: "Data Extensions", scope: "data_extensions_read", soap: "DataExtension" },
  { key: "subscribers", label: "Subscribers", scope: "list_and_subscribers_read", soap: "Subscriber" },
  { key: "sends", label: "Email send jobs", scope: "email_read", soap: "Send" },
  { key: "tracking", label: "Tracking events", scope: "tracking_events_read", soap: "SentEvent" },
  { key: "automations", label: "Automation Studio", scope: "automations_read", soap: "Automation" },
  { key: "journeys", label: "Journey Builder", scope: "journeys_read", rest: "Journeys" },
  { key: "content", label: "Content Builder", scope: "saved_content_read", rest: "ContentAssets" },
];

const DROPPED_PROPS_RE = /Request Property\(s\)\s+(.+?)\s+do not match/i;

/** Extract offending property names from an SFMC "property does not match" error. */
export function unsupportedPropertiesFromError(message: string): string[] {
  const m = DROPPED_PROPS_RE.exec(message);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
