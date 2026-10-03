import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  canTransition,
  ENGINEERING_RUN_LIMITS,
  ENGINEERING_RUN_STATUSES,
  EXECUTION_RUN_STATUSES,
  isActiveRunStatus,
  isTerminalRunStatus,
  nextRunStatuses,
  TERMINAL_RUN_STATUSES,
  WAITING_RUN_STATUSES,
  type EngineeringRunStatus,
} from "./engine";

const walk = (path: EngineeringRunStatus[]) => path.every((s, i) => i === 0 || canTransition(path[i - 1]!, s));

describe("engineering run lifecycle", () => {
  it("allows the documented paths", () => {
    // Sandbox disabled: straight to review.
    expect(walk(["QUEUED", "MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "READY_FOR_REVIEW", "DISCARDED"])).toBe(true);
    // Approval, install, tests fail, one repair, tests re-run with the approved command, review.
    expect(walk(["QUEUED", "MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "AWAITING_APPROVAL", "INSTALLING", "TESTING", "REPAIRING", "VALIDATING", "APPLYING", "TESTING", "READY_FOR_REVIEW"])).toBe(true);
    // The user skips the tests.
    expect(walk(["APPLYING", "AWAITING_APPROVAL", "READY_FOR_REVIEW"])).toBe(true);
    // Every proposed edit rejected, then repaired.
    expect(walk(["VALIDATING", "REPAIRING", "VALIDATING"])).toBe(true);
  });

  it("refuses to skip stages", () => {
    expect(canTransition("QUEUED", "TESTING")).toBe(false);
    expect(canTransition("QUEUED", "READY_FOR_REVIEW")).toBe(false);
    expect(canTransition("GENERATING", "APPLYING")).toBe(false); // edits are always validated first
    expect(canTransition("REPAIRING", "APPLYING")).toBe(false);
    expect(canTransition("VALIDATING", "TESTING")).toBe(false);
    expect(canTransition("INSTALLING", "READY_FOR_REVIEW")).toBe(false);
    expect(canTransition("READY_FOR_REVIEW", "TESTING")).toBe(false);
    expect(canTransition("TESTING", "TESTING")).toBe(false);
  });

  it("lets every unfinished run fail or be cancelled, and nothing leave a terminal status", () => {
    for (const s of ENGINEERING_RUN_STATUSES) {
      if (isTerminalRunStatus(s)) {
        expect(nextRunStatuses(s)).toEqual([]);
      } else if (s === "READY_FOR_REVIEW") {
        expect(nextRunStatuses(s)).toEqual(["DISCARDED"]);
      } else {
        expect(canTransition(s, "FAILED")).toBe(true);
        expect(canTransition(s, "CANCELLED")).toBe(true);
      }
    }
  });

  it("reaches the execution statuses only from stages that follow an approval point", () => {
    for (const to of EXECUTION_RUN_STATUSES) {
      const sources = ENGINEERING_RUN_STATUSES.filter((s) => canTransition(s, to));
      expect(sources.every((s) => ["AWAITING_APPROVAL", "APPLYING", "INSTALLING"].includes(s))).toBe(true);
    }
    expect(canTransition("APPLYING", "INSTALLING")).toBe(false); // installs only right after the approval
  });

  it("classifies statuses consistently", () => {
    const groups = [TERMINAL_RUN_STATUSES, ACTIVE_RUN_STATUSES, WAITING_RUN_STATUSES];
    // Every status is in exactly one group.
    for (const s of ENGINEERING_RUN_STATUSES) expect(groups.filter((g) => g.includes(s))).toHaveLength(1);
    expect(isActiveRunStatus("TESTING")).toBe(true);
    expect(isActiveRunStatus("AWAITING_APPROVAL")).toBe(false);
    expect(isTerminalRunStatus("READY_FOR_REVIEW")).toBe(false);
  });

  it("has sane budget limits", () => {
    for (const l of Object.values(ENGINEERING_RUN_LIMITS)) {
      expect(l.min).toBeLessThanOrEqual(l.default);
      expect(l.default).toBeLessThanOrEqual(l.max);
    }
  });
});
