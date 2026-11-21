import { cn } from "@/lib/utils";

export function UsageBar({ used, limit, className, label }: { used: number; limit: number; className?: string; label?: string }) {
  const ratio = limit > 0 ? used / limit : used > 0 ? 1 : 0;
  const pctValue = Math.min(100, Math.round(ratio * 100));
  const tone = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warn" : "bg-accent";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-canvas-deep", className)}
      role="progressbar"
      aria-valuenow={pctValue}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Usage"}
    >
      <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${pctValue}%` }} />
    </div>
  );
}
