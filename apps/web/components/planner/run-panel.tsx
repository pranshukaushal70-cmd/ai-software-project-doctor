"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormError } from "@/components/ui/form";
import { api } from "@/lib/api-client";
import { GenerateReportButton } from "@/components/reports/generate-report-button";
import { RunView, type RunDto } from "./run-view";

/**
 * The code engine below a completed plan: approve the plan (first gate), start a
 * run, then follow the latest run, approving or skipping its sandboxed tests
 * (second gate) and downloading or discarding the result.
 */

const POLL_MS = 2000;
const OPEN: RunDto["status"][] = ["QUEUED", "MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "AWAITING_APPROVAL", "INSTALLING", "TESTING", "REPAIRING"];

export function RunPanel({ planId, approvedAt: initialApprovedAt }: { planId: string; approvedAt: string | null }) {
  const [approvedAt, setApprovedAt] = useState(initialApprovedAt);
  const [run, setRun] = useState<RunDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const follow = useCallback(async (runId: string) => {
    if (poll.current) clearTimeout(poll.current);
    try {
      const r = await api<RunDto>(`/api/engineering/runs/${runId}`);
      setRun(r);
      if (r.inProgress) poll.current = setTimeout(() => void follow(runId), POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the run");
    }
  }, []);

  useEffect(() => {
    if (!approvedAt) return;
    let cancelled = false;
    void (async () => {
      try {
        const runs = await api<Array<{ id: string }>>(`/api/engineering/plans/${planId}/runs`);
        if (!cancelled && runs[0]) await follow(runs[0].id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load runs");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      if (poll.current) clearTimeout(poll.current);
    };
  }, [approvedAt, planId, follow]);

  async function act(fn: () => Promise<RunDto | { approvedAt: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if ("id" in result && "status" in result) {
        setRun(result);
        if (result.inProgress) void follow(result.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed");
    } finally {
      setBusy(false);
    }
  }

  const post = <T,>(url: string, body?: unknown) => api<T>(url, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  if (!approvedAt) {
    return (
      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <p className="font-medium">Code engine</p>
          <p className="text-muted-foreground">
            Approve this plan to let the code engine turn it into a change: it edits only the files the plan names, in an isolated copy of the analysed source, and shows you the diff. Nothing
            is committed or pushed, and nothing runs without a second approval.
          </p>
          <FormError message={error} />
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await post<{ approvedAt: string }>(`/api/engineering/plans/${planId}/approve`);
                setApprovedAt(r.approvedAt);
                return r;
              })
            }
          >
            <CheckCircle2 className="size-4" /> Approve plan
          </Button>
        </CardContent>
      </Card>
    );
  }

  const open = run && OPEN.includes(run.status);
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
          <span className="flex items-center gap-1.5 text-ok">
            <CheckCircle2 className="size-4" /> Plan approved {new Date(approvedAt).toLocaleString()}
          </span>
          <GenerateReportButton type="PLAN" subjectId={planId} label="Plan report" />
          {run && <GenerateReportButton type="RUN" subjectId={run.id} label="Run report" />}
          {!open && (
            <Button size="sm" className="ml-auto" disabled={busy || !loaded} onClick={() => void act(() => post<RunDto>(`/api/engineering/plans/${planId}/runs`))}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              {run ? "Run the code engine again" : "Run the code engine"}
            </Button>
          )}
        </CardContent>
      </Card>
      <FormError message={error} />
      {run && (
        <RunView
          run={run}
          busy={busy}
          actions={{
            approve: (install) => void act(() => post<RunDto>(`/api/engineering/runs/${run.id}/execute`, { install })),
            skip: () => void act(() => post<RunDto>(`/api/engineering/runs/${run.id}/skip-tests`)),
            cancel: () => void act(() => post<RunDto>(`/api/engineering/runs/${run.id}/cancel`)),
            discard: () => void act(() => post<RunDto>(`/api/engineering/runs/${run.id}/discard`)),
          }}
        />
      )}
    </div>
  );
}
