import { useState } from "react";
import { z } from "zod";

import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";
import { MetaStrip } from "@/components/console/meta-strip";
import { SettingsCard } from "@/components/console/settings-card";
import type {
  ApplicationDetail,
  DomainPortMove,
} from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";
import { domainPortMoveSentence } from "@/lib/format/domain-port-move";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import type { FieldSpec } from "./resource-spec";

/**
 * The port the Application listens on in its container (the config's
 * `port`), and what its change did to the Domains (ADR-0068, #1339).
 *
 * A Domain routes to its own port, so a port change used to leave every
 * Domain on the old one answering 502. The save now moves the Domains that
 * were on the old port and names the ones it left; that sentence stays on
 * the card after the toast is gone, because a Domain left on another port is
 * the one a person may still have to look at.
 */

const schema = z.object({
  port: z.number().int().min(1).max(65535),
});

type Values = z.infer<typeof schema>;

/** In a Cloud account its routing follows the Service, and no Domain names a port. */
function fieldsFor(cloud: boolean): FieldSpec<Values>[] {
  return [
    {
      kind: "number",
      name: "port",
      label: "Container port",
      min: 1,
      max: 65535,
      hint: cloud
        ? "The port the Application listens on inside its container. Its Domains follow it at the next Deployment."
        : "The port the Application listens on inside its container. Saving a new one moves the Domains on the old port with it, and routes them there at once.",
    },
  ];
}

export function PortCard({
  application,
  save,
}: {
  application: ApplicationDetail;
  save: (
    input: Record<string, unknown>,
  ) => Promise<{ domainPortMove?: DomainPortMove }>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  // `port` is config-owned: a repository-kept config's file sets it.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );
  const [lastMove, setLastMove] = useState<DomainPortMove | null>(null);
  return (
    <SettingsCard
      title="Container port"
      gate={{
        allowed: canSave.allowed && lock === null,
        refusal:
          canSave.allowed && lock
            ? lockRefusal(lock)
            : APPLICATION_SETTINGS_REFUSAL,
      }}
      lede="The port it listens on inside its container."
      schema={schema}
      fields={fieldsFor(application.cloudPlace != null)}
      savedMessage={(saved) => {
        const move = (saved as { domainPortMove?: DomainPortMove })
          .domainPortMove;
        return move
          ? `Port saved. ${domainPortMoveSentence(move)}`
          : "Container port saved.";
      }}
      defaultValues={{ port: application.port }}
      submit={async (values) => {
        const saved = await save({ port: values.port });
        setLastMove(saved.domainPortMove ?? null);
        return saved;
      }}
      footer="The container listens on the new port from the next Deployment."
    >
      {lock ? <ConfigLockNote lock={lock} what="The port is" /> : null}
      {lastMove ? (
        <MetaStrip className="rounded-md border">
          {domainPortMoveSentence(lastMove)}
        </MetaStrip>
      ) : null}
    </SettingsCard>
  );
}
