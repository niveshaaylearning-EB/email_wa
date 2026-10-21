/**
 * Page normalisation: SFMC objects → searchable PostgreSQL rows.
 *
 * Raw pages (stored encrypted, hashed) remain the primary evidence. These tables are derived
 * copies for search and reconciliation:
 *   - record tables (DE rows, tracking events, subscribers) are written per dataset with the
 *     (dataset, page, row) key, so a replayed page cannot duplicate and nothing is collapsed;
 *   - entity tables (DEs, email jobs, journeys, assets, automations, BUs) hold the latest
 *     known state and point at the dataset they came from.
 */
import "server-only";
import type { Prisma, SalesforceBackupDataset, SfTrackingEventType } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { stableStringify } from "@/lib/crypto";
import { dataExtensionRowValues, prop, type SoapObject } from "@/lib/salesforce/soap";
import { parseSfmcDate } from "@/lib/salesforce/dates";
import { TRACKING_KIND_TO_EVENT } from "@/lib/salesforce/objects";
import { putObject, sha256Hex } from "@/lib/salesforce/storage";
import type { DatasetParams } from "./types";

export interface NormalizeContext {
  tx: Tx;
  dataset: SalesforceBackupDataset;
  params: DatasetParams;
  pageNo: number;
  requestIndex: number;
  sourceOffset: string;
}

const bool = (v: string | null) => (v === null || v === "" ? null : v.toLowerCase() === "true");
const nn = (v: string | null) => (v === null || v === "" ? null : v);

export function trackingFingerprint(eventType: string, o: Record<string, string | null>): string {
  return sha256Hex(
    [eventType, o.SendID, o.SubscriberKey, o.EventDate, o.BatchID, o.ListID, o.TriggeredSendDefinitionObjectID, o.URL, o.URLID, o.SMTPCode].map((v) => v ?? "").join("\u001f"),
  );
}

/**
 * REST rowset item → { SchemaFieldName: value }. The rowset API returns primary-key fields under
 * `keys` and the rest under `values`, with lower-cased names; names are mapped back to the
 * schema's exact casing, values are kept as returned (strings), and omitted fields become null.
 */
