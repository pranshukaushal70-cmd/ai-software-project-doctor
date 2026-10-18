import Link from "next/link";
import { Activity } from "lucide-react";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-lg bg-linear-135 from-primary to-violet text-primary-foreground shadow-[0_0_16px_-4px_var(--glow)]">
        <Activity className="size-4" strokeWidth={2.5} />
      </span>
      <span>
        Project Doctor
      </span>
    </Link>
  );
}
