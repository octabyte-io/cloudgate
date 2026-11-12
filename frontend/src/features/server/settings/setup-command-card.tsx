import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import type { FieldSpec } from "@/components/console/form-spec";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { SERVER_UPDATE_REFUSAL, useUpdateServer } from "../use-server";

const commandSchema = z.object({ command: z.string() });
type CommandValues = z.infer<typeof commandSchema>;

const COMMAND_FIELDS: FieldSpec<CommandValues>[] = [
  {
    name: "command",
    label: "Setup command",
    kind: "textarea",
    rows: 8,
    mono: true,
    optional: true,
    placeholder: "Leave empty to use Cloudgate's own setup script.",
  },
];

/**
 * The custom setup script.
 *
 * **Empty means the default**, which is the whole behaviour of the column:
 * `serversService.setup` runs `current.command || serverSetupCommand()`. So a stored
 * command does not *extend* setup, it **replaces** it — Docker, the Swarm, the network,
 * the directory and Traefik all become that script's problem. Said here, not on the
 * Infrastructure tab where somebody is about to press Run.
 *
 * Where its output goes is said too, because this card used to say it went
 * nowhere: a setup run streams to the Infrastructure tab's Setup card now,
 * and the sentence that claimed otherwise outlived the gap it described.
 */
export function SetupCommandCard({ server }: { server: Server }) {
  const update = useUpdateServer(server.serverId);
  // `PATCH /servers/:id` is `@RequirePermission('server', 'create')`.
  const canSave = usePermission({ server: ["create"] });
  return (
    <SettingsCard<CommandValues>
      title="Setup command"
      gate={{ allowed: canSave.allowed, refusal: SERVER_UPDATE_REFUSAL }}
      lede="What Run setup executes on this machine."
      schema={commandSchema}
      fields={COMMAND_FIELDS}
      defaultValues={{ command: server.command }}
      submit={(values) => update.mutateAsync({ command: values.command })}
      savedMessage="Setup command saved."
      footer="A command here replaces the default script entirely, rather than adding to it — Docker, the Swarm, cloudgate-network, /etc/cloudgate and Traefik all become its job. Empty this field and Cloudgate's own six steps come back."
    >
      <p className="text-body text-tx-2">
        Shell, run over SSH as the Server&rsquo;s user. It gets no arguments.
        Run setup on the Infrastructure tab streams its output to the Setup card
        there as it writes it, and What is installed, on the same tab, is read
        from the Server again once it ends.
      </p>
    </SettingsCard>
  );
}
