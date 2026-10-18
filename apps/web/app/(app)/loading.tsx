import { Skeleton } from "@/components/ui/skeleton";

/** Shown at once while a page's data loads; the header and navigation stay in place. */
export default function AppLoading() {
  return (
    <div role="status">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-8 grid gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
