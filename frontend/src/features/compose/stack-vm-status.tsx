import { Chip } from "@/components/console/chip";
import type { StackVmStatus } from "@/lib/api/endpoints/compose";

import { useStackVmStatus } from "./use-compose";

/** What each state reads as, and how loud it is. */
const STATE: Record<
  StackVmStatus["state"],
  { word: string; variant: "ok" | "warn" | "default"; title?: string }
> = {
  running: { word: "Running", variant: "ok" },
  starting: { word: "Starting", variant: "default" },
  stopping: { word: "Stopping", variant: "default" },
  stopped: {
    word: "Stopped",
    variant: "default",
    title: "Only its disk is billed while it is stopped. Start brings it back.",
  },
  gone: {
    word: "Not found in the cloud",
    variant: "warn",
    title: "Its cloud no longer has this Stack VM.",
  },
  "not-made": {
    word: "Not made yet",
    variant: "default",
    title: "No Apply has made this Stack VM yet.",
  },
  unknown: { word: "Unknown", variant: "warn" },
};

/**
 * Whether the stack's Stack VM runs, as its cloud reads it now (ADR-0070,
 * #1370), so a VM problem can be told apart from an app problem: the
 * stack's Status says how its containers went, this says whether the
 * machine under them is up.
 */
export function StackVmRunState({ composeId }: { composeId: string }) {
  const status = useStackVmStatus(composeId);
  if (status.isError) {
    return (
      <Chip variant="warn" title={status.error.message}>
        Could not read
      </Chip>
    );
  }
  if (!status.data) return <span className="text-tx-3">Reading…</span>;
  const shown = STATE[status.data.state];
  return (
    <Chip variant={shown.variant} title={status.data.reason ?? shown.title}>
      {shown.word}
    </Chip>
  );
}
