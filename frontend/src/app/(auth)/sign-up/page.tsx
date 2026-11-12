import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthFallback } from "../_components/auth-fallback";
import { SignUpForm } from "../_components/sign-up-form";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <SignUpForm />
    </Suspense>
  );
}
