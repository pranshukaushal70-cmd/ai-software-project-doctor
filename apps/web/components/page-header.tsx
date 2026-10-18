import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The title block of an app page: icon, h1, description and optional actions. */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          {Icon && (
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground ring-1 ring-primary/20">
              <Icon className="size-5" aria-hidden />
            </span>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
        {description && <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
