/**
 * Code engine (Phase 8) run lifecycle. Pure and browser-safe: the web tier and the
 * worker use the same transition table, and every persisted status change is checked
 * against it, so a run can never skip a gate (e.g. reach TESTING without the user
 * approving the command).
 *
 *   QUEUED → MATERIALIZING → GENERATING → VALIDATING → APPLYING
 *     → AWAITING_APPROVAL ─(user approves the test command)→ [INSTALLING →] TESTING
 *         ├─ tests pass, or no iterations left ─→ READY_FOR_REVIEW
 *         └─ tests fail, iterations left ──────→ REPAIRING → VALIDATING → APPLYING → TESTING …
 *     → READY_FOR_REVIEW (sandbox disabled, or the user skips the tests) → DISCARDED
 *   Any non-terminal status → FAILED | CANCELLED.
 *
 * Must match the Prisma enum EngineeringRunStatus.
 */
export const ENGINEERING_RUN_STATUSES = [
  "QUEUED",
  "MATERIALIZING",
  "GENERATING",
  "VALIDATING",
  "APPLYING",
  "AWAITING_APPROVAL",
  "INSTALLING",
  "TESTING",
  "REPAIRING",
  "READY_FOR_REVIEW",
  "DISCARDED",
  "FAILED",
  "CANCELLED",
] as const;
export type EngineeringRunStatus = (typeof ENGINEERING_RUN_STATUSES)[number];

/** Runs that can no longer change. A READY_FOR_REVIEW run can still be discarded, so it is not terminal. */
export const TERMINAL_RUN_STATUSES: readonly EngineeringRunStatus[] = ["DISCARDED", "FAILED", "CANCELLED"];

/** The worker is (or will be) working on the run: at most one such run per plan. */
export const ACTIVE_RUN_STATUSES: readonly EngineeringRunStatus[] = ["QUEUED", "MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "INSTALLING", "TESTING", "REPAIRING"];

/** Statuses that run repository code in the sandbox: only reachable once the user approved the command. */
export const EXECUTION_RUN_STATUSES: readonly EngineeringRunStatus[] = ["INSTALLING", "TESTING"];

/** Statuses in which the run waits for the user rather than the worker. */
export const WAITING_RUN_STATUSES: readonly EngineeringRunStatus[] = ["AWAITING_APPROVAL", "READY_FOR_REVIEW"];

const ABORT: EngineeringRunStatus[] = ["FAILED", "CANCELLED"];

const TRANSITIONS: Record<EngineeringRunStatus, readonly EngineeringRunStatus[]> = {
  QUEUED: ["MATERIALIZING", ...ABORT],
  MATERIALIZING: ["GENERATING", ...ABORT],
  GENERATING: ["VALIDATING", ...ABORT],
  // Every proposed edit rejected: a repair attempt may follow while iterations remain; when none remain after an
  // earlier iteration applied changes, that result goes to review (READY_FOR_REVIEW).
  VALIDATING: ["APPLYING", "REPAIRING", "READY_FOR_REVIEW", ...ABORT],
  // READY_FOR_REVIEW directly when the sandbox is disabled. INSTALLING/TESTING only on repair iterations of a run whose
  // command the user already approved (each test run gets a fresh sandbox, so dependencies are installed again).
  APPLYING: ["AWAITING_APPROVAL", "INSTALLING", "TESTING", "READY_FOR_REVIEW", ...ABORT],
  // Leaving AWAITING_APPROVAL for INSTALLING/TESTING requires the user's approval of the command
  // (enforced by the caller, which records it); READY_FOR_REVIEW when the user skips the tests.
  AWAITING_APPROVAL: ["INSTALLING", "TESTING", "READY_FOR_REVIEW", ...ABORT],
  INSTALLING: ["TESTING", ...ABORT],
  TESTING: ["REPAIRING", "READY_FOR_REVIEW", ...ABORT],
  REPAIRING: ["VALIDATING", ...ABORT],
  READY_FOR_REVIEW: ["DISCARDED"],
  DISCARDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: EngineeringRunStatus, to: EngineeringRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The statuses a run may move to from `from`. */
export function nextRunStatuses(from: EngineeringRunStatus): readonly EngineeringRunStatus[] {
  return TRANSITIONS[from];
}

export const isTerminalRunStatus = (s: EngineeringRunStatus) => TERMINAL_RUN_STATUSES.includes(s);
export const isActiveRunStatus = (s: EngineeringRunStatus) => ACTIVE_RUN_STATUSES.includes(s);

/** Budgets a run is created with; the worker enforces them (Phase 8 milestone 5). */
export const ENGINEERING_RUN_LIMITS = {
  /** Edit-generation iterations: the first attempt plus repairs. */
  maxIterations: { min: 1, max: 3, default: 2 },
  /** Total LLM input + output tokens for the run. */
  tokenBudget: { min: 10_000, max: 400_000, default: 200_000 },
  /** Wall-clock limit for the worker's part of the run (waiting for the user does not count). */
  maxDurationSeconds: { min: 60, max: 3600, default: 1200 },
} as const;
