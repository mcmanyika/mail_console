import { Brand } from "./brand";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="relative hidden w-[44%] max-w-[640px] flex-col justify-between bg-ink p-12 text-white lg:flex">
        <Brand className="[&_span]:text-white" />
        <div>
          <p className="font-serif text-[34px] font-medium leading-[1.15] tracking-tight">
            One console for every client&apos;s mail.
          </p>
          <ul className="mt-8 space-y-3 text-[15px] text-slate-300">
            <li className="flex gap-3">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-indigo-400" />
              Mailbox access is always granted explicitly — owners and admins included.
            </li>
            <li className="flex gap-3">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-indigo-400" />
              Platform operators manage workspaces and limits, never message bodies.
            </li>
            <li className="flex gap-3">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-indigo-400" />
              Per-client domains, sending limits and audit trails.
            </li>
          </ul>
        </div>
        <p className="text-xs text-slate-400">Demo data only in DEMO_MODE — no real email is ever sent.</p>
      </aside>
      <main className="flex flex-1 items-center justify-center px-5 py-12">
        <div className="w-full max-w-[400px]">
          <Brand className="mb-10 lg:hidden" />
          <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-muted">{subtitle}</p> : null}
          <div className="mt-8">{children}</div>
          {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
