// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "@/components/planner/run-panel";
import type { RunDto } from "@/components/planner/run-view";

/**
 * The run panel in a DOM: the repair and install opt-ins are real checkboxes, and the
 * approval sends exactly what they show. fetch is replaced; nothing leaves the test.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function awaitingRun(extra: Partial<RunDto> = {}): RunDto {
  return {
    id: "run1",
    status: "AWAITING_APPROVAL",
    inProgress: false,
    provider: "anthropic",
    model: "claude-opus-5-5",
    commitSha: null,
    maxIterations: 2,
    tokenBudget: 200000,
    iteration: 1,
    inputTokens: 1200,
    outputTokens: 300,
    installApproved: false,
    executionApprovedAt: null,
    cancelRequestedAt: null,
    failureReason: null,
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    finishedAt: null,
    summary: "Trims the user name.",
    notes: [],
    hasPatch: true,
    repair: { approved: null, attemptsAllowed: null, attemptsUsed: 0 },
    testSetup: {
      id: "npm",
      runtime: "node",
      image: "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
      needsInstall: false,
      notes: [],
      install: { id: "npm-ci", command: "npm ci --ignore-scripts --no-audit --no-fund --loglevel=error" },
      test: { id: "npm-test", command: "npm test" },
    },
    sandbox: { enabled: true, installEnabled: true },
    events: [],
    changes: [],
    executions: [],
    ...extra,
  };
}

interface Request {
  method: string;
  url: string;
  body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let requests: Request[];

/** Serves the run waiting for approval, and records every request (the approval's body included). */
function serve(run: RunDto) {
  const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null });
    if (method === "GET" && url === "/api/engineering/plans/p1/runs") return ok([{ id: run.id }]);
    if (method === "GET" && url === `/api/engineering/runs/${run.id}`) return ok(run);
    if (method === "POST" && url === `/api/engineering/runs/${run.id}/execute`) return ok({ ...run, status: "TESTING", inProgress: false, executionApprovedAt: "2026-10-03T10:01:00.000Z" });
    return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Not found" } }), { status: 404 });
  });
}

/** Lets pending fetches and state updates settle. */
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

async function mount(run: RunDto) {
  serve(run);
  await act(async () => {
    root.render(createElement(RunPanel, { planId: "p1", approvedAt: "2026-10-03T09:59:00.000Z" }));
  });
  await settle();
}

/** The checkbox inside the label whose text contains `text`, or null. */
const checkbox = (text: string) =>
  [...container.querySelectorAll("label")].find((l) => l.textContent?.includes(text))?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;
const click = (el: HTMLElement | null) => act(async () => void el!.click());
const approvals = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/execute"));

beforeEach(() => {
  requests = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("RunPanel approval in the DOM", () => {
  it("leaves the repair checkbox unchecked by default and approves without repair attempts", async () => {
    await mount(awaitingRun());
    const repair = checkbox("repair attempt");
    expect(repair).not.toBeNull();
    expect(repair!.checked).toBe(false);
    expect(container.textContent).toContain("Allow up to 1 repair attempt if the tests fail");

    await click(button("Approve and run tests"));
    await settle();
    expect(approvals()).toEqual([{ method: "POST", url: "/api/engineering/runs/run1/execute", body: { install: false, repair: false } }]);
  });

  it("sends repair: true only after the user ticks the checkbox", async () => {
    await mount(awaitingRun({ maxIterations: 3 }));
    const repair = checkbox("repair attempt")!;
    expect(container.textContent).toContain("Allow up to 2 repair attempts if the tests fail");
    await click(repair);
    expect(repair.checked).toBe(true);

    await click(button("Approve and run tests"));
    await settle();
    expect(approvals().map((r) => r.body)).toEqual([{ install: false, repair: true }]);
  });

  it("sends repair: false again when the checkbox is ticked and then cleared", async () => {
    await mount(awaitingRun());
    const repair = checkbox("repair attempt")!;
    await click(repair);
    await click(repair);
    expect(repair.checked).toBe(false);
    await click(button("Approve and run tests"));
    await settle();
    expect(approvals().map((r) => r.body)).toEqual([{ install: false, repair: false }]);
  });

  it("keeps the install and repair opt-ins independent", async () => {
    await mount(awaitingRun());
    await click(checkbox("Also install dependencies first"));
    await click(button("Approve and run tests"));
    await settle();
    expect(approvals().map((r) => r.body)).toEqual([{ install: true, repair: false }]);
  });

  it("offers no repair checkbox and sends repair: false when the budget has no attempts left", async () => {
    await mount(awaitingRun({ maxIterations: 1 }));
    expect(checkbox("repair attempt")).toBeNull();
    expect(container.textContent).toContain("budget has no repair attempts left");
    await click(button("Approve and run tests"));
    await settle();
    expect(approvals().map((r) => r.body)).toEqual([{ install: false, repair: false }]);
  });
});
