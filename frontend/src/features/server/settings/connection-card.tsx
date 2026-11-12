import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import type { FieldSpec } from "@/components/console/form-spec";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import {
  isServerAddress,
  SERVER_ADDRESS_MESSAGE,
} from "../fleet/server-address";
import { SERVER_UPDATE_REFUSAL, useUpdateServer } from "../use-server";

const connectionSchema = z.object({
  ipAddress: z
    .string()
    .trim()
    .min(1, "A Server needs an address.")
    .refine(isServerAddress, SERVER_ADDRESS_MESSAGE),
  port: z.coerce
    .number()
    .int("A port is a whole number.")
    .min(1, "A port is between 1 and 65535.")
    .max(65535, "A port is between 1 and 65535."),
  username: z.string().trim().min(1, "Name the user Cloudgate signs in as."),
});
type Connection = z.infer<typeof connectionSchema>;

const CONNECTION_FIELDS: FieldSpec<Connection>[] = [
  { name: "ipAddress", label: "Address", kind: "text", mono: true },
  { name: "port", label: "SSH port", kind: "number", min: 1, max: 65535 },
  {
    name: "username",
    label: "SSH user",
    kind: "text",
    mono: true,
    hint: "Root, or a user with passwordless sudo. This key's public half has to be in that user's authorized_keys.",
  },
];

/**
 * Where Cloudgate dials, and as whom — **the card where a typo makes a working
 * Server unreachable**, which is why it is its own Save rather than sharing one
 * with the identity above it.
 */
export function ConnectionCard({ server }: { server: Server }) {
  const update = useUpdateServer(server.serverId);
  // `PATCH /servers/:id` is `@RequirePermission('server', 'create')`.
  const canSave = usePermission({ server: ["create"] });
  return (
    <SettingsCard<Connection>
      title="Connection"
      gate={{ allowed: canSave.allowed, refusal: SERVER_UPDATE_REFUSAL }}
      lede="Where Cloudgate dials, and as whom."
      schema={connectionSchema}
      fields={CONNECTION_FIELDS}
      defaultValues={{
        ipAddress: server.ipAddress,
        port: server.port,
        username: server.username,
      }}
      submit={(values) => update.mutateAsync(values)}
      savedMessage="Connection saved."
      // A wrong port makes a working machine look like a dead one, and saving
      // checks nothing — so the footer points at the control that does.
      footer="Saving checks nothing; Check now on the Infrastructure tab tries the new address."
    />
  );
}
