import { expect, type Page, test } from "@playwright/test";
import { reviewedRun, users } from "../../lib/flows";

// The browser flows of Phases 1, 5, 6, 8 and 9 against the production build: sign-up, the
// demo analysis and every tab, the planner's run review, and reports. Each test fails on
// uncaught page errors and console errors.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  return errors;
};

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-up leads to the dashboard; protected pages redirect to login", async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/signup");
    await page.getByLabel("Name").fill("E2E Browser");
    await page.getByLabel("Email").fill(`e2e-browser-${Date.now()}@example.test`);
    await page.getByLabel("Password").fill("e2e-browser-password");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    expect(errors).toEqual([]);
  });
});

test("the demo analysis runs in the browser and every tab renders", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto("/new");
  await page.getByRole("button", { name: "Try the demo project" }).click();
  await expect(page).toHaveURL(/\/analysis\/[a-z0-9]+/i);
  const tabs = page.getByRole("tablist", { name: "Analysis sections" });
  await expect(tabs).toBeVisible({ timeout: 180_000 });

  for (const name of ["Overview", "Code quality", "Security", "Dependencies", "Architecture", "Practices", "Health", "Intelligence", "All findings"]) {
    await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }

  // Phase 6: the Intelligence tab shows the repository index.
  await tabs.getByRole("tab", { name: /^Intelligence/ }).click();
  await expect(page.getByRole("heading", { name: "Repository manifest" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Symbols", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Impact analysis" })).toBeVisible();

  // Phase 5: the findings list names a planted issue.
  await tabs.getByRole("tab", { name: /^All findings/ }).click();
  await expect(page.getByRole("tabpanel").getByText("src/db.js").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the analysis page fits a 390 px screen without horizontal scrolling", async ({ page }) => {
  const { owner } = users();
  const { analysisId } = await reviewedRun(owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/analysis/${analysisId}`);
  await expect(page.getByRole("tablist", { name: "Analysis sections" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the planner shows the reviewed run and its reports open", async ({ page }) => {
  const errors = errorsOf(page);
  const { owner } = users();
  const { analysisId } = await reviewedRun(owner);
  await page.goto(`/planner?analysisId=${analysisId}`);
  await page.getByRole("button", { name: /Document the multiply function/ }).click();
  await expect(page.getByText(/Plan approved/)).toBeVisible();
  await expect(page.getByText("Download patch")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Run report" }).click();
  await expect(page).toHaveURL(/\/reports\/[a-z0-9]+/i);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});
