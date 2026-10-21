import { apiRoute } from "@/lib/api/handler";
import { verifyManifestChain } from "@/lib/services/salesforce/manifests";
import { archiveAudit } from "@/lib/services/salesforce/audit";

/** Recompute every manifest hash of a backup job and check the chain links. */
export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "archive:read", rateLimitPerMinute: 20 }, async ({ params, user, meta }) => {
  const r = await verifyManifestChain(params.id);
  await archiveAudit({ actor: user, action: "archive.manifest_chain.verified", entityType: "salesforce_backup_job", entityId: params.id, metadata: { ok: r.ok, count: r.count, problems: r.problems.slice(0, 10) }, ...meta });
  return { ...r, message: r.ok ? `Manifest chain intact (${r.count} manifests re-hashed)` : `Manifest chain verification FAILED: ${r.problems[0]}` };
});
