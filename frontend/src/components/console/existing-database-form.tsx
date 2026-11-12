import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import {
  Controller,
  useFormContext,
  type DefaultValues,
  type FieldValues,
} from "react-hook-form";
import type { ZodType } from "zod";

import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Checkbox } from "@/components/ui/checkbox";
import {
  existingRdsApi,
  type ExistingReach,
} from "@/lib/api/endpoints/existing-postgres";
import { existingRedisApi } from "@/lib/api/endpoints/existing-redis";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

// No "use client" here: its modals' importers are the entry (§3.2).

/** `POST /:kind/existing` is `service: ['create']`, as any create. */
export const USE_EXISTING_REFUSAL = roleRefusal(
  "use an existing database for a Service",
);

/**
 * What every "Use an existing database" form shares: the
 * reach it shows while open, the save gated by `service: [permission]`, the
 * database and its Environment — whose plan is under it — refreshed after,
 * and the toast that says what the next plan does. The fields are the
 * engine's own.
 */
export function useExistingForm<Values extends FieldValues>({
  kind,
  environmentId,
  open,
  schema,
  defaultValues,
  permission,
  save,
  refreshes,
  done,
  onClose,
}: {
  kind: "postgres" | "mysql" | "redis";
  environmentId: string;
  open: boolean;
  schema: ZodType<Values>;
  defaultValues: DefaultValues<Values>;
  permission: "create" | "update";
  save: (values: Values) => Promise<unknown>;
  /** The database the save changes, when it is one already. */
  refreshes?: { kind: string; databaseId: string };
  done: (values: Values) => { title: string; description: string };
  onClose: () => void;
}) {
  const { organizationId } = useActiveOrganizationId();
  const invalidate = useInvalidate();
  const allowed = usePermission({ service: [permission] });
  const reach = useQuery({
    queryKey: keys.environments.existingReach(
      organizationId,
      environmentId,
      kind,
    ),
    queryFn: () =>
      (kind === "redis" ? existingRedisApi : existingRdsApi(kind)).reach(
        environmentId,
      ),
    enabled: open && organizationId !== null,
  });
  const saved = useMutation({
    mutationFn: save,
    onSuccess: () => invalidate.database({ ...refreshes, environmentId }),
  });
  const form = useApiForm<Values>({
    schema,
    defaultValues,
    onSubmit: async (values) => {
      if (!allowed.allowed) {
        form.setError("root", {
          type: "manual",
          message: USE_EXISTING_REFUSAL,
        });
        return;
      }
      await saved.mutateAsync(values);
      const { title, description } = done(values);
      toast.done(title, { description });
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  return { form, reach: reach.data };
}

/** A tick on an existing database's form, with what it means beneath. */
export function Tick({
  name,
  label,
  hint,
}: {
  name: string;
  label: ReactNode;
  hint: ReactNode;
}) {
  const { control } = useFormContext();
  const id = useId();
  return (
    <div className="mt-3.5 flex items-start gap-2.5">
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <Checkbox
            id={id}
            checked={field.value as boolean}
            onCheckedChange={(next) => field.onChange(next === true)}
          />
        )}
      />
      <label htmlFor={id} className="text-body text-tx">
        {label}
        <span className="mt-0.5 block text-meta text-tx-2">{hint}</span>
      </label>
    </div>
  );
}

/**
 * Where this Environment's Services reach a database from, to let in, on
 * its engine's port.
 */
export function LetIn({ reach }: { reach: ExistingReach | undefined }) {
  if (!reach) return null;
  // On Google Cloud Cloudgate makes its own endpoint and checks the
  // reach at every plan: what the operator may need is the allow list and,
  // for another project, a read grant.
  if (reach.google) {
    return (
      <div className="mt-3.5 grid gap-1 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-meta text-tx-2">
        <p className="font-medium text-tx">
          Cloudgate reaches it through an endpoint of its own
        </p>
        <p>
          Nothing is changed on the instance. Its allowed consumer projects must
          list <span className="font-mono">{reach.google.projectId}</span>; the
          plan says so, with the command, when they do not.
        </p>
        <p>
          In another project, let Cloudgate read it so every plan can look it
          up:{" "}
          <span className="font-mono break-all">{reach.google.readGrant}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3.5 grid gap-1 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-meta text-tx-2">
      <p className="font-medium text-tx">
        Let this Environment&apos;s Services in on port {reach.port}
      </p>
      <p>
        Cloudgate never changes the database&apos;s security groups. Its
        Services run in{" "}
        {reach.vpcId ? (
          <span className="font-mono">{reach.vpcId}</span>
        ) : (
          "the Environment network it makes with its first cloud Service"
        )}{" "}
        ({reach.cloudAccountName}, {reach.region}), in{" "}
        <span className="font-mono">{reach.serviceSubnets.join(", ")}</span>.
      </p>
      {reach.securityGroups.length > 0 ? (
        <p>
          Their security groups:{" "}
          {reach.securityGroups.map((group, at) => (
            <span key={group.groupName}>
              {at > 0 ? ", " : null}
              <span className="font-mono">{group.groupName}</span> (
              {group.configName})
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  );
}
