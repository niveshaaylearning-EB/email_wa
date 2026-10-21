import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  href,
  unavailable,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "danger" | "brand";
  href?: string;
  /** Shown instead of a number when the provider doesn't supply this metric. */
  unavailable?: string;
}) {
  const toneCls = {
    default: "text-muted-foreground bg-muted",
    success: "text-success bg-success/10",
    warning: "text-warning bg-warning/10",
    danger: "text-destructive bg-destructive/10",
    brand: "text-primary bg-primary/10",
  }[tone];
  const body = (
    <div className="group flex h-full flex-col justify-between gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-foreground/15">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn("grid size-7 place-items-center rounded-md", toneCls)}>
            <Icon className="size-3.5" />
          </span>
        )}
      </div>
      <div>
        {unavailable ? (
          <p className="text-sm text-muted-foreground">{unavailable}</p>
        ) : (
          <p className="tabular text-[26px] font-semibold leading-none tracking-tight">{value}</p>
        )}
        {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
