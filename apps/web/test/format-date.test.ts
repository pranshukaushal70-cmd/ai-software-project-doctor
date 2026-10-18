// @vitest-environment happy-dom
import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisView, type AnalysisDto } from "@/components/analysis/analysis-view";
import { formatDate } from "@/lib/utils";

/**
 * Dates are rendered on a UTC server and hydrated in the viewer's browser. Formatting must not
 * depend on either machine's time zone, or the hydrated text differs from the server's (React #418).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RealDateTimeFormat = Intl.DateTimeFormat;

/** Makes Intl default to this time zone, as on a server or in a viewer's browser; an explicit timeZone still wins. */
function simulateTimeZone(timeZone: string) {
  const Simulated = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new RealDateTimeFormat(locales, { timeZone, ...options });
  } as unknown as typeof Intl.DateTimeFormat;
  Simulated.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf;
  Intl.DateTimeFormat = Simulated;
}

afterEach(() => {
  Intl.DateTimeFormat = RealDateTimeFormat;
});

describe("formatDate", () => {
  it("formats in UTC and says so", () => {
    expect(formatDate("2026-10-18T20:45:00Z")).toBe("Oct 18, 2026, 8:45 PM UTC");
  });

  it("formats a Date like its ISO string", () => {
    expect(formatDate(new Date("2026-10-18T20:45:00Z"))).toBe(formatDate("2026-10-18T20:45:00Z"));
  });

  it("gives the same text in an Asia/Kolkata browser, even across the date line", () => {
    const utc = formatDate("2026-10-18T20:45:00Z");
    simulateTimeZone("Asia/Kolkata");
    // The simulation is live: an unzoned format would read Oct 19, 2:15 AM here.
    expect(new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date("2026-10-18T20:45:00Z"))).toBe("2:15 AM");
    expect(formatDate("2026-10-18T20:45:00Z")).toBe(utc);
  });
});

describe("analysis page date hydration", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });

  it("hydrates the server's date text in an Asia/Kolkata browser without a mismatch", async () => {
    // Completed without a summary: only the header, which shows the creation date, renders.
    const initial: AnalysisDto = {
      id: "a1",
      status: "COMPLETED",
      stage: "COMPLETED",
      progress: 100,
      mode: "LOCAL_ONLY",
      analyzerVersion: "0.5.0",
      commitSha: null,
      error: null,
      summary: null,
      scoreBreakdown: null,
      createdAt: "2026-10-01T00:00:00Z",
      startedAt: null,
      finishedAt: null,
      repository: { id: "r1", name: "shop", owner: null, url: null, source: "ZIP", branch: null },
    };
    // The server renders in UTC (as the web container does), whatever this machine's zone is.
    simulateTimeZone("UTC");
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(AnalysisView, { initial }));
    document.body.appendChild(container);

    simulateTimeZone("Asia/Kolkata");
    const onRecoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, createElement(AnalysisView, { initial }), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Oct 1, 2026, 12:00 AM UTC");
  });
});
