import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const TONES: Record<"error" | "warning" | "info" | "success", { icon: LucideIcon; className: string }> = {
  error: { icon: XCircle, className: "border-sev-critical/30 bg-sev-critical/10 text-sev-critical" },
  warning: { icon: AlertTriangle, className: "border-sev-medium/35 bg-sev-medium/10 text-sev-medium" },
  info: { icon: Info, className: "border-primary/30 bg-primary/8 text-accent-foreground" },
  success: { icon: CheckCircle2, className: "border-ok/30 bg-ok/10 text-ok" },
};

/**
 * An inline message about the state of something: an error, a warning, information or a
 * success. Pass `role="alert"` for errors that appear after an action, so they are announced.
 */
export function Notice({
  tone = "info",
  title,
  children,
  className,
  ...props
}: { tone?: keyof typeof TONES; title?: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm", toneClass, className)} {...props}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 break-words">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "mt-0.5 text-muted-foreground")}>{children}</div>}
      </div>
    </div>
  );
}
