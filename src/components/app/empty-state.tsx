import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      {Icon && (
        <span className="mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  icon: Icon,
  className,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: string;
  children?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
  action?: React.ReactNode;
}) {
  const cls = {
    info: "border-info/25 bg-info/5 [&_svg]:text-info",
    warning: "border-warning/30 bg-warning/5 [&_svg]:text-warning",
    danger: "border-destructive/30 bg-destructive/5 [&_svg]:text-destructive",
    success: "border-success/30 bg-success/5 [&_svg]:text-success",
  }[tone];
  return (
    <div className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-sm", cls, className)} role={tone === "danger" ? "alert" : undefined}>
      {Icon && <Icon className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
}
