import { Check, Loader2 } from "lucide-react";
import { ANALYSIS_STAGES, type AnalysisStage } from "@pd/shared/constants";
import { Card, CardContent } from "../ui/card";
import { cn } from "@/lib/utils";

export function ProgressPanel({ stage, progress, connectionLost }: { stage: AnalysisStage; progress: number; connectionLost: boolean }) {
  const current = ANALYSIS_STAGES.findIndex((s) => s.id === stage);
  const stages = ANALYSIS_STAGES.filter((s) => s.id !== "COMPLETED");

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{ANALYSIS_STAGES[current]?.label ?? "Working"}…</span>
          <span className="tabular-nums text-muted-foreground">{progress}%</span>
        </div>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(progress, 3)}%` }} />
        </div>
        <ol className="mt-5 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
          {stages.map((s, i) => {
            const done = i < current;
            const running = i === current;
            return (
              <li key={s.id} className={cn("flex items-center gap-2", !done && !running && "text-muted-foreground")}>
                {done ? (
                  <Check className="size-4 text-ok" />
                ) : running ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <span className="size-4 rounded-full border" />
                )}
                {s.label}
              </li>
            );
          })}
        </ol>
        {connectionLost && <p className="mt-4 text-xs text-sev-high">Lost connection to the server, retrying…</p>}
      </CardContent>
    </Card>
  );
}
