import { useState } from "react";
import { Download, Loader2, Play, SkipForward, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A code-engine run (Phase 8): where it is in its lifecycle, the change it proposes
 * (per-file diffs with validation flags), the sandboxed test command waiting for
 * approval, test output and the review actions. Diffs and output are rendered as
 * text, never as HTML.
 */

export type RunStatus =
  | "QUEUED"
  | "MATERIALIZING"
  | "GENERATING"
  | "VALIDATING"
  | "APPLYING"
  | "AWAITING_APPROVAL"
  | "INSTALLING"
  | "TESTING"
  | "REPAIRING"
  | "READY_FOR_REVIEW"
  | "DISCARDED"
  | "FAILED"
  | "CANCELLED";

export interface RunDto {
  id: string;
  status: RunStatus;
  inProgress: boolean;
  provider: string;
  model: string;
  commitSha: string | null;
  maxIterations: number;
  tokenBudget: number;
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  installApproved: boolean;
  executionApprovedAt: string | null;
  cancelRequestedAt: string | null;
  failureReason: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  summary: string | null;
  notes: string[];
  hasPatch: boolean;
  testSetup: {
    id: string;
    runtime: string;
    image: string;
    needsInstall: boolean;
    notes: string[];
    install: { id: string; command: string } | null;
    test: { id: string; command: string };
  } | null;
  sandbox: { enabled: boolean; installEnabled: boolean };
  events: Array<{ type: string; actor: string; fromStatus: RunStatus | null; toStatus: RunStatus | null; message: string; createdAt: string }>;
  changes: Array<{ iteration: number; path: string; operation: "CREATE" | "MODIFY" | "DELETE"; status: "APPLIED" | "REJECTED"; reason: string; additions: number; deletions: number; flags: string[]; diff: string | null }>;
  executions: Array<{ iteration: number; kind: "INSTALL" | "TEST"; command: string; image: string; network: boolean; exitCode: number | null; timedOut: boolean; durationMs: number | null; output: string; outputTruncated: boolean }>;
}

export const RUN_STATUS: Record<RunStatus, { label: string; tone: "neutral" | "primary" | "ok" | "medium" | "critical" }> = {
  QUEUED: { label: "Queued", tone: "neutral" },
  MATERIALIZING: { label: "Rebuilding source", tone: "primary" },
  GENERATING: { label: "Generating changes", tone: "primary" },
  VALIDATING: { label: "Validating", tone: "primary" },
  APPLYING: { label: "Applying", tone: "primary" },
  AWAITING_APPROVAL: { label: "Waiting for your approval", tone: "medium" },
  INSTALLING: { label: "Installing dependencies", tone: "primary" },
  TESTING: { label: "Running tests", tone: "primary" },
  REPAIRING: { label: "Repairing", tone: "primary" },
  READY_FOR_REVIEW: { label: "Ready for review", tone: "ok" },
  DISCARDED: { label: "Discarded", tone: "neutral" },
  FAILED: { label: "Failed", tone: "critical" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

const FLAG_LABEL: Record<string, string> = {
  "out-of-scope": "outside the plan",
  "forbidden-path": "never editable",
  "invalid-path": "invalid path",
  "unlisted-test": "new test not in plan",
  "dependency-change-not-approved": "dependency change not approved",
  "not-in-context": "file not shown to the model",
  "file-exists": "already exists",
  "duplicate-change": "duplicate",
  "malformed-change": "malformed",
  "anchor-empty": "empty edit",
  "anchor-not-found": "edit does not match",
  "anchor-ambiguous": "edit matches twice",
  "touches-redacted": "touches a redacted value",
  "mixed-line-endings": "mixed line endings",
  "binary-content": "binary content",
  secret: "adds a credential",
  "no-op": "no change",
  "too-large": "too large",
  "too-many-changes": "too many files",
  "too-many-lines": "too many lines",
  "syntax-error": "syntax error",
  "insecure-change": "introduces a security finding",
};

/** Lines of a diff shown inline; the download always has the whole patch. */
const DIFF_LINES = 400;

function Diff({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, DIFF_LINES);
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
      {shown.map((l, i) => (
        <span
          key={i}
          className={cn(
            "block whitespace-pre",
            l.startsWith("+") && !l.startsWith("+++") && "bg-ok/12 text-ok",
            l.startsWith("-") && !l.startsWith("---") && "bg-sev-critical/10 text-sev-critical",
            l.startsWith("@@") && "text-muted-foreground",
          )}
        >
          {l || " "}
        </span>
      ))}
      {lines.length > DIFF_LINES && <span className="block text-muted-foreground">… {lines.length - DIFF_LINES} more lines in the downloaded patch</span>}
    </pre>
  );
}

export interface RunActions {
  approve(install: boolean): void;
  skip(): void;
  cancel(): void;
  discard(): void;
}

export function RunView({ run, actions, busy = false }: { run: RunDto; actions?: RunActions; busy?: boolean }) {
  const [install, setInstall] = useState(false);
  const status = RUN_STATUS[run.status];
  const canCancel = run.inProgress || run.status === "AWAITING_APPROVAL";
  const applied = run.changes.filter((c) => c.status === "APPLIED");
  const rejected = run.changes.filter((c) => c.status === "REJECTED");
  const latestIteration = Math.max(0, ...run.changes.map((c) => c.iteration));
  const setup = run.testSetup;
  const installOffered = !!setup?.install && run.sandbox.installEnabled;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>
              {run.inProgress && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {status.label}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Iteration {run.iteration} of {run.maxIterations} · {run.inputTokens + run.outputTokens} of {run.tokenBudget} tokens · {run.provider} · {run.model}
            </span>
            {run.cancelRequestedAt && run.inProgress && <Badge tone="medium">Cancelling…</Badge>}
            {canCancel && actions && (
              <Button variant="outline" size="sm" className="ml-auto" disabled={busy || !!run.cancelRequestedAt} onClick={actions.cancel}>
                <X className="size-4" /> Cancel run
              </Button>
            )}
          </div>
          {run.summary && <p className="text-sm break-words">{run.summary}</p>}
          {run.status === "FAILED" && (
            <p className="text-sm text-sev-critical break-words" role="alert">
              {run.error ?? "The run failed."}
            </p>
          )}
          {run.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
              {run.notes.map((n, i) => (
                <li key={i} className="break-words">
                  {n}
                </li>
              ))}
            </ul>
          )}
          {run.status === "READY_FOR_REVIEW" && actions && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {run.hasPatch && (
                <Button asChild size="sm">
                  <a href={`/api/engineering/runs/${run.id}/patch`} download>
                    <Download className="size-4" /> Download patch
                  </a>
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={actions.discard}>
                <Trash2 className="size-4" /> Discard
              </Button>
              <span className="text-xs text-muted-foreground">Nothing was committed or pushed. Apply the patch with git apply and review it like any change.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {run.status === "AWAITING_APPROVAL" && setup && (
        <Card className="border-sev-medium/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Run the tests in the sandbox?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This runs the repository&apos;s own test command on the changed code in a disposable container: no network, no access to this server&apos;s files or secrets, unprivileged, with time and
              resource limits. Nothing runs until you approve.
            </p>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Test command</p>
              <code className="block rounded bg-muted px-2 py-1 font-mono text-xs break-all">{setup.test.command}</code>
              <p className="text-xs text-muted-foreground">
                Image <code className="break-all">{setup.image}</code>
              </p>
            </div>
            {setup.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {setup.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            {installOffered && (
              <label className="flex items-start gap-2 rounded-md border p-2">
                <input type="checkbox" className="mt-0.5" checked={install} onChange={(e) => setInstall(e.target.checked)} />
                <span className="min-w-0">
                  <span className="font-medium">Also install dependencies first</span>
                  <code className="mt-1 block rounded bg-muted px-2 py-1 font-mono text-xs break-all">{setup.install!.command}</code>
                  <span className="mt-1 block text-xs text-sev-medium">This step has network access (to download packages). Install scripts are not run.</span>
                </span>
              </label>
            )}
            {setup.needsInstall && !install && (
              <p className="text-xs text-sev-medium">{installOffered ? "The tests probably need their dependencies installed." : "The tests probably need dependencies, and the install step is disabled on this server, so they may fail."}</p>
            )}
            {actions && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => actions.approve(installOffered && install)}>
                  <Play className="size-4" /> Approve and run tests
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={actions.skip}>
                  <SkipForward className="size-4" /> Skip tests and review
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {run.changes.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Changes
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {applied.filter((c) => c.iteration === latestIteration).length} applied in the last iteration{rejected.length ? `, ${rejected.length} rejected in total` : ""}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 space-y-3 text-sm">
            {run.changes.map((c, i) => (
              <div key={i} className="min-w-0 space-y-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge>#{c.iteration}</Badge>
                  <code className={cn("min-w-0 break-all font-mono text-xs", c.status === "REJECTED" && "line-through decoration-sev-critical")}>{c.path}</code>
                  <Badge>{c.operation.toLowerCase()}</Badge>
                  <Badge tone={c.status === "APPLIED" ? "ok" : "critical"}>{c.status === "APPLIED" ? "applied" : "rejected"}</Badge>
                  {c.status === "APPLIED" && (
                    <span className="text-xs">
                      <span className="text-ok">+{c.additions}</span> <span className="text-sev-critical">−{c.deletions}</span>
                    </span>
                  )}
                  {[...new Set(c.flags)].map((f) => (
                    <Badge key={f} tone={c.status === "REJECTED" ? "critical" : "medium"}>
                      {FLAG_LABEL[f] ?? f}
                    </Badge>
                  ))}
                </div>
                <p className="break-words text-muted-foreground">{c.reason}</p>
                {c.diff && <Diff text={c.diff} />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {run.executions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Sandbox runs</CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 space-y-3 text-sm">
            {run.executions.map((e, i) => (
              <details key={i} className="min-w-0 rounded-md border p-2" open={i === run.executions.length - 1}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <Badge>#{e.iteration}</Badge>
                  <Badge>{e.kind === "INSTALL" ? "install" : "tests"}</Badge>
                  <Badge tone={e.exitCode === 0 ? "ok" : "critical"}>{e.timedOut ? "timed out" : `exit ${e.exitCode ?? "?"}`}</Badge>
                  <code className="min-w-0 break-all font-mono text-xs">{e.command}</code>
                  {e.network && <Badge tone="medium">network</Badge>}
                  {e.durationMs !== null && <span className="text-xs text-muted-foreground">{(e.durationMs / 1000).toFixed(1)} s</span>}
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">{e.output || "(no output)"}</pre>
                {e.outputTruncated && <p className="text-xs text-muted-foreground">Earlier output was truncated.</p>}
              </details>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1.5 text-sm">
            {run.events.map((e, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-0.5">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString()}</span>
                {e.toStatus && <Badge tone={RUN_STATUS[e.toStatus].tone}>{RUN_STATUS[e.toStatus].label}</Badge>}
                {/* On narrow screens the message takes its own full-width line instead of a squeezed column. */}
                <span className="order-last min-w-0 basis-full break-words sm:order-none sm:flex-1 sm:basis-0">{e.message}</span>
                <span className="ml-auto text-[11px] text-muted-foreground sm:ml-0">{e.actor}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
