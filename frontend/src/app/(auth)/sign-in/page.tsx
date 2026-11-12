import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthFallback } from "../_components/auth-fallback";
import { SignInForm } from "../_components/sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Every screen in this group has the same two-line body: the document title, and
 * one client component that owns the panel.
 *
 * The panel is not up here because most of these screens *change* their title —
 * a spent reset link is not "Choose a new password", and an already-set-up
 * instance is not "Set up this instance". Keeping the heading with the state that
 * decides it is what stops a screen contradicting itself in its own h1.
 *
 * The `Suspense` boundary is required, not stylistic: these forms read `?next=`
 * and `?token=` with `useSearchParams`, which Next will not prerender without one.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <SignInForm />
    </Suspense>
  );
}
