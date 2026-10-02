import { Card, CardContent } from "../ui/card";
import { cn } from "@/lib/utils";

/** Headline number card used across the analysis panels. */
export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "alert" | "ok" }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "alert" && "text-sev-critical", tone === "ok" && "text-ok")}>{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
