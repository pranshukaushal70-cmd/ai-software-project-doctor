import { PHASES } from "@/lib/scene";
import { cn } from "@/lib/utils";

/** The workflow the illustration walks through; `active` marks the step it is showing. */
export function SceneSteps({ active }: { active: number | null }) {
  return (
    <ol className="flex flex-wrap justify-center gap-1.5" aria-label="What the illustration shows">
      {PHASES.map((label, i) => (
        <li
          key={label}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors duration-500",
            active === i && "border-primary/50 bg-primary/10 text-foreground",
          )}
        >
          <span className={cn("size-1.5 rounded-full bg-muted-foreground/50 transition-colors duration-500", active === i && "bg-primary")} aria-hidden />
          {label}
        </li>
      ))}
    </ol>
  );
}
