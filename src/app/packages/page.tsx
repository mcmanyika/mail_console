import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/layout/brand";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { formatPlanPrice, PLAN_LIST } from "@/lib/billing/plans";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Packages",
  description: "Starter, Growth, and Scale plans for Mail Console workspaces.",
};

export default function PackagesPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-5">
          <Brand href="/" />
          <div className="flex items-center gap-2">
            <Link href="/" className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-canvas-deep">
              Sign in
            </Link>
            <LinkButton href="/signup" variant="primary" size="sm">
              Create account
            </LinkButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-12 md:py-16">
        <div className="mx-auto text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Pricing</p>
          <h1 className="mt-2 whitespace-nowrap font-serif text-[clamp(1.35rem,4.2vw,2.625rem)] font-semibold leading-tight tracking-tight text-ink">
            Packages for Every Client Workspace
          </h1>
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {PLAN_LIST.map((p) => (
            <article
              key={p.id}
              className={cn(
                "flex flex-col rounded-xl border bg-surface p-6 shadow-(--shadow-panel)",
                p.recommended ? "border-accent ring-2 ring-accent/15" : "border-line",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-serif text-2xl font-semibold text-ink">{p.name}</h2>
                {p.recommended ? <Badge tone="accent">Recommended</Badge> : null}
              </div>
              <p className="mt-1 text-[13px] text-muted">{p.tagline}</p>
              <p className="mt-5 font-serif text-4xl font-semibold tabular-nums text-ink">
                {formatPlanPrice(p).replace("/mo", "")}
                <span className="ml-1 text-base font-normal text-muted">/mo</span>
              </p>
              <dl className="mt-5 space-y-2 border-t border-line pt-4 text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Sends / month</dt>
                  <dd className="font-medium tabular-nums text-ink">{formatNumber(p.monthlySendingLimit)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">AI assists / month</dt>
                  <dd className="font-medium tabular-nums text-ink">{formatNumber(p.monthlyAiLimit)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Mailboxes</dt>
                  <dd className="font-medium text-ink">{p.maxMailboxes == null ? "Fair use" : p.maxMailboxes}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Team seats</dt>
                  <dd className="font-medium tabular-nums text-ink">{p.maxSeats}</dd>
                </div>
              </dl>
              <ul className="mt-5 flex-1 space-y-2 text-[13px] text-ink-2">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <LinkButton href="/signup" variant={p.recommended ? "primary" : "secondary"} className="mt-6 w-full justify-center">
                Get started
              </LinkButton>
            </article>
          ))}
        </div>

        <p className="mt-10 text-center text-[13px] text-muted">
          Already have an account?{" "}
          <Link href="/" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </main>
    </div>
  );
}
