import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { z } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import { KVList, KVRow } from "@/components/console/kv-list";
import { SettingsCard } from "@/components/console/settings-card";
import { CLOUD_NAMES } from "@/lib/api/endpoints/cloud-accounts";
import {
  composeApi,
  STACK_VM_SIZE_WORDS,
  STACK_VM_SIZES,
  STACK_VM_STARTING_SIZE,
  type ComposeDetail,
  type StackVmSize,
} from "@/lib/api/endpoints/compose";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";
import { usd } from "@/lib/format/money";

import { COMPOSE_UPDATE_REFUSAL } from "../use-compose";

const SIZE_OPTIONS = STACK_VM_SIZES.map((size) => ({
  value: size,
  label: size,
  detail: STACK_VM_SIZE_WORDS[size],
}));

function stackVmSchema(minimumDiskGb: number) {
  return z.object({
    size: z.enum(STACK_VM_SIZES),
    dataDiskGb: z.coerce
      .number()
      .int("The data disk has to be a whole number of GB.")
      .min(
        minimumDiskGb,
        `The data disk only grows: it has ${minimumDiskGb} GB, so choose at least that.`,
      )
      .max(16384, "A Stack VM's data disk grows to 16 TB at most."),
  });
}

type StackVmValues = z.infer<ReturnType<typeof stackVmSchema>>;

/**
 * A stack's **Stack VM** (ADR-0070, #1372): the VM Cloudgate makes in the
 * stack's Cloud account and region to run it. It shows the machine type
 * with its CPU and memory, the data disk and its price, and whether the
 * Environment's plan has made it yet; and it holds the stack's size and
 * the data disk grown to.
 *
 * Like a database's RDS settings, these are Cloudgate's: a Save stores
 * them, the Environment's next plan shows the change with its old and new
 * prices, and its Apply makes it in the cloud account. The size is read
 * only while the stack is console-managed: a stack its Project config
 * describes takes its size from its entry. The data disk only grows.
 */
export function StackVmCard({ compose }: { compose: ComposeDetail }) {
  const facts = compose.stackVmFacts;
  // `PATCH /compose/:id/stack-vm` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (values: StackVmValues) =>
      composeApi.saveStackVm(compose.composeId, {
        size: values.size,
        dataDiskGb: values.dataDiskGb,
      }),
    onSuccess: () =>
      invalidate.compose({
        composeId: compose.composeId,
        environmentId: compose.environmentId,
      }),
  });
  if (!facts) return null;

  const size: StackVmSize =
    facts.console.sizeName ?? facts.sizeName ?? STACK_VM_STARTING_SIZE;
  const dataDiskGb = facts.console.dataDiskGb ?? facts.dataDiskGb;
  // The rows truncate at a narrow width, so each long one carries its full
  // reading as a title.
  const machine = facts.machine
    ? `${facts.machineType} (${facts.machine})`
    : facts.machineType;
  const disk = `${facts.dataDiskGb} GB, snapshotted daily, each snapshot kept ${facts.snapshotDays} days`;
  const cost =
    facts.monthlyUsd === null
      ? "Cloudgate's rate table has no price for this region"
      : `About ${usd(facts.monthlyUsd)} a month`;
  const fields: FieldSpec<StackVmValues>[] = [
    {
      kind: "select",
      name: "size",
      label: "Size",
      options: SIZE_OPTIONS,
      hint: "Its Stack VM runs the smallest machine type at least this large in both CPU and memory. A new size restarts the Stack VM. A stack its Project config describes takes its size from its entry instead.",
    },
    {
      kind: "number",
      name: "dataDiskGb",
      label: "Data disk (GB)",
      min: facts.dataDiskGb,
      hint: "Where its named volumes live, snapshotted daily. It only grows: a disk cannot shrink.",
    },
  ];

  return (
    <SettingsCard
      title="Stack VM"
      gate={{ allowed: canSave.allowed, refusal: COMPOSE_UPDATE_REFUSAL }}
      lede={`The VM this stack runs on in ${CLOUD_NAMES[facts.cloud]}, ${facts.region}. It is the stack's own: nothing else runs on it.`}
      schema={stackVmSchema(facts.dataDiskGb)}
      fields={fields}
      savedMessage="Saved. Check for changes to see it in the plan; Apply makes it in the cloud account."
      defaultValues={{ size, dataDiskGb }}
      submit={(values) => save.mutateAsync(values)}
      footer="Nothing changes on the Stack VM until a plan with it is applied."
    >
      <KVList>
        <KVRow label="Machine type" value={machine} title={machine} mono />
        <KVRow label="Data disk" value={disk} title={disk} />
        <KVRow label="Cost" value={cost} title={cost} />
        <KVRow
          label="Made"
          value={
            facts.made ? (
              "Yes"
            ) : (
              <span>
                Not yet: apply this Environment&rsquo;s{" "}
                <Link
                  href={`/projects/${compose.environment.project.projectId}/config`}
                  className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                >
                  plan
                </Link>{" "}
                to make it.
              </span>
            )
          }
        />
      </KVList>
    </SettingsCard>
  );
}
