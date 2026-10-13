import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { AUTH_DIR, SANDBOX_EXPECTED } from "../../lib/env";
import { approvedRun, repairUser, type RunDto, waitForRun } from "../../lib/flows";

// The repair-consent checkbox in the browser (M1), against the production build with the Docker
// sandbox: unticked by default, and the approval request carries exactly what it shows; the
// server records the same decision. Runs as the repair-policy user, on the failing fixture.

test.use({ storageState: fileURLToPath(new URL("repair-state.json", AUTH_DIR)) });
test.describe.configure({ mode: "serial" });
test.skip(!SANDBOX_EXPECTED, "The approval card appears only with the Docker sandbox (E2E_SANDBOX=1).");

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  return errors;
};

/** Opens the planner on the task's run waiting for approval, and returns the repair checkbox. */
async function openApproval(page: Page, analysisId: string, task: RegExp) {
  await page.goto(`/planner?analysisId=${analysisId}`);
  await page.getByRole("button", { name: task }).click();
  await expect(page.getByText("Run the tests in the sandbox?")).toBeVisible({ timeout: 60_000 });
  return page.getByRole("checkbox", { name: /Allow up to 1 repair attempt if the tests fail/ });
}

/** Clicks the approval and returns the JSON body the page sent to the execute endpoint. */
async function approve(page: Page, runId: string): Promise<unknown> {
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/engineering/runs/${runId}/execute`));
  await page.getByRole("button", { name: "Approve and run tests" }).click();
  return (await sent).postDataJSON();
}

test("the repair checkbox is unticked by default, and the approval says so to the server", async ({ page }) => {
  const errors = errorsOf(page);
  const user = repairUser();
  const { analysisId, run } = await approvedRun(user, "tiny-node-failing", "Document the subtract function for the browser default check.", 2);
  expect(run.status).toBe("AWAITING_APPROVAL");

  const repair = await openApproval(page, analysisId, /Document the subtract function for the browser default check/);
  await expect(repair).toBeVisible();
  await expect(repair).not.toBeChecked();
  expect(await approve(page, run.id)).toEqual({ install: false, repair: false });

  const done: RunDto = await waitForRun(user, run.id, ["READY_FOR_REVIEW"]);
  expect(done.repair).toEqual({ approved: false, attemptsAllowed: 0, attemptsUsed: 0 });
  expect(done.executions.filter((e) => e.kind === "TEST")).toHaveLength(1);
  await expect(page.getByText(/Repair attempts after failing tests: not allowed \(0 used\)/)).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("ticking the checkbox sends repair: true, and the server records the consent", async ({ page }) => {
  const errors = errorsOf(page);
  const user = repairUser();
  const { analysisId, run } = await approvedRun(user, "tiny-node-failing", "Document the add function for the browser consent check.", 2);
  expect(run.status).toBe("AWAITING_APPROVAL");

  const repair = await openApproval(page, analysisId, /Document the add function for the browser consent check/);
  await expect(repair).not.toBeChecked();
  await repair.check();
  await expect(repair).toBeChecked();
  expect(await approve(page, run.id)).toEqual({ install: false, repair: true });

  const done = await waitForRun(user, run.id, ["READY_FOR_REVIEW"]);
  expect(done.repair).toEqual({ approved: true, attemptsAllowed: 1, attemptsUsed: 1 });
  expect(done.executions.filter((e) => e.kind === "TEST").map((e) => e.iteration)).toEqual([1, 2]);
  expect(errors).toEqual([]);
});
