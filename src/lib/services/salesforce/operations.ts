/**
 * Operator actions on archived evidence:
 *   - upload an independently preserved audience snapshot (e.g. the CSV that was imported
 *     into the DE before the send) — stored unaltered + hashed; labelled historical only
 *     with evidence and an attestation;
 *   - attest a Data Extension row count read from the Salesforce UI, which provides the
 *     independent count needed to fully verify a DE extraction.
 */
import "server-only";
import Papa from "papaparse";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { putObject, sha256Hex } from "@/lib/salesforce/storage";
import { rowHash } from "./normalize";
import { verifyAndSeal } from "./verification";
import { archiveAudit, type ArchiveActor } from "./audit";
import type { DatasetParams } from "./types";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const UploadMetaSchema = z
  .object({
    label: z.string().trim().min(3).max(150),
    mid: z.string().regex(/^\d{1,12}$/),
    connectionId: z.string().min(1),
    snapshotDate: z.string().datetime().optional(),
    historical: z.boolean().default(false),
    evidenceNote: z.string().trim().max(2000).optional(),
    attest: z.boolean().default(false),
  })
  .refine((v) => !v.historical || (v.attest && (v.evidenceNote?.length ?? 0) >= 20 && !!v.snapshotDate), {
    message: "A historical snapshot needs a snapshot date, an evidence description (20+ characters) and your attestation.",
    path: ["evidenceNote"],
  });

export async function uploadAudienceSnapshot(file: { name: string; bytes: Buffer }, meta: z.infer<typeof UploadMetaSchema>, actor: ArchiveActor) {
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw badRequest("File exceeds the 50 MB limit.");
  const conn = await prisma.salesforceConnection.findUnique({ where: { id: meta.connectionId } });
  if (!conn) throw notFound("Salesforce connection");
  const text = file.bytes.toString("utf8").replace(/^﻿/, "");
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: "greedy", dynamicTyping: false, transformHeader: (h) => h.trim() });
  if (parsed.errors.length && !parsed.data.length) throw badRequest(`Could not parse CSV: ${parsed.errors[0].message}`);
  const fields = (parsed.meta.fields ?? []).filter(Boolean);
  if (!fields.length) throw badRequest("The CSV has no header row.");
  if (!parsed.data.length) throw badRequest("The CSV has no data rows.");
  const sha = sha256Hex(file.bytes);
  const stored = await putObject(`uploads/${sha.slice(0, 2)}/${sha}.csv`, file.bytes);
  const params: DatasetParams = {
    channel: "upload",
    pageLimit: 2500,
    schema: fields.map((f) => ({ name: f, fieldType: "Text", isPrimaryKey: false, isRequired: false, maxLength: null })),
    upload: { fileName: file.name.slice(0, 200), sha256: sha, bytes: file.bytes.length, storageKey: stored.storageKey, evidenceNote: meta.evidenceNote, snapshotDate: meta.snapshotDate ?? null, label: meta.historical ? "HISTORICAL_EVIDENCED" : "CURRENT_STATE" },
  };
  const ds = await prisma.salesforceBackupDataset.create({
    data: {
      connectionId: conn.id,
      mid: meta.mid,
      kind: "AUDIENCE_UPLOAD",
      objectType: "upload:csv",
      sourceKey: sha.slice(0, 16),
      label: `Upload · ${meta.label}`,
      status: "RUNNING",
      params: params as unknown as Prisma.InputJsonValue,
      startedAt: new Date(),
      createdById: actor.id,
      isSimulated: false,
    },
  });
  let pageNo = 0;
  for (let i = 0; i < parsed.data.length; i += 2500) {
    pageNo += 1;
    const slice = parsed.data.slice(i, i + 2500);
    const pageText = JSON.stringify(slice);
    const pageStored = await putObject(`uploads/pages/${ds.id}/p${String(pageNo).padStart(5, "0")}.json`, pageText);
    await prisma.$transaction(async (tx) => {
      await tx.salesforceBackupPage.create({ data: { datasetId: ds.id, attempt: 1, pageNo, recordCount: slice.length, overallStatus: i + 2500 >= parsed.data.length ? "OK" : "MorePages", storageKey: pageStored.storageKey, sha256: pageStored.sha256, byteSize: pageStored.bytes } });
      await tx.salesforceDataExtensionRow.createMany({
        data: slice.map((r, idx) => {
          const values = Object.fromEntries(fields.map((f) => [f, r[f] ?? null]));
          return { datasetId: ds.id, pageNo, rowNo: idx + 1, values: values as Prisma.InputJsonValue, rowHash: rowHash(values) };
        }),
      });
    });
  }
  await prisma.salesforceBackupDataset.update({ where: { id: ds.id }, data: { status: "EXTRACTED", finishedAt: new Date(), pagesFetched: pageNo, recordsExtracted: parsed.data.length, bytesStored: file.bytes.length, checkpoint: { nextPage: pageNo + 1 } as Prisma.InputJsonValue } });
  await verifyAndSeal(ds.id);
  await archiveAudit({ actor, action: "archive.audience.uploaded", entityType: "salesforce_dataset", entityId: ds.id, metadata: { fileName: file.name, sha256: sha, rows: parsed.data.length, historical: meta.historical, parseWarnings: parsed.errors.length } });
  return { datasetId: ds.id, rows: parsed.data.length, sha256: sha, warnings: parsed.errors.slice(0, 5).map((e) => `row ${e.row}: ${e.message}`) };
}

export const AttestSchema = z.object({ count: z.coerce.number().int().min(0), note: z.string().trim().min(5).max(500) });

export async function attestDataExtensionCount(dataExtensionId: string, input: z.infer<typeof AttestSchema>, actor: ArchiveActor) {
  const de = await prisma.salesforceDataExtension.findUnique({ where: { id: dataExtensionId } });
  if (!de) throw notFound("Data Extension");
  await prisma.salesforceDataExtension.update({ where: { id: de.id }, data: { attestedCount: input.count, attestedById: actor.id, attestedByEmail: actor.email, attestedAt: new Date(), attestationNote: input.note } });
  await archiveAudit({ actor, action: "archive.de.count_attested", entityType: "salesforce_data_extension", entityId: de.id, metadata: { customerKey: de.customerKey, count: input.count, note: input.note } });
  const status = de.latestRowsDatasetId ? await verifyAndSeal(de.latestRowsDatasetId) : null;
  return { status };
}
