import { redirect } from "next/navigation";
import { first } from "@/lib/format";

type SP = Promise<Record<string, string | string[] | undefined>>;

/** Legacy /login URL — landing page is now `/`. */
export default async function LoginRedirect({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const key of ["next", "email", "error"] as const) {
    const v = first(sp[key]);
    if (v) qs.set(key, v);
  }
  const suffix = qs.size ? `?${qs}` : "";
  redirect(suffix ? `/${suffix}` : "/");
}
