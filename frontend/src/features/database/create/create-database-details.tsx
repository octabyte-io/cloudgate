import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { ResourceField } from "@/components/console/resource-field";
import { Stepper } from "@/components/console/stepper";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { useServers } from "@/lib/api/use-servers";
import { useCreateServerPicker } from "@/lib/forms/create-server-picker";

import {
  DATABASE_KIND,
  blankValues,
  connectionFields,
  databaseSchema,
  imageField,
  toCreateInput,
  type DatabaseFormValues,
} from "../kinds";
import { useCreateDatabase } from "../use-database";
import { STEPS } from "./create-database-steps";
import { example } from "@/components/console/form-spec";

/**
 * Step two — that engine's own fields, from its own `columns`.
 *
 * Redis asks for a name and a password, MySQL asks for six things, and this file
 * names no engine. **`POST /:kind` returns the new row**, which is what lets the
 * flow end on the new database's own Overview rather than on a list.
 */
export function Details({
  kind,
  environmentId,
  deployTarget,
  onBack,
  onDone,
}: {
  kind: DatabaseKind;
  environmentId: string;
  deployTarget: DeployTarget;
  onBack: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const descriptor = DATABASE_KIND[kind];
  const create = useCreateDatabase(environmentId);
  const servers = useServers();
  const picker = useCreateServerPicker(deployTarget);
  const [serverId, setServerId] = useState("");

  const form = useApiForm<DatabaseFormValues>({
    schema: databaseSchema(kind, "create"),
    defaultValues: blankValues(kind) as never,
    onSubmit: async (values) => {
      const row = await create.mutateAsync({
        kind,
        input: toCreateInput(
          kind,
          values,
          environmentId,
          picker.serverIdOf(serverId),
        ),
      });

      // The response is keyed by the engine's own id column. Reading it back
      // through the same map `findOne` uses would mean exporting that map; the
      // row carries exactly one `*Id` that is not `environmentId` or `serverId`,
      // and `databasesApi.create` types it as the raw response, so this is the
      // one place that has to pick it out.
      const id = newDatabaseId(row);
      toast.done(`${values.name} created.`, {
        description: "It is not deployed yet — deploy it from its Overview.",
      });
      onDone();
      if (id) router.push(`/databases/${kind}/${id}`);
    },
    onError: (error) => toast.error(error),
  });

  const values = form.watch() as DatabaseFormValues;

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit}>
        <Modal.Body>
          <Stepper
            label="Add a database"
            steps={[
              { id: "kind", label: `${descriptor.label} chosen`, done: true },
              { id: "details", label: STEPS[1].label },
            ]}
            currentId="details"
            onSelect={(id) => {
              if (id === "kind") onBack();
            }}
          />

          {/* The step's body replaces the engine grid in place: fade, while
              the Stepper above stays put and says where this is. */}
          <div className="flex animate-fade flex-col gap-3.5">
            <ResourceField
              spec={{
                kind: "text",
                name: "name",
                label: "Name",
                placeholder: example("Storefront orders"),
                hint: "What this database is called in Cloudgate. Its Swarm service gets its own generated name, which cannot be changed.",
              }}
              values={values}
            />

            <ResourceField
              spec={{
                kind: "text",
                name: "description",
                label: "Description",
                optional: true,
                placeholder: example("Orders and inventory for the storefront"),
                hint: "What this database holds, for whoever finds it next.",
              }}
              values={values}
            />

            {connectionFields(kind).map((spec) => (
              <ResourceField key={spec.name} spec={spec} values={values} />
            ))}

            <ResourceField spec={imageField(kind)} values={values} />

            <Field
              name="serverId"
              label="Server"
              manual
              optional={picker.optional}
              hint={picker.hint(
                "Which host it runs on. Leave it on this Cloudgate host unless the Environment's other services are somewhere else — a database on a different Server than the things using it is a network hop on every query.",
                "Which of your Servers it runs on. A database on a different Server than the things using it is a network hop on every query.",
              )}
            >
              <Picker
                options={picker.options(servers.data)}
                pending={servers.isPending}
                placeholder={picker.placeholder}
                value={serverId}
                onValueChange={setServerId}
              />
            </Field>
          </div>

          <FormError message={form.rootError} />
        </Modal.Body>

        <Modal.Footer>
          <Button type="button" onClick={onBack}>
            Back
          </Button>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <SubmitButton pending={form.formState.isSubmitting}>
            Create {descriptor.label}
          </SubmitButton>
        </Modal.Footer>
      </form>
    </FormProvider>
  );
}

/**
 * The new row's id, whichever engine-named column it arrived in.
 *
 * `POST /:kind` answers with the raw row, so the id is under `postgresId`,
 * `redisId` and so on. Rather than a second copy of that map, this takes the one
 * key ending in `Id` that is not a foreign key — the row has exactly one.
 */
function newDatabaseId(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  for (const [key, value] of Object.entries(row)) {
    if (
      key.endsWith("Id") &&
      key !== "environmentId" &&
      key !== "serverId" &&
      typeof value === "string"
    ) {
      return value;
    }
  }
  return null;
}
