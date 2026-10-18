import Link from "next/link";
import { SearchX } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Unknown addresses anywhere in the site (the signed-in app has its own not-found page with the
 * navigation). No data is read: the same page for everyone.
 */
export default function NotFound() {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 opacity-60" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <EmptyState
          icon={SearchX}
          title="Page not found"
          headingLevel={1}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild>
                <Link href="/">Go to the home page</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/dashboard">Repositories</Link>
              </Button>
            </div>
          }
        >
          This page does not exist.
        </EmptyState>
      </div>
    </main>
  );
}
