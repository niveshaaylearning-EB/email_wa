import { Pill } from "@/components/app/status";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand" | "muted";

const VERIFICATION: Record<string, { label: string; tone: Tone; hint: string }> = {
  VERIFIED: { label: "Verified", tone: "success", hint: "All integrity checks passed and an independent source count matched." },
  PARTIALLY_VERIFIED: { label: "Partially verified", tone: "warning", hint: "Integrity checks passed, but no independent count was available (limited) or a non-fatal anomaly was found." },
  UNVERIFIED: { label: "Unverified", tone: "muted", hint: "Not yet verified, or extraction did not finish." },
  FAILED: { label: "Verification failed", tone: "danger", hint: "An integrity check failed — do not rely on this dataset." },
  NOT_ACCESSIBLE: { label: "Not accessible", tone: "danger", hint: "The API user lacks permission to read this object." },
  NOT_RETRIEVABLE: { label: "Not retrievable", tone: "neutral", hint: "Outside the source's retention window — not the same as zero records." },
};

export function VerificationBadge({ status, className }: { status: string; className?: string }) {
  const v = VERIFICATION[status] ?? { label: status, tone: "neutral" as Tone, hint: "" };
  return (
    <span title={v.hint} className={className}>
      <Pill tone={v.tone} dot>
        {v.label}
      </Pill>
    </span>
  );
}

const DATASET: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Pending", tone: "muted" },
  RUNNING: { label: "Extracting", tone: "info" },
  EXTRACTED: { label: "Extracted", tone: "brand" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  NOT_ACCESSIBLE: { label: "Not accessible", tone: "danger" },
  NOT_RETRIEVABLE: { label: "Not retrievable", tone: "neutral" },
};

export function DatasetStatusBadge({ status }: { status: string }) {
  const s = DATASET[status] ?? { label: status, tone: "neutral" as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

const JOB: Record<string, { label: string; tone: Tone }> = {
  QUEUED: { label: "Queued", tone: "muted" },
  RUNNING: { label: "Running", tone: "info" },
  CANCELLING: { label: "Cancelling", tone: "warning" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  COMPLETED: { label: "Completed", tone: "success" },
  COMPLETED_WITH_GAPS: { label: "Completed with gaps", tone: "warning" },
  FAILED: { label: "Failed", tone: "danger" },
};

export function JobStatusBadge({ status }: { status: string }) {
  const s = JOB[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={s.tone} dot>
      {s.label}
    </Pill>
  );
}

const EVENT: Record<string, Tone> = { SENT: "brand", OPEN: "success", CLICK: "info", BOUNCE: "danger", UNSUB: "warning", NOTSENT: "neutral" };
export function EventTypeBadge({ type }: { type: string }) {
  return <Pill tone={EVENT[type] ?? "neutral"}>{type === "NOTSENT" ? "Not sent" : type.charAt(0) + type.slice(1).toLowerCase()}</Pill>;
}

export function SimulatedBadge({ className }: { className?: string }) {
  return (
    <span title="Synthetic data from the development simulator — not from Salesforce" className={cn("rounded border border-dashed border-warning/60 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warning", className)}>
      Simulated
    </span>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[12px]", className)}>{children}</span>;
}

export const fmt = new Intl.NumberFormat("en-IN");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export const DATASET_KIND_LABELS: Record<string, string> = {
  BUSINESS_UNITS: "Business Units",
  DATA_FOLDERS: "Folders",
  DE_INVENTORY: "DE inventory",
  DE_ROWS: "DE rows",
  SUBSCRIBERS: "Subscribers",
  LISTS: "Lists",
  EMAIL_JOBS: "Send jobs",
  TRIGGERED_SENDS: "Triggered sends",
  TRACKING_SENT: "Sent events",
  TRACKING_OPEN: "Open events",
  TRACKING_CLICK: "Click events",
  TRACKING_BOUNCE: "Bounce events",
  TRACKING_UNSUB: "Unsub events",
  TRACKING_NOTSENT: "Not-sent events",
  JOURNEYS: "Journeys",
  AUTOMATIONS: "Automations",
  QUERY_DEFINITIONS: "SQL queries",
  CONTENT_ASSETS: "Content assets",
  CONTENT_CATEGORIES: "Content folders",
  AUDIENCE_UPLOAD: "Audience upload",
};

const CHECK_TONE: Record<string, string> = { pass: "text-success", fail: "text-destructive", warn: "text-warning", info: "text-info", na: "text-muted-foreground" };
const CHECK_SYMBOL: Record<string, string> = { pass: "✓", fail: "✕", warn: "!", info: "i", na: "–" };

export function CheckList({ checks }: { checks: { key: string; label: string; status: string; detail: string }[] }) {
  if (!checks.length) return <p className="text-xs text-muted-foreground">No checks recorded yet.</p>;
  return (
    <ul className="space-y-2">
      {checks.map((c) => (
        <li key={c.key} className="flex gap-2.5 text-sm">
          <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border text-[10px] font-bold", CHECK_TONE[c.status])} aria-label={c.status}>
            {CHECK_SYMBOL[c.status]}
          </span>
          <div className="min-w-0">
            <p className="font-medium leading-tight">{c.label}</p>
            <p className="text-xs leading-snug text-muted-foreground">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
