import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthFallback } from "../_components/auth-fallback";
import { ForgotPasswordForm } from "../_components/forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
