"use client"; // Error boundaries must be Client Components.

import Link from "next/link";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Shown when a signed-in page fails to render. It never shows the error's message (in
 * production a server error's message is generic anyway); the digest identifies the failure
 * in the server log.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert">
      <EmptyState
        icon={TriangleAlert}
        title="This page could not be loaded"
        headingLevel={1}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => retry()}>
              <RotateCw /> Try again
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard">Go to Repositories</Link>
            </Button>
          </div>
        }
      >
        Something went wrong while loading this page. Try again in a moment.
        {error.digest && <span className="mt-2 block font-mono text-xs">Reference: {error.digest}</span>}
      </EmptyState>
    </div>
  );
}
