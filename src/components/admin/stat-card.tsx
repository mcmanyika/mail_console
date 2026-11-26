import { Speedometer } from "@/components/admin/speedometer";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  sub,
  footnote,
  className,
  /** 0–1 for the speedometer; omit to keep a plain metric card. */
  gauge,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  footnote?: React.ReactNode;
  className?: string;
  gauge?: number | null;
}) {
  return (
    <div className={cn("rounded-lg border border-line bg-surface p-5 shadow-(--shadow-panel)", className)}>
      <p className="text-[13px] font-medium text-muted">{label}</p>
      {gauge !== undefined ? (
        <div className="mt-3">
          <Speedometer ratio={gauge} value={value} />
        </div>
      ) : (
        <p className="mt-2 font-serif text-[34px] font-semibold leading-none tracking-tight text-ink tabular-nums">{value}</p>
      )}
      {sub ? <p className="mt-2 text-center text-[13px] text-ink-2">{sub}</p> : null}
      {footnote ? <p className="mt-2 border-t border-line pt-2 text-xs leading-snug text-muted">{footnote}</p> : null}
    </div>
  );
}
