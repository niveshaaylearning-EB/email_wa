import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";
import { BrandMark } from "@/components/app/brand";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentUser()) redirect("/");
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-brand p-12 text-white lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.08]"
          style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "28px 28px" }}
        />
        <BrandMark inverted />
        <div className="relative max-w-md space-y-5">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">One place for every client conversation.</h1>
          <p className="text-[15px] leading-relaxed text-white/75">
            Category-driven email and WhatsApp communications with maker-checker approvals, frozen audiences and complete delivery reconciliation.
          </p>
          <ul className="space-y-2.5 text-sm text-white/80">
            {["Zoho CRM is the source of client identity", "Categories & memberships managed here", "Nothing sends without explicit approval"].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className="size-1.5 rounded-full bg-brand-accent" />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">Internal system · Access is monitored and audited</p>
      </section>
      <section className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm space-y-8">
          <div className="lg:hidden">
            <BrandMark />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">Use your Niveshaay Communication Center account.</p>
          </div>
          <LoginForm next={next} />
        </div>
      </section>
    </main>
  );
}
