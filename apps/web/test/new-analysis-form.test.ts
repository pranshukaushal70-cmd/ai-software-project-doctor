import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NewAnalysisForm } from "@/components/new-analysis-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

describe("new analysis form", () => {
  it("keeps the Local-only lock icon at full size beside its long description on narrow screens", () => {
    const html = renderToStaticMarkup(createElement(NewAnalysisForm, { maxUploadMb: 50, zipUploadsEnabled: true }));
    const lock = html.match(/<svg[^>]*lucide-lock[^>]*>/)?.[0];
    expect(lock).toBeDefined();
    // A flex item shrinks by default; the paragraph beside it would squeeze the icon to a sliver.
    expect(lock).toMatch(/class="[^"]*\bsize-4\b[^"]*\bshrink-0\b/);
  });

  it("offers the ZIP upload tab only when uploads are enabled", () => {
    const withUploads = renderToStaticMarkup(createElement(NewAnalysisForm, { maxUploadMb: 50, zipUploadsEnabled: true }));
    expect(withUploads).toContain("Upload ZIP");
    expect(withUploads).toContain('role="tablist"');

    const urlOnly = renderToStaticMarkup(createElement(NewAnalysisForm, { maxUploadMb: 50, zipUploadsEnabled: false }));
    expect(urlOnly).not.toContain("Upload ZIP");
    expect(urlOnly).not.toContain('role="tablist"');
    expect(urlOnly).not.toContain('role="tabpanel"');
    expect(urlOnly).toContain('name="url"');
  });
});
