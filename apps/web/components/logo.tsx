import Link from "next/link";
import { Activity } from "lucide-react";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
        <Activity className="size-4" strokeWidth={2.5} />
      </span>
      <span>
        Project Doctor
      </span>
    </Link>
  );
}
