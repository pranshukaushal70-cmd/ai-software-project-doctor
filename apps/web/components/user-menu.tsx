"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "./ui/button";
import { api } from "@/lib/api-client";

/** Up to two initials: the first letter or digit of the first two words (never half an emoji). */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => Array.from(w).find((c) => /[\p{L}\p{N}]/u.test(c)))
      .filter((c): c is string => Boolean(c))
      .slice(0, 2)
      .map((c) => c.toUpperCase())
      .join("") || "?"
  );
}

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const initials = initialsOf(name);

  return (
    <div className="flex items-center gap-2">
      <div className="hidden text-right leading-tight md:block">
        <div className="text-sm font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{email}</div>
      </div>
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-full bg-linear-135 from-primary/25 to-violet/25 text-xs font-semibold text-foreground ring-1 ring-primary/30"
      >
        {initials}
      </span>
      <Button variant="ghost" size="icon" aria-label="Sign out" onClick={logout} disabled={pending}>
        <LogOut />
      </Button>
    </div>
  );
}
