import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground border-transparent",
      primary: "bg-accent text-accent-foreground border-transparent",
      critical: "bg-sev-critical/12 text-sev-critical border-sev-critical/25",
      high: "bg-sev-high/12 text-sev-high border-sev-high/25",
      medium: "bg-sev-medium/15 text-sev-medium border-sev-medium/30",
      low: "bg-sev-low/12 text-sev-low border-sev-low/25",
      ok: "bg-ok/12 text-ok border-ok/25",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
