import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import { LicenseLocked } from "@/features/enterprise/license-gate";
import { useFeatureLicensed } from "@/features/enterprise/use-feature-licensed";

import { useInstanceGate, usePlatformMutations } from "./use-platform";

/** The routes' own bounds (`POST /settings/cloud-runs-concurrency`, `…/cloud-run-time-limit`). */
const MOST_RUNS = 20;
const FEWEST_MINUTES = 5;
const MOST_MINUTES = 1440;

/**
 * The Cloud run pool limit and time limit.
 *
 * **Beside Concurrent builds, and under the same rule**: a Cloud run is a
 * `tofu` of about 0.8 GB on this host, so they wait in a pool of their own,
 * one at a time unless a licence lets more run — the licence notice is
 * `ConcurrentBuildsCard`'s, reused for the reason that card gives.
 *
 * **The time limit counts plan plus apply**, never time queued or building,
 * and is one limit for deploy, network and Delete runs. A run past it is
 * interrupted, then killed 5 minutes later, and ends as an error saying so —
 * which is what keeps a hung run from holding its state, and every cloud
 * deploy behind it, for ever.
 *
 * Two routes, one card: the two numbers are read together by whoever is
 * deciding how this host spends its memory on cloud work.
 */
export function CloudRunLimitsCard({
  concurrency,
  timeLimitMinutes,
}: {
  concurrency: number;
  timeLimitMinutes: number;
}) {
  const mutations = usePlatformMutations();
  // On the Hosted instance this is Octabyte's, so never locked.
  const status = useFeatureLicensed("concurrentCloudRuns");
  const unlicensed = status.licensed === false;
  // The platform host's own pool, so instance authority (ADR-0013).
  const gate = useInstanceGate();

  return (
    <SettingsCard
      gate={gate}
      title="Cloud runs"
      lede="How many Cloud runs this host runs at once, and how long one may take."
      schema={z.object({
        cloudRunsConcurrency: z.coerce
          .number()
          .int("Whole runs only.")
          .min(1, "At least one, or no cloud deploy would ever run.")
          .max(MOST_RUNS, `${MOST_RUNS} is the most this accepts.`),
        cloudRunTimeLimitMinutes: z.coerce
          .number()
          .int("Whole minutes only.")
          .min(FEWEST_MINUTES, `At least ${FEWEST_MINUTES} minutes.`)
          .max(
            MOST_MINUTES,
            `A day (${MOST_MINUTES} minutes) is the most this accepts.`,
          ),
      })}
      fields={[
        {
          kind: "number",
          name: "cloudRunsConcurrency",
          label: "At once",
          min: 1,
          max: MOST_RUNS,
          hint: "Each Cloud run is an OpenTofu process of about 0.8 GB on this machine.",
        },
        {
          kind: "number",
          name: "cloudRunTimeLimitMinutes",
          label: "Time limit, in minutes",
          min: FEWEST_MINUTES,
          max: MOST_MINUTES,
          hint: "Counts plan plus apply, not time queued or building. A run past it is interrupted, then killed 5 minutes later, and ends as an error.",
        },
      ]}
      defaultValues={{
        cloudRunsConcurrency: concurrency,
        cloudRunTimeLimitMinutes: timeLimitMinutes,
      }}
      submit={async (values) => {
        await mutations.updateCloudRunsConcurrency.mutateAsync(
          values.cloudRunsConcurrency,
        );
        await mutations.updateCloudRunTimeLimit.mutateAsync(
          values.cloudRunTimeLimitMinutes,
        );
      }}
      savedMessage={
        unlicensed
          ? "The Cloud run limits are saved. This host still runs one Cloud run at a time until a license is active."
          : "The Cloud run limits are saved."
      }
      footer="One limit for deploy, network and Delete runs, across every Organization on this instance."
    >
      {unlicensed ? (
        <LicenseLocked feature="concurrentCloudRuns">
          Running more than one Cloud run at a time is an enterprise feature.
          Without a license this host runs one at a time whatever is set here,
          and the rest wait in the pool — the value is kept and takes effect as
          soon as a license does.
        </LicenseLocked>
      ) : null}
    </SettingsCard>
  );
}
