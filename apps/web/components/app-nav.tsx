"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Repositories" },
  { href: "/new", label: "New analysis" },
  { href: "/planner", label: "Planner" },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="hidden items-center gap-1 sm:flex" aria-label="Main">
      {LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
              active && "bg-muted text-foreground",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
