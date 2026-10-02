import Link from "next/link";
import { ArrowRight, Boxes, FlaskConical, GitBranch, Network, ShieldCheck, Sparkles, SquareCode } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/server/auth/session";

const FEATURES = [
  { icon: ShieldCheck, title: "Security Analysis", body: "Deterministic secret detection and insecure-pattern rules. Secrets are masked and never sent to an AI provider." },
  { icon: Network, title: "Architecture Intelligence", body: "Import graphs, circular dependencies and layer detection recovered from the code itself." },
  { icon: SquareCode, title: "Code Quality", body: "Cyclomatic complexity, nesting, long functions and duplication, computed from syntax trees." },
  { icon: Boxes, title: "Dependency Health", body: "Manifest parsing across npm, pip, Poetry, Maven and Gradle, with vulnerabilities from OSV.dev." },
  { icon: FlaskConical, title: "Testing Insights", body: "Test frameworks, test-to-source ratio and real coverage reports when they exist. Never estimated." },
  { icon: Sparkles, title: "AI Recommendations", body: "An LLM reasons over structured findings and must cite them. No evidence, no recommendation." },
];

const PIPELINE = ["Evidence", "Static analysis", "Risk interpretation", "AI explanation", "Recommended fix"];

export default async function LandingPage() {
  const user = await getCurrentUser();
  const primaryHref = user ? "/new" : "/signup";

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1">
          <ThemeToggle />
          {user ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/signup">Get started</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pt-24">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
            <GitBranch className="size-3.5" /> Diagnose your software before it breaks.
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">AI Software Project Doctor</h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground text-pretty">
            Analyze your repository. Understand your architecture. Find security risks. Eliminate technical debt.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={primaryHref}>
                Analyze My Repository <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              {/* Signed-in users start the demo from the New analysis page; others sign up first. */}
              <Link href={user ? "/new#demo" : "/signup"}>Explore Demo</Link>
            </Button>
          </div>

          <ol className="mt-14 flex flex-wrap items-center gap-2 text-sm" aria-label="How findings are produced">
            {PIPELINE.map((step, i) => (
              <li key={step} className="flex items-center gap-2">
                <span className="rounded-md border bg-card px-2.5 py-1 font-mono text-xs">{step}</span>
                {i < PIPELINE.length - 1 && <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />}
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y bg-muted/40">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border bg-card p-5">
                <Icon className="size-5 text-primary" aria-hidden />
                <h2 className="mt-3 font-medium">{title}</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Not an LLM wrapper</h2>
          <div className="mt-6 grid gap-6 text-sm text-muted-foreground md:grid-cols-3">
            <p>
              <strong className="text-foreground">Deterministic first.</strong> Parsing, metrics, secret detection and dependency
              graphs are computed programmatically and are reproducible. Every analysis records the analyzer version.
            </p>
            <p>
              <strong className="text-foreground">Evidence-cited AI.</strong> The model only sees structured, redacted findings and
              must reference them. Recommendations that cite no evidence are discarded.
            </p>
            <p>
              <strong className="text-foreground">Safe by default.</strong> Repository code is treated as untrusted and never
              executed. Local-only mode performs the full analysis without any AI provider.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <span>AI Software Project Doctor</span>
          <span>Health scores are heuristics, not certifications.</span>
        </div>
      </footer>
    </div>
  );
}
