import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-provider";
import { UserMenu } from "@/components/user-menu";
import { AppNav } from "@/components/app-nav";
import { requireUser } from "@/server/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <Logo />
              <AppNav />
            </div>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <UserMenu name={user.name} email={user.email} />
            </div>
          </div>
          <AppNav variant="mobile" />
        </div>
        {/* A faint cyan-to-violet hairline under the header. */}
        <div aria-hidden className="absolute inset-x-0 -bottom-px h-px bg-linear-to-r from-transparent via-primary/40 to-transparent" />
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
