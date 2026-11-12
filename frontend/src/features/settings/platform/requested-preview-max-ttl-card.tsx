import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import { readMinutes } from "@/lib/format/minutes";

import { useInstanceGate, usePlatformMutations } from "./use-platform";

/** The route's own bounds (`POST /settings/requested-preview-max-ttl`). */
const MOST_MINUTES = 10080;

/**
 * The longest any Requested preview on this instance may be asked to live.
 *
 * **Instance-wide, and beside Concurrent builds**, because the cost it bounds
 * is the Server's rather than any one Application's: a preview nobody
 * deliberately extended is gone within this many minutes. It is one column on
 * the settings row, `requestedPreviewMaxTtlMinutes`, 1440 until somebody sets
 * it, and it takes instance authority to write (ADR-0013) — the gate is the
 * same `useInstanceGate` Concurrent builds takes, so the two cannot disagree
 * about who may press their Save.
 *
 * **It caps each window from now, not a preview's whole life**: an extend sets
 * the expiry to now plus a TTL, and each extend is held to this again. A
 * request over it is refused and told the maximum, not clamped, so lowering it
 * never shortens a preview already running.
 *
 * **The 60-minute default is not a field.** A request that names no lifetime
 * gets 60 minutes, a backend constant, and the hint says
 * so rather than leaving it to be guessed from this number.
 */
export function RequestedPreviewMaxTtlCard({ value }: { value: number }) {
  const mutations = usePlatformMutations();
  // The platform host's own settings row, so instance authority (ADR-0013).
  const gate = useInstanceGate();

  return (
    <SettingsCard
      gate={gate}
      title="Requested preview lifetime"
      lede="The longest a Requested preview on this instance may be asked to live."
      schema={z.object({
        requestedPreviewMaxTtlMinutes: z.coerce
          .number()
          .int("Whole minutes only.")
          .min(1, "At least one minute.")
          .max(
            MOST_MINUTES,
            `A week (${MOST_MINUTES} minutes) is the most this accepts.`,
          ),
      })}
      fields={(values) => [
        {
          kind: "number",
          name: "requestedPreviewMaxTtlMinutes",
          label: "Longest a requested preview lives, in minutes",
          min: 1,
          max: MOST_MINUTES,
          hint: hint(values.requestedPreviewMaxTtlMinutes),
        },
      ]}
      defaultValues={{ requestedPreviewMaxTtlMinutes: value }}
      submit={(values) =>
        mutations.updateRequestedPreviewMaxTtl.mutateAsync(
          values.requestedPreviewMaxTtlMinutes,
        )
      }
      savedMessage="The requested preview maximum lifetime is saved."
      footer="A request or an extend asking for longer is refused and told this maximum. Lowering it does not shorten a preview already running."
    />
  );
}

function hint(minutes: unknown) {
  const read =
    typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0
      ? `${readMinutes(minutes)}. `
      : "";
  return `${read}A request that names no lifetime gets 60 minutes, and an extend starts a new window from now.`;
}