export function restRowValues(item: Record<string, unknown>, schema: { name: string }[]): Record<string, string | null> {
  const merged: Record<string, unknown> = { ...((item.keys as Record<string, unknown>) ?? {}), ...((item.values as Record<string, unknown>) ?? {}) };
  const byLower = new Map(Object.entries(merged).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string | null> = {};
  for (const f of schema) {
    const v = byLower.get(f.name.toLowerCase());
    out[f.name] = v === undefined || v === null ? null : typeof v === "string" ? v : String(v);
    byLower.delete(f.name.toLowerCase());
  }
  for (const [k, v] of byLower) out[k] = v === undefined || v === null ? null : String(v); // fields not in the archived schema
  return out;
}

export function rowHash(values: Record<string, string | null>): string {
  return sha256Hex(stableStringify(values));
}

/** Returns the number of records written to record tables (for count verification). */
export async function normalizePage(ctx: NormalizeContext, results: SoapObject[] | Record<string, unknown>[]): Promise<number> {
  const { tx, dataset: d, params, pageNo } = ctx;
  const now = new Date();
  switch (d.kind) {
    case "DE_ROWS":
    case "AUDIENCE_UPLOAD": {
      const pk = params.primaryKeyFields ?? [];
      const data = (results as SoapObject[]).map((r, i) => {
        const values = d.kind !== "DE_ROWS" ? (r as unknown as Record<string, string | null>) : params.channel === "rest" ? restRowValues(r as Record<string, unknown>, params.schema ?? []) : dataExtensionRowValues(r);
        return {
          datasetId: d.id,
          dataExtensionId: params.dataExtensionId ?? null,
          pageNo,
          rowNo: i + 1,
          values: values as Prisma.InputJsonValue,
          rowHash: rowHash(values),
          primaryKey: pk.length ? pk.map((f) => values[f] ?? "").join("|") : null,
        };
      });
      if (data.length) await tx.salesforceDataExtensionRow.createMany({ data, skipDuplicates: true });
      return data.length;
    }
    case "TRACKING_SENT":
    case "TRACKING_OPEN":
    case "TRACKING_CLICK":
    case "TRACKING_BOUNCE":
    case "TRACKING_UNSUB":
    case "TRACKING_NOTSENT": {
      const eventType = TRACKING_KIND_TO_EVENT[d.kind] as SfTrackingEventType;
      const data = (results as SoapObject[]).map((r, i) => {
        const o: Record<string, string | null> = {};
        for (const k of ["SendID", "SubscriberKey", "EventDate", "EventType", "BatchID", "ListID", "TriggeredSendDefinitionObjectID", "URL", "URLID", "BounceCategory", "BounceType", "SMTPCode", "SMTPReason", "SubscriberID"]) o[k] = prop(r, k);
        return {
          datasetId: d.id,
          connectionId: d.connectionId,
          mid: d.mid,
          eventType,
          jobId: nn(o.SendID),
          subscriberKey: o.SubscriberKey,
          subscriberId: nn(o.SubscriberID),
          eventDate: parseSfmcDate(o.EventDate, ctx.sourceOffset),
          eventDateRaw: o.EventDate,
          batchId: nn(o.BatchID),
          listId: nn(o.ListID),
          triggeredSendObjectId: nn(o.TriggeredSendDefinitionObjectID),
          url: nn(o.URL),
          urlId: nn(o.URLID),
          bounceCategory: nn(o.BounceCategory),
          bounceType: nn(o.BounceType),
          smtpCode: nn(o.SMTPCode),
          smtpReason: nn(o.SMTPReason),
          sourceEventType: nn(o.EventType),
          raw: r as Prisma.InputJsonValue,
          fingerprint: trackingFingerprint(eventType, o),
          pageNo,
          rowNo: i + 1,
        };
      });
      if (data.length) await tx.salesforceTrackingEvent.createMany({ data, skipDuplicates: true });
      return data.length;
    }
    case "SUBSCRIBERS": {
      const data = (results as SoapObject[]).map((r, i) => ({
        datasetId: d.id,
        connectionId: d.connectionId,
        mid: d.mid,
        pageNo,
        rowNo: i + 1,
        subscriberKey: prop(r, "SubscriberKey"),
        subscriberId: nn(prop(r, "ID")),
        emailAddress: nn(prop(r, "EmailAddress")),
        status: nn(prop(r, "Status")),
        createdDate: nn(prop(r, "CreatedDate")),
        unsubscribedDate: nn(prop(r, "UnsubscribedDate")),
        raw: r as Prisma.InputJsonValue,
      }));
      if (data.length) await tx.salesforceSubscriber.createMany({ data, skipDuplicates: true });
      return data.length;
    }
    case "EMAIL_JOBS": {
      for (const r of results as SoapObject[]) {
        const jobId = prop(r, "ID");
        if (!jobId) continue;
        const counters: Record<string, string | null> = {};
        for (const k of [
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
        ])
          if (k in r) counters[k] = prop(r, k);
        const data = {
          emailId: nn(prop(r, "Email.ID")),
          emailName: nn(prop(r, "EmailName")),
          subject: nn(prop(r, "Subject")),
          fromName: nn(prop(r, "FromName")),
          fromAddress: nn(prop(r, "FromAddress")),
          status: nn(prop(r, "Status")),
          sendDate: parseSfmcDate(prop(r, "SendDate"), ctx.sourceOffset),
          sentDate: parseSfmcDate(prop(r, "SentDate"), ctx.sourceOffset),
          createdDate: nn(prop(r, "CreatedDate")),
          counters: counters as Prisma.InputJsonValue,
          triggeredSendKey: nn(prop(r, "EmailSendDefinition.CustomerKey")),
          raw: r as Prisma.InputJsonValue,
          datasetId: d.id,
          isSimulated: d.isSimulated,
          lastSeenAt: now,
        };
        await tx.salesforceEmailJob.upsert({
          where: { connectionId_mid_jobId: { connectionId: d.connectionId, mid: d.mid, jobId } },
          create: { connectionId: d.connectionId, mid: d.mid, jobId, ...data },
          update: data,
        });
      }
      return 0;
    }
    case "DE_INVENTORY": {
      const req = params.requests?.[ctx.requestIndex];
      if (req?.objectType === "DataExtension") {
        for (const r of results as SoapObject[]) {
          const customerKey = prop(r, "CustomerKey");
          if (!customerKey) continue;
          const categoryId = nn(prop(r, "CategoryID"));
          const data = {
            objectId: nn(prop(r, "ObjectID")),
            name: prop(r, "Name") ?? customerKey,
            description: nn(prop(r, "Description")),
            categoryId,
            folderPath: categoryId ? (params.folderPaths?.[categoryId] ?? null) : null,
            isSendable: bool(prop(r, "IsSendable")),
            isTestable: bool(prop(r, "IsTestable")),
            sendableField: nn(prop(r, "SendableDataExtensionField.Name")),
            retention: {
              DataRetentionPeriodLength: prop(r, "DataRetentionPeriodLength"),
              DataRetentionPeriod: prop(r, "DataRetentionPeriod"),
              RowBasedRetention: prop(r, "RowBasedRetention"),
              ResetRetentionPeriodOnImport: prop(r, "ResetRetentionPeriodOnImport"),
              DeleteAtEndOfRetentionPeriod: prop(r, "DeleteAtEndOfRetentionPeriod"),
              RetainUntil: prop(r, "RetainUntil"),
            } as Prisma.InputJsonValue,
            createdDate: nn(prop(r, "CreatedDate")),
            modifiedDate: nn(prop(r, "ModifiedDate")),
            raw: r as Prisma.InputJsonValue,
            inventoryDatasetId: d.id,
            isSimulated: d.isSimulated,
            lastSeenAt: now,
          };
          await tx.salesforceDataExtension.upsert({
            where: { connectionId_mid_customerKey: { connectionId: d.connectionId, mid: d.mid, customerKey } },
            create: { connectionId: d.connectionId, mid: d.mid, customerKey, ...data },
            update: data,
          });
        }
      } else if (req?.objectType === "DataExtensionField" && req.tag) {
        const de = await tx.salesforceDataExtension.findUnique({ where: { connectionId_mid_customerKey: { connectionId: d.connectionId, mid: d.mid, customerKey: req.tag } } });
        if (de) {
          for (const r of results as SoapObject[]) {
            const name = prop(r, "Name");
            if (!name) continue;
            const ord = prop(r, "Ordinal");
            const data = {
              fieldType: nn(prop(r, "FieldType")),
              maxLength: nn(prop(r, "MaxLength")),
              scale: nn(prop(r, "Scale")),
              isPrimaryKey: bool(prop(r, "IsPrimaryKey")),
              isRequired: bool(prop(r, "IsRequired")),
              ordinal: ord && /^\d+$/.test(ord) ? Number(ord) : null,
              defaultValue: nn(prop(r, "DefaultValue")),
              raw: r as Prisma.InputJsonValue,
            };
            await tx.salesforceDataExtensionField.upsert({ where: { dataExtensionId_name: { dataExtensionId: de.id, name } }, create: { dataExtensionId: de.id, name, ...data }, update: data });
          }
        }
      }
      return 0;
    }
    case "EMAILS": {
      for (const r of results as SoapObject[]) {
        const emailId = prop(r, "ID");
        if (!emailId) continue;
        const html = prop(r, "HTMLBody");
        const text = prop(r, "TextBody");
        const htmlStored = html ? await putObject(`emails/${d.connectionId}/${d.mid}/${emailId}/${sha256Hex(html).slice(0, 16)}.html`, html) : null;
        const textStored = text ? await putObject(`emails/${d.connectionId}/${d.mid}/${emailId}/${sha256Hex(text).slice(0, 16)}.txt`, text) : null;
        const { HTMLBody: _h, TextBody: _t, ...meta } = r as Record<string, unknown>;
        void _h;
        void _t;
        const modifiedDate = nn(prop(r, "ModifiedDate"));
        const data = {
          name: nn(prop(r, "Name")),
          subject: nn(prop(r, "Subject")),
          preheader: nn(prop(r, "PreHeader")),
          emailType: nn(prop(r, "EmailType")),
          createdDate: nn(prop(r, "CreatedDate")),
          modifiedDate,
          modifiedAt: parseSfmcDate(modifiedDate, ctx.sourceOffset),
          htmlStorageKey: htmlStored?.storageKey ?? null,
          htmlSha256: htmlStored?.sha256 ?? null,
          htmlBytes: htmlStored?.bytes ?? null,
          textStorageKey: textStored?.storageKey ?? null,
          textSha256: textStored?.sha256 ?? null,
          references: (html ? extractReferences(html) : []) as Prisma.InputJsonValue,
          raw: { ...meta, bodies: { html: htmlStored ? { sha256: htmlStored.sha256, bytes: htmlStored.bytes } : null, text: textStored ? { sha256: textStored.sha256, bytes: textStored.bytes } : null } } as Prisma.InputJsonValue,
          datasetId: d.id,
          isSimulated: d.isSimulated,
          lastSeenAt: now,
        };
        await tx.salesforceEmail.upsert({
          where: { connectionId_mid_emailId: { connectionId: d.connectionId, mid: d.mid, emailId } },
          create: { connectionId: d.connectionId, mid: d.mid, emailId, ...data },
          update: data,
        });
      }
      return 0;
    }
    case "BUSINESS_UNITS": {
      for (const r of results as SoapObject[]) {
        const mid = prop(r, "ID");
        if (!mid) continue;
        const parent = nn(prop(r, "ParentID"));
        const data = { name: prop(r, "Name") ?? mid, parentMid: parent === "0" ? null : parent, customerKey: nn(prop(r, "CustomerKey")), isEnterprise: parent === "0" || parent === null, raw: r as Prisma.InputJsonValue, source: "soap:BusinessUnit" };
        await tx.salesforceBusinessUnit.upsert({ where: { connectionId_mid: { connectionId: d.connectionId, mid } }, create: { connectionId: d.connectionId, mid, ...data }, update: data });
      }
      return 0;
    }
    case "AUTOMATIONS":
    case "QUERY_DEFINITIONS": {
      const kind = d.kind === "AUTOMATIONS" ? "AUTOMATION" : "QUERY_DEFINITION";
      for (const r of results as SoapObject[]) {
        const objectId = prop(r, "ObjectID") ?? prop(r, "CustomerKey");
        if (!objectId) continue;
        const gaps =
          kind === "AUTOMATION"
            ? ["Activity steps and full schedule definitions are not exposed by the documented SOAP Automation object; only the properties listed in raw were retrievable.", "Run history is not archived."]
            : [];
        const data = {
          customerKey: nn(prop(r, "CustomerKey")),
          name: nn(prop(r, "Name")),
          description: nn(prop(r, "Description")),
          status: nn(prop(r, "Status")),
          schedule: (kind === "AUTOMATION" ? { ScheduledTime: prop(r, "ScheduledTime"), LastRunTime: prop(r, "LastRunTime"), AutomationType: prop(r, "AutomationType"), IsActive: prop(r, "IsActive") } : {}) as Prisma.InputJsonValue,
          definition: kind === "QUERY_DEFINITION" ? nn(prop(r, "QueryText")) : null,
          activities: (kind === "QUERY_DEFINITION" ? [{ target: prop(r, "DataExtensionTarget.Name"), targetKey: prop(r, "DataExtensionTarget.CustomerKey"), updateType: prop(r, "TargetUpdateType") }] : []) as Prisma.InputJsonValue,
          gaps: gaps as Prisma.InputJsonValue,
          raw: r as Prisma.InputJsonValue,
          datasetId: d.id,
          isSimulated: d.isSimulated,
          lastSeenAt: now,
        };
        await tx.salesforceAutomation.upsert({
          where: { connectionId_mid_kind_objectId: { connectionId: d.connectionId, mid: d.mid, kind, objectId } },
          create: { connectionId: d.connectionId, mid: d.mid, kind, objectId, ...data },
          update: data,
        });
      }
      return 0;
    }
    case "JOURNEYS": {
      for (const item of results as Record<string, unknown>[]) {
        const journeyId = String(item.id ?? "");
        if (!journeyId) continue;
        const version = Number(item.version ?? 1);
        const data = {
          key: item.key ? String(item.key) : null,
          name: item.name ? String(item.name) : null,
          status: item.status ? String(item.status) : null,
          definitionType: item.definitionType ? String(item.definitionType) : null,
          createdDate: item.createdDate ? String(item.createdDate) : null,
          modifiedDate: item.modifiedDate ? String(item.modifiedDate) : null,
          entrySources: (item.triggers ?? []) as Prisma.InputJsonValue,
          activities: (item.activities ?? []) as Prisma.InputJsonValue,
          gaps: [
            "Per-contact journey history and execution logs are not part of the Journey Builder definition API and are not archived.",
            ...(item.activities === undefined ? ["Activities were not returned for this version (extras=all not honoured)."] : []),
          ] as Prisma.InputJsonValue,
          raw: item as Prisma.InputJsonValue,
          datasetId: d.id,
          isSimulated: d.isSimulated,
          lastSeenAt: now,
        };
        await tx.salesforceJourney.upsert({
          where: { connectionId_mid_journeyId_version: { connectionId: d.connectionId, mid: d.mid, journeyId, version } },
          create: { connectionId: d.connectionId, mid: d.mid, journeyId, version, ...data },
          update: data,
        });
      }
      return 0;
    }
    case "CONTENT_ASSETS": {
      for (const item of results as Record<string, unknown>[]) {
        const assetId = String(item.id ?? "");
        if (!assetId) continue;
        const views = (item.views ?? {}) as Record<string, { content?: unknown }>;
        const content = typeof views.html?.content === "string" ? views.html.content : typeof item.content === "string" ? item.content : typeof views.text?.content === "string" ? views.text.content : null;
        let stored: { storageKey: string; sha256: string; bytes: number } | null = null;
        if (content !== null) {
          const sha = sha256Hex(content);
          stored = await putObject(`content/${d.connectionId}/${d.mid}/${assetId}/${sha.slice(0, 16)}.html`, content);
        }
        const category = (item.category ?? {}) as Record<string, unknown>;
        const type = (item.assetType ?? {}) as Record<string, unknown>;
        const data = {
          customerKey: item.customerKey ? String(item.customerKey) : null,
          legacyId: (item.legacyData as { legacyId?: unknown } | undefined)?.legacyId != null ? String((item.legacyData as { legacyId: unknown }).legacyId) : null,
          name: item.name ? String(item.name) : null,
          assetType: type.name ? String(type.name) : null,
          categoryId: category.id !== undefined ? String(category.id) : null,
          categoryPath: params.categoryPaths?.[String(category.id)] ?? (category.name ? String(category.name) : null),
          subject: typeof views.subjectline?.content === "string" ? views.subjectline.content : null,
          preheader: typeof views.preheader?.content === "string" ? views.preheader.content : null,
          createdDate: item.createdDate ? String(item.createdDate) : null,
          modifiedDate: item.modifiedDate ? String(item.modifiedDate) : null,
          contentStorageKey: stored?.storageKey ?? null,
          contentSha256: stored?.sha256 ?? null,
          contentBytes: stored?.bytes ?? null,
          references: (content ? extractReferences(content) : []) as Prisma.InputJsonValue,
          raw: item as Prisma.InputJsonValue,
          datasetId: d.id,
          isSimulated: d.isSimulated,
          lastSeenAt: now,
        };
        await tx.salesforceAsset.upsert({
          where: { connectionId_mid_assetId: { connectionId: d.connectionId, mid: d.mid, assetId } },
          create: { connectionId: d.connectionId, mid: d.mid, assetId, ...data },
          update: data,
        });
      }
      return 0;
    }
    default:
      return 0; // DATA_FOLDERS, LISTS, TRIGGERED_SENDS, CONTENT_CATEGORIES: raw pages only
  }
}

/** External images / links / AMPscript content references in archived HTML. */
export function extractReferences(html: string): { kind: "image" | "link" | "ampscript_content"; url: string; status: "external" | "unresolved" }[] {
  const out: { kind: "image" | "link" | "ampscript_content"; url: string; status: "external" | "unresolved" }[] = [];
  const seen = new Set<string>();
  const push = (kind: "image" | "link" | "ampscript_content", url: string, status: "external" | "unresolved") => {
    const k = `${kind}:${url}`;
    if (seen.has(k) || out.length >= 500) return;
    seen.add(k);
    out.push({ kind, url, status });
  };
  for (const m of html.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) push("image", m[1], /^https?:/i.test(m[1]) ? "external" : "unresolved");
  for (const m of html.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["']/gi)) if (/^https?:/i.test(m[1])) push("link", m[1], "external");
  for (const m of html.matchAll(/ContentBlockBy(?:Id|Key|Name)\(\s*["']?([^"')]+)/gi)) push("ampscript_content", m[1], "unresolved");
  return out;
}
