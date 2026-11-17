import { MongoKernelText } from "@/components/console/mongo-kernel";
import type { RuntimeInfo } from "@/lib/api/endpoints/settings";

import type { AuditFinding } from "./audit-findings";

/**
 * The kernel, as one more finding under What is installed (#104).
 *
 * Read off `GET /settings/runtime-info` rather than the readiness script:
 * that probe already asks the host for its kernel, in the Ubuntu-safe way
 * (`runtime-probe.ts`), and the tab's aside already holds its answer under
 * the same cache key, so the row costs no second SSH session. The readiness
 * script answers "can this host be set up", and a kernel is not something
 * setup installs.
 *
 * No row when the kernel was not read (a member's 403, a host that did not
 * answer): the card's own sentences already cover the second, and an empty
 * Kernel row beside four readings would read as a fault.
 */
export function kernelFindings(info: RuntimeInfo | undefined): AuditFinding[] {
  const kernel = info?.kernel.observed;
  if (!info || !kernel) return [];
  const refused = info.mongoRefusesKernel === true;
  return [
    {
      title: "Kernel",
      reading: `Linux ${kernel}`,
      tone: refused ? "warn" : "ok",
      fix: refused ? <MongoKernelText kernel={kernel} /> : undefined,
    },
  ];
}
