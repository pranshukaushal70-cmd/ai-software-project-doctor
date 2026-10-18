import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "./card";

/**
 * What a page or panel shows when there is nothing yet: an icon, a title, a sentence and an
 * optional action. `headingLevel` 1 is for pages whose only content is this state.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
  headingLevel = 2,
}: {
  icon: LucideIcon;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <Card className={cn("relative grid place-items-center overflow-hidden px-6 py-14 text-center", className)}>
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 opacity-50" />
      <span className="glow relative mb-4 grid size-12 place-items-center rounded-xl bg-accent text-accent-foreground ring-1 ring-primary/25">
        <Icon className="size-6" aria-hidden />
      </span>
      {title && <Heading className="relative font-medium">{title}</Heading>}
      {children && <div className="relative mt-1 max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="relative mt-5">{action}</div>}
    </Card>
  );
}
