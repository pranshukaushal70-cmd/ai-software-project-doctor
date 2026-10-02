"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { FormError } from "./ui/form";
import { api } from "@/lib/api-client";

/** Starts an analysis of the bundled, deliberately flawed demo project. */
export function DemoAnalysisCard() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setPending(true);
    try {
      const { analysisId } = await api<{ analysisId: string }>("/api/analysis/demo", { method: "POST" });
      router.push(`/analysis/${analysisId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the demo analysis");
      setPending(false);
    }
  }

  return (
    <Card id="demo" className="mt-6">
      <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="text-sm">
            <div className="font-medium">No repository at hand?</div>
            <p className="text-muted-foreground">
              Analyse the demo project: a small web shop with deliberate security, API, database, testing and documentation problems.
            </p>
            <FormError message={error} />
          </div>
        </div>
        <Button type="button" variant="outline" onClick={start} disabled={pending} className="shrink-0">
          {pending && <Loader2 className="animate-spin" />}
          Try the demo project
        </Button>
      </CardContent>
    </Card>
  );
}
