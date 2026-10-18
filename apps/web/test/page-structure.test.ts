import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** Page structure for assistive technology: valid lists and landmarks. No database or session. */

const session = vi.hoisted(() => ({ current: null as null | { id: string; name: string; email: string } }));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "u1", name: "Ada", email: "ada@example.test" }),
  getCurrentUser: async () => session.current,
}));
vi.mock("@/server/services/analysis-service", () => ({
  listRepositories: async () => [
    {
      id: "r1",
      source: "GITHUB",
      owner: "acme",
      name: "shop",
      branch: "main",
      analyses: [{ id: "a1", status: "COMPLETED", createdAt: new Date("2026-10-01T00:00:00Z"), healthScore: 82 }],
    },
    { id: "r2", source: "ZIP", owner: null, name: "upload", branch: null, analyses: [{ id: "a2", status: "FAILED", createdAt: new Date("2026-10-02T00:00:00Z"), healthScore: null }] },
  ],
}));

const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");
const { default: LandingPage } = await import("@/app/page");
const { default: AuthLayout } = await import("@/app/(auth)/layout");
const { default: RootNotFound } = await import("@/app/not-found");

/** The single <main> of a page and what it contains. */
const mainOf = (html: string) => {
  expect(html.match(/<main\b/g)).toHaveLength(1);
  return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
};

describe("dashboard summary tiles", () => {
  it("are a labelled list of value-then-label items, not a malformed description list", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).not.toContain("<dl");
    expect(html).toMatch(/<ul[^>]*aria-labelledby="summary-caption"/);
    expect(html).toMatch(/<p id="summary-caption"[^>]*>\s*Status of the latest analysis/);

    const list = html.match(/<ul[^>]*aria-labelledby="summary-caption"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
    const items = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => (m[1] ?? "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    // Read in the order shown: the number, then what it counts.
    expect(items).toEqual(["2 Repositories", "1 Completed", "0 In progress", "1 Failed"]);
    // The icons are decoration.
    expect(list.match(/<svg[^>]*>/g)!.every((svg) => svg.includes('aria-hidden="true"'))).toBe(true);
  });
});

describe("landing page landmarks", () => {
  it("keeps the header a top-level banner and puts the hero heading inside the only <main>", async () => {
    const html = renderToStaticMarkup(await LandingPage());
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html.match(/<header\b/g)).toHaveLength(1);

    const header = html.indexOf("<header");
    const headerEnd = html.indexOf("</header>");
    const main = html.indexOf("<main");
    const mainEnd = html.indexOf("</main>");
    const h1 = html.indexOf("<h1");
    // The header closes before <main> opens, so it is not nested in it.
    expect(header).toBeLessThan(headerEnd);
    expect(headerEnd).toBeLessThan(main);
    expect(html.slice(header, headerEnd)).toContain('aria-label="Account"');
    // The hero heading and its actions are in <main>.
    expect(h1).toBeGreaterThan(main);
    expect(h1).toBeLessThan(mainEnd);
    expect(html.slice(main, mainEnd)).toContain("Analyze a Repository");
    expect(html.indexOf("<footer")).toBeGreaterThan(mainEnd);
  });
});

describe("pages outside the signed-in app have a <main> landmark", () => {
  it("the site-wide 404 page puts its heading and ways out in <main>", () => {
    const main = mainOf(renderToStaticMarkup(createElement(RootNotFound)));
    expect(main).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(main).toContain('href="/"');
  });

  it("sign-in and sign-up pages render their form inside <main>", async () => {
    const main = mainOf(renderToStaticMarkup(await AuthLayout({ children: createElement("h1", null, "Welcome back") })));
    expect(main).toContain("<h1>Welcome back</h1>");
  });

  it("still sends a signed-in user to the dashboard", async () => {
    session.current = { id: "u1", name: "Ada", email: "ada@example.test" };
    try {
      await expect(AuthLayout({ children: null })).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
    } finally {
      session.current = null;
    }
  });
});
