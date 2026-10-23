import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { signupEnabled } from "@/server/auth/signup";

export const metadata: Metadata = { title: "Create account" };

// Read per request: the (auth) layout reads the session cookie, so this page is never prerendered.
export default function SignupPage() {
  if (signupEnabled()) return <AuthForm mode="signup" />;
  return (
    <Card>
      <CardHeader>
        <h1 className="text-lg font-semibold">Registration is closed</h1>
        <CardDescription>This server is not accepting new accounts right now.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link className="text-primary hover:underline" href="/login">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
