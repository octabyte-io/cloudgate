import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthFallback } from "../_components/auth-fallback";
import { SelectOrganization } from "../_components/select-organization";

export const metadata: Metadata = { title: "Choose an Organization" };

export default function SelectOrganizationPage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <SelectOrganization />
    </Suspense>
  );
}
