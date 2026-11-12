import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import { LicenseLocked } from "@/features/enterprise/license-gate";
import { useFeatureLicensed } from "@/features/enterprise/use-feature-licensed";

import { useInstanceGate, usePlatformMutations } from "./use-platform";

/**
 * How many Deployments this host builds at once — and the fact that more than
 * one of them needs a licence.
 *
 * The gate is not this card's: `createBuildsConcurrencyResolver` answers `1`
 * for every partition before it ever reads the configured value, unless the
 * instance holds a valid licence. So the number here is stored, is kept, and
 * takes effect the moment a licence does — but on an unlicensed instance the
 * queue serializes builds whatever it says. A card that reported "saved" and
 * nothing else left an operator raising it, watching the second Deployment
 * queue anyway, and with nowhere to learn why.
 *
 * ## Why the notice rather than a refusal
 *
 * Refusing to save a `2` would throw away a value that is correct for this host
 * and wrong only for today's licence, and the operator would have to come back
 * and set it again after activating one. So it saves, and **the toast says what
 * actually happens** rather than a bare success — the second half of what the
 * card owes the reader, since the notice is above the field and the toast is
 * what they are looking at when they press Save.
 *
 * `LicenseLocked` is reused rather than reworded. It is the block every other
 * licensed surface shows, down to the sentence and the link to License, and
 * U14's point was that they are word-for-word identical across the screens that
 * carry them; a second hand-written paragraph is how one condition ends up with
 * two descriptions. What it is **not** is `LicenseGate`: this setting is a
 * single column on the one settings row, readable and writable by an owner
 * without a licence, so hiding the field would hide a value that is really
 * there.
 *
 * The licence read is this Organization's (`GET /license/status`), which is
 * what every other lock on the console asks. The queue asks
 * `hasAnyValidLicense()` — a partition belongs to no Organization — so on a
 * multi-Organization instance where somebody *else* holds the licence, this
 * card is stricter than the queue. It says nothing while the read is in flight
 * or has failed: `licensed === undefined` is not a fact about the instance.
 */
export function ConcurrentBuildsCard({ value }: { value: number }) {
  const mutations = usePlatformMutations();
  // On the Hosted instance this is Octabyte's, so never locked.
  const status = useFeatureLicensed("concurrentBuilds");
  const unlicensed = status.licensed === false;
  // The platform host's own queue, so instance authority (ADR-0013).
  const gate = useInstanceGate();

  return (
    <SettingsCard
      gate={gate}
      title="Concurrent builds"
      lede="How many Deployments this host builds at once."
      schema={z.object({
        buildsConcurrency: z.coerce
          .number()
          .int("Whole builds only.")
          .min(1, "At least one, or nothing would ever build.")
          .max(100, "One hundred is the most this accepts."),
      })}
      fields={[
        {
          kind: "number",
          name: "buildsConcurrency",
          label: "At once",
          min: 1,
          max: 100,
          hint: "Each concurrent build is a full image build — CPU, memory and disk on this machine.",
        },
      ]}
      defaultValues={{ buildsConcurrency: value }}
      submit={(values) =>
        mutations.updateBuildsConcurrency.mutateAsync(values.buildsConcurrency)
      }
      savedMessage={
        unlicensed
          ? "The build concurrency is saved. This host still builds one Deployment at a time until a license is active."
          : "The build concurrency is saved."
      }
      footer="This applies to builds on this host. A Server with its own build capacity is configured on that Server."
    >
      {unlicensed ? (
        <LicenseLocked feature="concurrentBuilds">
          Building more than one Deployment at a time is an enterprise feature.
          Without a license this host builds one at a time whatever is set here,
          and the rest of the Deployments wait in the queue — the value is kept
          and takes effect as soon as a license does.
        </LicenseLocked>
      ) : null}
    </SettingsCard>
  );
}
