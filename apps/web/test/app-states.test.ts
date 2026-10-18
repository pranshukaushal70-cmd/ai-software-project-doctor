import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderSearch } from "lucide-react";
import { describe, expect, it } from "vitest";
import AppError from "@/app/(app)/error";
import AppNotFound from "@/app/(app)/not-found";
import RootNotFound from "@/app/not-found";
import { initialsOf } from "@/components/user-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError } from "@/components/ui/form";
import { Notice } from "@/components/ui/notice";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("shared state components", () => {
  it("FormError is announced as an alert, and renders nothing without a message", () => {
    const out = html(createElement(FormError, { message: "Archives are limited to 50 MB" }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Archives are limited to 50 MB");
    expect(html(createElement(FormError, { message: null }))).toBe("");
    expect(html(createElement(FormError, {}))).toBe("");
  });

  it("Notice shows a title and body in the tone it is given", () => {
    const out = html(createElement(Notice, { tone: "error", title: "Reports could not be loaded", role: "alert" }, "Network error"));
    expect(out).toContain('role="alert"');
    expect(out).toContain("text-sev-critical");
    expect(out).toContain("Reports could not be loaded");
    expect(out).toContain("Network error");
    expect(html(createElement(Notice, { tone: "success" }, "Saved"))).toContain("text-ok");
  });

  it("EmptyState renders its title, text and action", () => {
    const out = html(createElement(EmptyState, { icon: FolderSearch, title: "No repositories yet", action: createElement("a", { href: "/new" }, "Analyze a repository") }, "Upload a ZIP."));
    expect(out).toContain("<h2");
    expect(out).toContain("No repositories yet");
    expect(out).toContain("Upload a ZIP.");
    expect(out).toContain('href="/new"');
    // A page whose only content is the state gets the page's h1.
    const page = html(createElement(EmptyState, { icon: FolderSearch, title: "Not found", headingLevel: 1 }));
    expect(page).toMatch(/<h1[^>]*>Not found<\/h1>/);
    expect(page).not.toContain("<h2");
  });

  it("initials take the first letter or digit of up to two words, never half an emoji", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("grace brewster hopper")).toBe("GB");
    expect(initialsOf("  élodie  ")).toBe("É");
    expect(initialsOf("🚀 Rocket Team")).toBe("RT");
    expect(initialsOf("😀")).toBe("?");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("2nd Team")).toBe("2T");
  });
});

describe("signed-in error and not-found pages", () => {
  it("the error page offers a retry and a way back, and never shows the error's message", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED postgres://doctor:secret@db:5432"), { digest: "1234567890" });
    const out = html(createElement(AppError, { error, retry: () => {} }));
    expect(out).toContain('role="alert"');
    expect(out).toMatch(/<h1[^>]*>This page could not be loaded<\/h1>/);
    expect(out).toContain("Try again");
    expect(out).toContain('href="/dashboard"');
    expect(out).toContain("Reference: 1234567890");
    expect(out).not.toMatch(/ECONNREFUSED|secret|postgres/);
  });

  it("the not-found page does not say whether the item exists", () => {
    const out = html(createElement(AppNotFound));
    expect(out).toMatch(/<h1[^>]*>Not found<\/h1>/);
    expect(out).toContain("This page does not exist, or you do not have access to it.");
    expect(out).toContain('href="/dashboard"');
  });

  it("unknown addresses get a branded page with a way home, not the framework default", () => {
    const out = html(createElement(RootNotFound));
    expect(out).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(out).toContain("This page does not exist.");
    expect(out).toContain('href="/"');
    expect(out).toContain('href="/dashboard"');
    expect(out).toContain("Project Doctor");
  });
});
