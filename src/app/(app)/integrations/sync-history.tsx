import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/app/status";
import { formatIST } from "@/lib/time";

export function SyncHistory({ runs }: { runs: { id: string; provider: string; type: string; status: string; startedAt: string; finishedAt: string | null; stats: Record<string, unknown>; apiCalls: number; errorMessage: string | null }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Synchronisation history</CardTitle>
        <CardDescription className="text-xs">Initial and incremental Zoho CRM syncs. Memberships are never modified by sync.</CardDescription>
      </CardHeader>
      <CardContent>
        {runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 text-left font-medium">Started</th>
                  <th className="py-2 text-left font-medium">Type</th>
                  <th className="py-2 text-left font-medium">Status</th>
                  <th className="py-2 text-right font-medium">Fetched</th>
                  <th className="py-2 text-right font-medium">New</th>
                  <th className="py-2 text-right font-medium">Updated</th>
                  <th className="py-2 text-right font-medium">Deleted</th>
                  <th className="py-2 text-right font-medium">API calls</th>
                  <th className="py-2 pl-6 text-left font-medium">Mode / error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="tabular py-2 text-xs">{formatIST(r.startedAt)}</td>
                    <td className="py-2 text-xs">{r.type.toLowerCase()}</td>
                    <td className="py-2">
                      <Pill tone={r.status === "SUCCEEDED" ? "success" : r.status === "FAILED" ? "danger" : r.status === "RUNNING" ? "info" : "warning"}>{r.status.toLowerCase()}</Pill>
                    </td>
                    {["fetched", "created", "updated", "deleted"].map((k) => (
                      <td key={k} className="tabular py-2 text-right">
                        {Number(r.stats?.[k] ?? 0).toLocaleString("en-IN")}
                      </td>
                    ))}
                    <td className="tabular py-2 text-right">{r.apiCalls}</td>
                    <td className="max-w-xs truncate py-2 pl-6 text-xs text-muted-foreground" title={r.errorMessage ?? undefined}>
                      {r.errorMessage ?? String(r.stats?.mode ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No sync runs yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
