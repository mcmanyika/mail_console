import Link from "next/link";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#0F1B2D" />
      <path d="M7 11.5h18v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 7 20.5v-9Z" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path d="m7.5 12 8.5 6.5L24.5 12" fill="none" stroke="#818CF8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ href = "/", className, compact }: { href?: string; className?: string; compact?: boolean }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark />
      {compact ? null : (
        <span className="font-serif text-[19px] font-semibold tracking-tight text-ink">Mail Console</span>
      )}
    </Link>
  );
}
