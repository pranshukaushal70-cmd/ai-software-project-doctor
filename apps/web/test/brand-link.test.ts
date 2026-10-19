// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The "Project Doctor" brand link goes home (`/`) on every page, including inside the signed-in app. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "u1", name: "Ada Lovelace", email: "ada@example.test" }),
  getCurrentUser: async () => null,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
}));

const { default: AppLayout } = await import("@/app/(app)/layout");
const { default: AuthLayout } = await import("@/app/(auth)/layout");
const { default: LandingPage } = await import("@/app/page");
const { default: RootNotFound } = await import("@/app/not-found");

/** The href of the link whose text is the brand name. */
const brandHref = (html: string) => html.match(/<a[^>]*href="([^"]*)"[^>]*>(?:(?!<\/a>)[\s\S])*Project Doctor/)?.[1];

describe("brand link", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });

  it("in the signed-in header, clicking it navigates to /", async () => {
    // Next's <Link> hands a click to the router in context; this one records where it was sent.
    const push = vi.fn(async () => true);
    const router = { push, replace: vi.fn(), prefetch: vi.fn(async () => undefined) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const layout = await AppLayout({ children: createElement("p", null, "page") });
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(RouterContext.Provider, { value: router as never }, layout));
    });

    const link = [...container.querySelectorAll("header a")].find((a) => a.textContent?.includes("Project Doctor")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/");

    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/", expect.anything());
  });

  it("points to / on the landing, sign-in, sign-up and 404 pages too", async () => {
    expect(brandHref(renderToStaticMarkup(await LandingPage()))).toBe("/");
    expect(brandHref(renderToStaticMarkup(await AuthLayout({ children: null })))).toBe("/");
    expect(brandHref(renderToStaticMarkup(createElement(RootNotFound)))).toBe("/");
  });
});
