"use client";

import { useState } from "react";
import { Diff } from "@/components/planner/run-view";
import { api } from "@/lib/api-client";

/**
 * Diffs are not part of report snapshots (they contain code and are deleted when a
 * run is discarded). This loads the file's diff from the run itself, only when
 * opened, and says so when the run no longer stores it.
 */
export function RunDiff({ runId, iteration, path }: { runId: string; iteration: number; path: string }) {
  const [state, setState] = useState<{ diff: string | null; error: string | null } | null>(null);
  async function load() {
    if (state) return;
    try {
      const run = await api<{ changes: Array<{ iteration: number; path: string; diff: string | null }> }>(`/api/engineering/runs/${runId}`);
      const change = run.changes.find((c) => c.iteration === iteration && c.path === path);
      setState({ diff: change?.diff ?? null, error: null });
    } catch (err) {
      setState({ diff: null, error: err instanceof Error ? err.message : "Could not load the diff" });
    }
  }
  return (
    <details onToggle={(e) => (e.currentTarget.open ? void load() : undefined)} className="min-w-0">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Show diff (loaded from the run)</summary>
      <div className="mt-1.5 min-w-0">
        {!state ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : state.error ? (
          <p className="text-xs text-sev-critical">{state.error}</p>
        ) : state.diff ? (
          <Diff text={state.diff} />
        ) : (
          <p className="text-xs text-muted-foreground">The run no longer stores this diff (the result was discarded, or the change was rejected).</p>
        )}
      </div>
    </details>
  );
}
