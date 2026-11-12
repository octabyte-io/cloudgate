import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthFallback } from "../_components/auth-fallback";
import { DeviceApproval } from "../_components/device-approval";

export const metadata: Metadata = { title: "Log in the Cloudgate CLI" };

/**
 * Where `cloudgate login` sends the person: `<instance>/device`. In
 * the door's layout rather than the console shell, since it is one question,
 * but not an auth path: the proxy gates it like a console screen, so a
 * signed-out visitor signs in first and comes back here with `?user_code=`
 * intact.
 */
export default function DevicePage() {
  return (
    <Suspense fallback={<AuthFallback />}>
      <DeviceApproval />
    </Suspense>
  );
}
