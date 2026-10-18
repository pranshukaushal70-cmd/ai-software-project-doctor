import Link from "next/link";
import { ArrowRight, Boxes, FileText, FlaskConical, Network, ShieldCheck, Sparkles, SquareCode, Workflow } from "lucide-react";
import { gradeFor } from "@pd/analyzer/scoring";
import { GRADE_TONE } from "@/components/analysis/labels";
import { HeroPoster } from "@/components/landing/hero-poster";
import { HeroVisual } from "@/components/landing/hero-visual";
import { Logo } from "@/components/logo";
import { StatusBadge } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getCurrentUser } from "@/server/auth/session";
import { listRepositories } from "@/server/services/analysis-service";

const FEATURES = [
  { icon: ShieldCheck, title: "Security Analysis", body: "Deterministic secret detection and insecure-pattern rules. Secrets are masked and never sent to an AI provider." },
  { icon: Network, title: "Architecture Intelligence", body: "Import graphs, circular dependencies and layer detection recovered from the code itself." },
  { icon: SquareCode, title: "Code Quality", body: "Cyclomatic complexity, nesting, long functions and duplication, computed from syntax trees." },
  { icon: Boxes, title: "Dependency Health", body: "Manifest parsing across npm, pip, Poetry, Maven and Gradle, with vulnerabilities from OSV.dev." },
  { icon: FlaskConical, title: "Testing Insights", body: "Test frameworks, test-to-source ratio and real coverage reports when they exist. Never estimated." },
  { icon: Sparkles, title: "AI Recommendations", body: "An LLM reasons over structured findings and must cite them. No evidence, no recommendation." },
];

const PIPELINE = ["Evidence", "Static analysis", "Risk interpretation", "AI explanation", "Recommended fix"];

/** The three hero actions share one size, so they line up in a row (or a full-width stack on phones). */
const HERO_ACTION = "px-5 text-[15px]";

/** The signed-in user's real workspace: repository count and the latest analysis. */
async function Workspace({ userId }: { userId: string }) {
  const repos = await listRepositories(userId);
  const latestRepo = repos.find((r) => r.analyses[0]);
  const latest = latestRepo?.analyses[0];
  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/60 px-4 py-3 text-sm backdrop-blur">
      <span className="text-muted-foreground">
        Your workspace: <span className="font-medium text-foreground">{repos.length}</span> repositor{repos.length === 1 ? "y" : "ies"}
      </span>
      {latestRepo && latest ? (
        <Link href={`/analysis/${latest.id}`} className="flex min-w-0 items-center gap-2 rounded-md hover:text-primary">
          <span className="text-muted-foreground">Latest:</span>
          <span className="truncate font-medium">{latestRepo.owner ? `${latestRepo.owner}/${latestRepo.name}` : latestRepo.name}</span>
          <StatusBadge status={latest.status} />
          {latest.healthScore != null && (
            <Badge tone={GRADE_TONE[gradeFor(latest.healthScore)]} title="Health score of the latest analysis">
              {latest.healthScore} · {gradeFor(latest.healthScore)}
            </Badge>
          )}
        </Link>
      ) : (
        <span className="text-muted-foreground">No analyses yet.</span>
      )}
    </div>
  );
}

