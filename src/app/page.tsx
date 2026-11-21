import { Globe, KeyRound, Lock, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { Brand } from "@/components/layout/brand";
import { LinkButton } from "@/components/ui/button";

const features = [
  {
    icon: Lock,
    title: "Access is always explicit",
    body: "Message content needs a per-mailbox grant. Owners and admins manage settings without automatically reading anyone's mail — and platform operators never can.",
  },
  {
    icon: Users,
    title: "Shared inboxes that feel personal",
    body: "Per-person read state, private drafts, proper reply and forward headers, and attachments that follow the conversation.",
  },
  {
    icon: Globe,
    title: "Domains without guesswork",
    body: "Add a mail.example.com subdomain, copy the DNS records, and see sending and receiving readiness separately.",
  },
  {
    icon: KeyRound,
    title: "Transactional API on the same limits",
    body: "Scoped API keys share your workspace's monthly allowance, with clear queued, sent and failed states in the inbox.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Brand />
          <nav className="flex items-center gap-2">
            <LinkButton href="/login" variant="ghost">
              Sign in
            </LinkButton>
            <LinkButton href="/signup" variant="primary">
              Create account
            </LinkButton>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-5 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28">
          <div>
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-2">
              <ShieldCheck className="size-3.5 text-accent" aria-hidden /> Built for agencies running mail for many clients
            </p>
            <h1 className="font-serif text-[44px] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[56px]">
              Every client&apos;s mail, one calm console.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              Mail Console gives each client a workspace with shared inboxes, their own sending domain and a monthly limit
              — while keeping message content behind explicit, auditable mailbox grants.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <LinkButton href="/login" variant="primary" size="lg">
                Sign in
              </LinkButton>
              <LinkButton href="/signup" variant="secondary" size="lg">
                Create an account
              </LinkButton>
            </div>
            <p className="mt-5 text-[13px] text-muted">
              Joining a client workspace? Open the invitation link you were sent.
            </p>
          </div>

          <div aria-hidden className="relative">
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-(--shadow-pop)">
              <div className="flex items-center gap-2 border-b border-line bg-surface-muted px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="ml-3 font-mono text-[11px] text-muted">support@mail.acme.example</span>
              </div>
              <div className="grid grid-cols-[42%_1fr]">
                <ul className="divide-y divide-line border-r border-line text-[12px]">
                  {[
                    ["Priya Nair", "Question about connection requests", true],
                    ["Tom Becker", "Partnership inquiry", true],
                    ["Nina Alvarez", "Hello from a new member", false],
                    ["You", "Re: Invoice question", false],
                  ].map(([who, subj, unread]) => (
                    <li key={subj as string} className={`px-3.5 py-3 ${subj === "Partnership inquiry" ? "bg-accent-soft/50" : ""}`}>
                      <p className={`truncate ${unread ? "font-semibold text-ink" : "text-ink-2"}`}>{who}</p>
                      <p className={`truncate ${unread ? "font-semibold text-ink" : "text-muted"}`}>{subj}</p>
                    </li>
                  ))}
                </ul>
                <div className="p-4">
                  <p className="font-serif text-[17px] font-semibold text-ink">Partnership inquiry</p>
                  <p className="mt-0.5 text-[11px] text-muted">Tom Becker · 1 day ago</p>
                  <div className="mt-4 space-y-2">
                    <div className="h-2 w-full rounded bg-canvas-deep" />
                    <div className="h-2 w-11/12 rounded bg-canvas-deep" />
                    <div className="h-2 w-4/5 rounded bg-canvas-deep" />
                  </div>
                  <div className="mt-5 flex gap-2">
                    <span className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white">Reply</span>
                    <span className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-2">Forward</span>
                    <span className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-2">Archive</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-px bg-line px-0 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <div key={f.title} className="bg-surface p-7">
                <f.icon className="size-5 text-accent" aria-hidden />
                <h2 className="mt-4 font-serif text-lg font-semibold text-ink">{f.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-8 text-[13px] text-muted">
        <span>© Mail Console</span>
        <span>
          Demo workspaces: Overflow Connections, ProFaith, LangProfile ·{" "}
          <Link href="/login" className="text-ink-2 hover:underline">
            Sign in
          </Link>
        </span>
      </footer>
    </div>
  );
}
