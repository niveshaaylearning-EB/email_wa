"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

interface C {
  total: number;
  submitted: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  sent: number;
  cancelled: number;
  dryRun: number;
}

/** Live progress — refreshes server data every 4 s while the campaign is in flight. */
export function ExecutionProgress({ campaignId, status, counts, planned }: { campaignId: string; status: string; counts: { EMAIL: C; WHATSAPP: C }; planned: number }) {
  const router = useRouter();
  const live = status === "QUEUED" || status === "RUNNING";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [live, router, campaignId]);
  const total = counts.EMAIL.total + counts.WHATSAPP.total;
  const handled = counts.EMAIL.submitted + counts.WHATSAPP.submitted + counts.EMAIL.cancelled + counts.WHATSAPP.cancelled + counts.EMAIL.dryRun + counts.WHATSAPP.dryRun;
  const pct = planned ? Math.round((handled / planned) * 100) : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          {live && <Loader2Icon className="size-4 animate-spin text-primary" />} Execution progress
        </CardTitle>
        <CardDescription className="text-xs">
          {handled.toLocaleString("en-IN")} of {planned.toLocaleString("en-IN")} planned messages processed{total < planned ? ` · ${(planned - total).toLocaleString("en-IN")} not yet materialised` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={pct} aria-label="Campaign progress" />
        <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
          {[
            ["Queued", total - handled],
            ["Accepted", counts.EMAIL.accepted + counts.WHATSAPP.accepted],
            ["Delivered (WA)", counts.WHATSAPP.delivered],
            ["Read (WA)", counts.WHATSAPP.read],
            ["Sent (email)", counts.EMAIL.sent],
            ["Failed", counts.EMAIL.failed + counts.WHATSAPP.failed],
          ].map(([l, v]) => (
            <div key={l as string} className="rounded-lg bg-muted/60 px-2 py-2">
              <dt className="text-[11px] text-muted-foreground">{l}</dt>
              <dd className="tabular text-base font-semibold">{Number(v).toLocaleString("en-IN")}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
