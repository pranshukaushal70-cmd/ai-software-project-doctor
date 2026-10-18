"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Repositories", also: ["/analysis"] },
  { href: "/new", label: "New analysis", also: [] },
  { href: "/planner", label: "Planner", also: [] },
  { href: "/reports", label: "Reports", also: [] },
];

/** A link is active on its own page and below it; analyses belong to Repositories. */
export function isActive(pathname: string, href: string, also: readonly string[] = []): boolean {
  return [href, ...also].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** The main navigation: inline in the header from `sm` up, a scrollable row below it on phones. */
export function AppNav({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const pathname = usePathname();
  return (
    <nav
      className={cn(
        variant === "desktop" ? "hidden items-center gap-1 sm:flex" : "-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 sm:hidden",
      )}
      aria-label="Main"
    >
      {LINKS.map((l) => {
        const active = isActive(pathname, l.href, l.also);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative shrink-0 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              active && "bg-muted text-foreground",
              active && variant === "desktop" && "after:absolute after:inset-x-3 after:-bottom-[11px] after:h-px after:bg-primary after:shadow-[0_0_8px_var(--primary)]",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
