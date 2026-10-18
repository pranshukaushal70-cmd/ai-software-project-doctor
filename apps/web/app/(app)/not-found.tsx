import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Shown for `notFound()` inside the signed-in app, with the header and navigation kept. Missing
 * and other users' items get the same words, so nothing reveals that an item exists.
 */
export default function AppNotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="Not found"
      headingLevel={1}
      action={
        <Button asChild>
          <Link href="/dashboard">Go to Repositories</Link>
        </Button>
      }
    >
      This page does not exist, or you do not have access to it.
    </EmptyState>
  );
}
