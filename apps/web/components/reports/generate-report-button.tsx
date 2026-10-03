"use client";

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import type { ReportTypeName } from "@pd/shared/constants";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

/** Generates a report about an analysis, plan or run (or finds the unchanged existing one) and opens it. */
export function GenerateReportButton({ type, subjectId, label = "Generate report", variant = "outline" }: { type: ReportTypeName; subjectId: string; label?: string; variant?: "outline" | "default" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const report = await api<{ id: string }>("/api/reports", { method: "POST", body: JSON.stringify({ type, subjectId }) });
      // A full navigation: the report page is server-rendered from the stored snapshot.
      window.location.assign(`/reports/${report.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the report");
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant={variant} disabled={busy} onClick={() => void generate()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
        {label}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-sev-critical">
          {error}
        </span>
      )}
    </span>
  );
}
