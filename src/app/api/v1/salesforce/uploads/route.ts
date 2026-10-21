import { apiRoute } from "@/lib/api/handler";
import { badRequest } from "@/lib/errors";
import { MAX_UPLOAD_BYTES, UploadMetaSchema, uploadAudienceSnapshot } from "@/lib/services/salesforce/operations";

/**
 * Upload an independently preserved audience snapshot (CSV, multipart/form-data: file + meta JSON).
 * The original file is stored unaltered (encrypted) with its SHA-256.
 */
export const POST = apiRoute({ permission: "archive:reconcile", rateLimitPerMinute: 10 }, async ({ req, user }) => {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw badRequest("File exceeds the 50 MB limit.");
  const form = await req.formData().catch(() => {
    throw badRequest("Expected multipart/form-data.");
  });
  const file = form.get("file");
  const metaRaw = form.get("meta");
  if (!(file instanceof File)) throw badRequest("Attach a CSV file.");
  if (!/\.csv$/i.test(file.name)) throw badRequest("Only .csv files are accepted.");
  const meta = UploadMetaSchema.parse(JSON.parse(String(metaRaw ?? "{}")));
  return uploadAudienceSnapshot({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, meta, user);
});
