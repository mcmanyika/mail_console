import { formatNumber, monthLabel } from "@/lib/format";

type Point = { yearMonth: string; settled: number; reserved: number };

/** Dependency-free stacked bar chart: settled (accepted by provider) + reserved (queued). */
export function VolumeChart({ data }: { data: Point[] }) {
  const max = Math.max(1, ...data.map((d) => d.settled + d.reserved));
  const niceMax = Math.ceil(max / 100) * 100 || 100;
  const total = data.reduce((n, d) => n + d.settled + d.reserved, 0);

  if (total === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-md border border-dashed border-line-strong text-sm text-muted">
        No sending activity recorded in the last {data.length} months.
      </div>
    );
  }

  return (
    <figure>
      <div className="relative h-56 pl-10">
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="absolute inset-x-0 flex items-center" style={{ bottom: `calc(${f * 100}% * 0.86 + 1.75rem)` }}>
            <span className="w-9 pr-2 text-right text-[11px] tabular-nums text-muted-2">{formatNumber(Math.round(niceMax * f))}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        ))}
        <div className="absolute inset-y-0 left-10 right-0 flex items-end gap-3 pb-7">
          {data.map((d, i) => {
            const sH = (d.settled / niceMax) * 100;
            const rH = (d.reserved / niceMax) * 100;
            const isCurrent = i === data.length - 1;
            return (
              <div key={d.yearMonth} className="group relative flex h-full flex-1 flex-col items-center justify-end">
                <div className="flex w-full max-w-14 flex-col justify-end" style={{ height: "86%" }}>
                  <div
                    className="w-full rounded-t-sm bg-indigo-200"
                    style={{ height: `${rH}%` }}
                    title={`${formatNumber(d.reserved)} reserved`}
                  />
                  <div
                    className={isCurrent ? "w-full bg-accent" : "w-full bg-ink-2/80"}
                    style={{ height: `${sH}%`, borderTopLeftRadius: rH ? 0 : 2, borderTopRightRadius: rH ? 0 : 2 }}
                    title={`${formatNumber(d.settled)} submitted`}
                  />
                </div>
                <span className="absolute -bottom-0 text-[11px] text-muted">{monthLabel(d.yearMonth)}</span>
                <span className="pointer-events-none absolute -top-1 hidden rounded bg-ink px-1.5 py-0.5 text-[11px] text-white tabular-nums group-hover:block">
                  {formatNumber(d.settled + d.reserved)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-ink-2/80" /> Submitted to provider
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-indigo-200" /> Reserved (queued)
        </span>
        <span>Source: monthly_usage, all workspaces. Months are UTC.</span>
      </figcaption>
    </figure>
  );
}
