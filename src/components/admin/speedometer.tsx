import { cn } from "@/lib/utils";

const CX = 50;
const CY = 52;
const R = 36;
const ARC_LEN = Math.PI * R; // semicircle length

/** Semi-circle speedometer (0–1). Value sits under the needle hub. */
export function Speedometer({
  ratio,
  value,
  className,
}: {
  /** 0–1 fill; null shows an empty track (no needle). */
  ratio: number | null;
  value: React.ReactNode;
  className?: string;
}) {
  const clamped = ratio == null ? null : Math.max(0, Math.min(1, ratio));
  // Map 0→1 onto degrees: left (-180) → right (0), through the top.
  const deg = clamped == null ? -90 : -180 + clamped * 180;
  const rad = (deg * Math.PI) / 180;
  const nx = CX + Math.cos(rad) * (R - 6);
  const ny = CY + Math.sin(rad) * (R - 6);

  const tone =
    clamped == null
      ? ""
      : clamped >= 0.85
        ? "stroke-success"
        : clamped >= 0.5
          ? "stroke-accent"
          : "stroke-warn";

  const dash = clamped == null ? 0 : clamped * ARC_LEN;

  return (
    <div className={cn("relative mx-auto w-full max-w-[168px]", className)}>
      <svg viewBox="0 0 100 68" className="h-auto w-full overflow-visible" aria-hidden>
        {/* Track: left → right via top */}
        <path
          d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          className="stroke-canvas-deep"
        />
        {clamped != null && clamped > 0 ? (
          <path
            d={`M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`}
            fill="none"
            strokeWidth="8"
            strokeLinecap="round"
            className={tone}
            strokeDasharray={`${dash} ${ARC_LEN}`}
          />
        ) : null}
        {clamped != null ? (
          <line x1={CX} y1={CY} x2={nx} y2={ny} strokeWidth="2.5" strokeLinecap="round" className="stroke-ink" />
        ) : null}
        <circle cx={CX} cy={CY} r="3.5" className={clamped == null ? "fill-muted-2" : "fill-ink"} />
      </svg>
      <div className="-mt-3 text-center">
        <p className="font-serif text-[28px] font-semibold leading-none tracking-tight text-ink tabular-nums">{value}</p>
      </div>
    </div>
  );
}
