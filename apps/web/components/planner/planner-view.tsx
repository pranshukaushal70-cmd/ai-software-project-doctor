"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormError, Input, Label } from "@/components/ui/form";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { PlanView, type PlanDto } from "./plan-view";

export interface PlannableAnalysis {
  id: string;
  repository: string;
  createdAt: string;
}

interface TaskDto {
  id: string;
  request: string;
  scope: string | null;
  constraints: string[];
  createdAt: string;
  latestPlan: { id: string; status: PlanDto["status"]; validationStatus: string | null; confidence: number | null; inProgress: boolean } | null;
}

const POLL_MS = 2000;
const STATUS_TONE = { PENDING: "neutral", RUNNING: "primary", COMPLETED: "ok", FAILED: "critical" } as const;

export function PlannerView({ analyses, initialAnalysisId }: { analyses: PlannableAnalysis[]; initialAnalysisId: string | null }) {
  const [analysisId, setAnalysisId] = useState(initialAnalysisId && analyses.some((a) => a.id === initialAnalysisId) ? initialAnalysisId : (analyses[0]?.id ?? ""));
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTasks = useCallback(async (id: string) => {
    if (!id) return;
    try {
      setTasks(await api<TaskDto[]>(`/api/engineering/tasks?analysisId=${encodeURIComponent(id)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tasks");
    }
  }, []);

  const loadPlan = useCallback(
    async (taskId: string) => {
      if (poll.current) clearTimeout(poll.current);
      try {
        const p = await api<PlanDto | null>(`/api/engineering/tasks/${taskId}/plan`);
        setPlan(p);
        if (p?.inProgress) poll.current = setTimeout(() => void loadPlan(taskId), POLL_MS);
        else void loadTasks(analysisId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the plan");
      }
    },
    [analysisId, loadTasks],
  );

  useEffect(() => {
    void loadTasks(analysisId);
    setSelected(null);
    setPlan(null);
  }, [analysisId, loadTasks]);
  useEffect(() => () => void (poll.current && clearTimeout(poll.current)), []);

  function open(taskId: string) {
    setSelected(taskId);
    setPlan(null);
    void loadPlan(taskId);
  }

  async function startPlan(taskId: string) {
    await api(`/api/engineering/tasks/${taskId}/plan`, { method: "POST" });
    setSelected(taskId);
    await loadPlan(taskId);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const scope = String(form.get("scope") ?? "").trim();
    const constraints = String(form.get("constraints") ?? "")
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    setPending(true);
    try {
      const task = await api<TaskDto>("/api/engineering/tasks", {
        method: "POST",
        body: JSON.stringify({ analysisId, task: String(form.get("task") ?? ""), ...(scope ? { scope } : {}), constraints }),
      });
      await loadTasks(analysisId);
      await startPlan(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the plan");
    } finally {
      setPending(false);
    }
  }

  async function retry(taskId: string) {
    setError(null);
    try {
      await startPlan(taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request a plan");
    }
  }

  if (analyses.length === 0) {
    return (
      <Card className="mt-6">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No analysed repositories with a repository index yet. Run an analysis first; the planner works from its index.
        </CardContent>
      </Card>
    );
  }

  const current = tasks.find((t) => t.id === selected) ?? null;
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[22rem_1fr] [&>*]:min-w-0">
      <div className="space-y-6">
        <Card>
          <CardContent className="py-4">
            <form onSubmit={submit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="analysis">Repository</Label>
                <select
                  id="analysis"
                  value={analysisId}
                  onChange={(e) => setAnalysisId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-xs"
                >
                  {analyses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.repository} — analysed {a.createdAt.slice(0, 10)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task">Task</Label>
                <textarea
                  id="task"
                  name="task"
                  required
                  minLength={10}
                  maxLength={2000}
                  rows={4}
                  placeholder="e.g. Add rate limiting to the login endpoint"
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="scope">Scope (optional)</Label>
                <Input id="scope" name="scope" placeholder="e.g. apps/web" maxLength={1000} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="constraints">Constraints (optional, one per line)</Label>
                <textarea
                  id="constraints"
                  name="constraints"
                  rows={2}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-ring"
                />
              </div>
              <FormError message={error} />
              <Button type="submit" disabled={pending || !analysisId} className="w-full">
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                Plan this task
              </Button>
              <p className="text-xs text-muted-foreground">Planning only: nothing is changed, run or committed. The planner sees repository index facts, never file contents or secrets.</p>
            </form>
          </CardContent>
        </Card>

        <div>
          <h2 className="mb-2 text-sm font-medium">Tasks</h2>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks for this analysis yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => open(t.id)}
                    aria-current={t.id === selected ? "true" : undefined}
                    className={cn("w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted", t.id === selected && "border-primary bg-muted")}
                  >
                    <span className="line-clamp-2 break-words">{t.request}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {t.latestPlan ? <Badge tone={STATUS_TONE[t.latestPlan.status]}>{t.latestPlan.status}</Badge> : <Badge>no plan</Badge>}
                      {t.scope && <code className="break-all">{t.scope}</code>}
                      <span>{new Date(t.createdAt).toLocaleString()}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="min-w-0">
        {!selected ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Describe a task to get an engineering plan grounded in this repository&apos;s index: affected files and symbols, steps, tests, risks, and which claims are verified, inferred or
              unknown.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {current && (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm break-words">
                  <span className="text-muted-foreground">Task: </span>
                  {current.request}
                </p>
                {!plan?.inProgress && (
                  <Button variant="outline" size="sm" onClick={() => void retry(current.id)}>
                    {plan ? "Re-plan" : "Generate plan"}
                  </Button>
                )}
              </div>
            )}
            {plan ? <PlanView plan={plan} /> : <p className="text-sm text-muted-foreground">No plan yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
