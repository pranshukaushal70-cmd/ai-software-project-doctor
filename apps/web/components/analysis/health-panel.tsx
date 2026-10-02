import { Info, ShieldAlert } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { cn } from "@/lib/utils";
import { GRADE_TONE } from "./labels";
import type { HealthScoreDto } from "./types";

/** Bar colour for a 0–100 score, on the same scale as the grades. */
const barTone = (score: number) => (score >= 75 ? "bg-ok" : score >= 60 ? "bg-sev-medium" : score >= 40 ? "bg-sev-high" : "bg-sev-critical");
const fmtPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function ScoreBar({ score, label }: { score: number; label: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuenow={score} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full", barTone(score))} style={{ width: `${Math.max(score, 2)}%` }} />
    </div>
  );
}

function Grade({ health, size = "lg" }: { health: HealthScoreDto; size?: "lg" | "sm" }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("font-semibold tabular-nums", size === "lg" ? "text-5xl" : "text-3xl")}>{health.score}</span>
      <span className="text-sm text-muted-foreground">/ 100</span>
      <Badge tone={GRADE_TONE[health.grade]} className="ml-1">
        Grade {health.grade}
      </Badge>
    </div>
  );
}

/** Compact score card for the Overview tab: score, grade and the weakest dimensions. */
export function HealthScoreCard({ health, onDetails }: { health: HealthScoreDto; onDetails?: () => void }) {
  const weakest = health.dimensions
    .filter((d) => d.applicable && d.score !== null && d.score < 100)
    .sort((a, b) => a.score! - b.score!)
    .slice(0, 3);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Health score</div>
          <Grade health={health} />
          {health.cap && <p className="mt-1 text-xs text-sev-high">Capped: {health.cap.reason}</p>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:max-w-sm">
          {weakest.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deductions in any dimension.</p>
          ) : (
            weakest.map((d) => (
              <div key={d.id} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0">{d.label}</span>
                <div className="flex-1">
                  <ScoreBar score={d.score!} label={`${d.label} score`} />
                </div>
                <span className="w-8 text-right tabular-nums">{d.score}</span>
              </div>
            ))
          )}
          {onDetails && (
            <button type="button" onClick={onDetails} className="self-start text-xs text-primary hover:underline">
              See how the score is calculated
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Full, explainable breakdown: every dimension, its weight, and every deduction with its reason. */
export function HealthPanel({ health, analyzerVersion }: { health: HealthScoreDto; analyzerVersion: string }) {
  const applicable = health.dimensions.filter((d) => d.applicable);
  const skipped = health.dimensions.filter((d) => !d.applicable);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <Grade health={health} />
          <p className="text-sm text-muted-foreground">
            Each dimension starts at 100 and loses points for the findings in it; the overall score is the weighted average of the dimensions
            that apply to this repository{health.cap ? ", limited while severe security findings are open" : ""}.
          </p>
          {health.cap && (
            <p className="flex items-start gap-2 rounded-md bg-sev-high/10 px-3 py-2 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-sev-high" aria-hidden />
              <span>
                The weighted score is {health.weightedScore}, but {health.cap.reason}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <section aria-label="Score by dimension" className="grid gap-4 md:grid-cols-2">
        {applicable.map((d) => (
          <Card key={d.id}>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>{d.label}</CardTitle>
                <span className="text-2xl font-semibold tabular-nums">{d.score}</span>
              </div>
              <CardDescription>
                Weight {d.weight} ({d.effectiveWeight}% of the overall score) · {d.findings} {d.findings === 1 ? "finding" : "findings"} counted
                {d.excluded > 0 && ` · ${d.excluded} triaged`}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ScoreBar score={d.score!} label={`${d.label} score`} />
              {d.factors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No deductions.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {d.factors.map((f) => (
                    <li key={f.label} className="flex items-baseline justify-between gap-3">
                      <span>
                        {f.label}
                        <span className="block text-xs text-muted-foreground">{f.detail}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-sev-high">{fmtPoints(f.points)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {skipped.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Not scored</CardTitle>
            <CardDescription>These dimensions do not apply; their weight is shared among the others.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {skipped.map((d) => (
                <li key={d.id}>
                  <span className="font-medium">{d.label}</span> <span className="text-muted-foreground">— {d.note}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          {health.caveats.map((c) => (
            <p key={c}>{c}</p>
          ))}
          <p>
            Health scores are heuristics computed from deterministic findings, not certifications; problems the analyzers cannot detect are not
            reflected. Mark false positives as Ignored and intended findings as Expected: they stop counting in the next analysis. Scoring
            v{health.version}, analyzer v{analyzerVersion}.
          </p>
        </div>
      </div>
    </div>
  );
}