export default async function LandingPage() {
  const user = await getCurrentUser();

  return (
    <div className="relative min-h-dvh">
      {/* The header stays a top-level banner, outside <main>, and lies over the stage below:
          `.stage` gives it the dark tokens, `bg-transparent!` lets the stage show through. */}
      <header className="stage absolute inset-x-0 top-0 z-10 bg-transparent!">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-1" aria-label="Account">
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
        </div>
      </header>

      <main>
        {/* The hero is a dark stage in both themes; the rest of the page follows the theme. */}
        <div className="stage relative overflow-hidden">
          <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 opacity-70" />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-48 left-1/2 h-[640px] w-[min(1100px,140vw)] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--glow),transparent)]"
          />
          {/* Keeps the header's height free, as when it was in the flow. */}
          <div aria-hidden className="h-16" />

          <section className="relative mx-auto grid max-w-7xl items-center gap-8 px-4 pb-14 pt-6 sm:px-6 sm:pt-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-10 lg:pb-24 lg:pt-14">
            <div className="animate-fade-up">
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 font-mono text-xs text-muted-foreground backdrop-blur">
                <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" aria-hidden />
                Repository intelligence · evidence-cited AI
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
                Your AI{" "}
                <span className="bg-linear-to-r from-primary to-violet bg-clip-text text-transparent">Engineering Doctor.</span>
              </h1>
              <p className="mt-4 max-w-xl text-base text-muted-foreground text-pretty sm:mt-5 sm:text-lg">
                Understand your codebase, discover risks, plan changes, and review code safely.
              </p>
              <div className="mt-7 grid gap-3 sm:flex sm:flex-wrap">
                <Button asChild size="lg" className={HERO_ACTION}>
                  <Link href={user ? "/new" : "/signup"}>
                    Analyze a Repository <ArrowRight />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline" className={`${HERO_ACTION} border-animated bg-card/60 backdrop-blur`}>
                  <Link href={user ? "/planner" : "/login"}>
                    <Workflow /> Open Engineering Planner
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline" className={`${HERO_ACTION} bg-transparent`}>
                  <Link href={user ? "/reports" : "/login"}>
                    <FileText /> View Reports
                  </Link>
                </Button>
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                {/* Signed-in users start the demo from the New analysis page; others sign up first. */}
                Or{" "}
                <Link href={user ? "/new#demo" : "/signup"} className="text-primary underline-offset-4 hover:underline">
                  explore the demo project
                </Link>
                {user ? "." : ". The planner and reports need an account; you will be asked to sign in."}
              </p>
              {user && <Workspace userId={user.id} />}
            </div>
            <HeroVisual>
              <HeroPoster />
            </HeroVisual>
          </section>
        </div>

        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="reveal text-2xl font-semibold tracking-tight sm:text-3xl">How findings are produced</h2>
          <p className="reveal mt-2 max-w-2xl text-muted-foreground">Deterministic analysis first; the model only explains what the evidence shows.</p>
          <ol className="mt-8 grid gap-3 sm:grid-cols-5" aria-label="How findings are produced">
            {PIPELINE.map((step, i) => (
              <li key={step} className="reveal relative rounded-xl border bg-card px-4 py-3">
                <span className="font-mono text-xs text-primary">0{i + 1}</span>
                <span className="mt-1 block text-sm font-medium">{step}</span>
                {i < PIPELINE.length - 1 && (
                  <ArrowRight className="absolute -right-2.5 top-1/2 z-10 hidden size-4 -translate-y-1/2 rounded-full bg-background text-muted-foreground sm:block" aria-hidden />
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y bg-muted/30">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-20 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <Card key={title} interactive className="reveal p-5">
                <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h2 className="mt-4 font-medium">{title}</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="reveal text-2xl font-semibold tracking-tight sm:text-3xl">Not an LLM wrapper</h2>
          <div className="mt-8 grid gap-4 text-sm text-muted-foreground md:grid-cols-3">
            <p className="reveal rounded-xl border bg-card p-5">
              <strong className="mb-1 block text-foreground">Deterministic first.</strong> Parsing, metrics, secret detection and
              dependency graphs are computed programmatically and are reproducible. Every analysis records the analyzer version.
            </p>
            <p className="reveal rounded-xl border bg-card p-5">
              <strong className="mb-1 block text-foreground">Evidence-cited AI.</strong> The model only sees structured, redacted
              findings and must reference them. Recommendations that cite no evidence are discarded.
            </p>
            <p className="reveal rounded-xl border bg-card p-5">
              <strong className="mb-1 block text-foreground">Safe by default.</strong> Repository code is treated as untrusted and
              never executed. Local-only mode performs the full analysis without any AI provider.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <span>AI Software Project Doctor</span>
          <span>Health scores are heuristics, not certifications.</span>
        </div>
      </footer>
    </div>
  );
}
