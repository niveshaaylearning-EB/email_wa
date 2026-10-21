import { cn } from "@/lib/utils";

/** Niveshaay mark: a restrained monogram (replace with the official logo asset when available). */
export function BrandMark({ inverted, compact, className }: { inverted?: boolean; compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg text-[15px] font-semibold tracking-tight",
          inverted ? "bg-white text-brand" : "bg-brand text-white dark:bg-primary dark:text-primary-foreground",
        )}
        aria-hidden
      >
        N
      </span>
      {!compact && (
        <span className="flex flex-col leading-none">
          <span className={cn("text-[15px] font-semibold tracking-tight", inverted ? "text-white" : "text-foreground")}>Niveshaay</span>
          <span className={cn("mt-1 text-[11px] font-medium uppercase tracking-[0.12em]", inverted ? "text-white/60" : "text-muted-foreground")}>
            Communication Center
          </span>
        </span>
      )}
    </div>
  );
}
