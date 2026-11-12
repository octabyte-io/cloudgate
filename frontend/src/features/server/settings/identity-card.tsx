import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import type { FieldSpec } from "@/components/console/form-spec";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { SERVER_UPDATE_REFUSAL, useUpdateServer } from "../use-server";

const identitySchema = z.object({
  name: z.string().trim().min(1, "A Server needs a name."),
  description: z.string().trim(),
  serverType: z.enum(["deploy", "build"]),
});
type Identity = z.infer<typeof identitySchema>;

const IDENTITY_FIELDS: FieldSpec<Identity>[] = [
  { name: "name", label: "Name", kind: "text" },
  {
    name: "description",
    label: "Description",
    kind: "text",
    optional: true,
    hint: "What this machine is for. It shows under the name in the fleet.",
  },
  {
    name: "serverType",
    label: "Role",
    kind: "select",
    options: [
      { value: "deploy", label: "Deploy", detail: "runs services" },
      { value: "build", label: "Build", detail: "only builds images" },
    ],
    hint: "A build Server takes image builds for other Servers and runs nothing itself.",
  },
];

/** What this machine is called here. The safe end of the tab. */
export function IdentityCard({ server }: { server: Server }) {
  const update = useUpdateServer(server.serverId);
  // `PATCH /servers/:id` is `@RequirePermission('server', 'create')`.
  const canSave = usePermission({ server: ["create"] });
  return (
    <SettingsCard<Identity>
      title="Server"
      gate={{ allowed: canSave.allowed, refusal: SERVER_UPDATE_REFUSAL }}
      lede="What this machine is called here. None of it touches the machine."
      schema={identitySchema}
      fields={IDENTITY_FIELDS}
      defaultValues={{
        name: server.name,
        description: server.description ?? "",
        serverType: server.serverType,
      }}
      // Updating clears with `null`, not `undefined`: a PATCH that omits a column
      // leaves it exactly as it was, so an emptied description would silently keep
      // its old value (F10's rule, both halves of it).
      submit={(values) =>
        update.mutateAsync({
          name: values.name,
          description: values.description || null,
          serverType: values.serverType,
        })
      }
      savedMessage="Server details saved."
    />
  );
}
