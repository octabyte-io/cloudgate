"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { PageHeader } from "@/components/console/page-header";
import { SettingsCard } from "@/components/console/settings-card";
import { Button } from "@/components/ui/button";
import type { FieldSpec } from "@/components/console/form-spec";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { DeleteComposeModal } from "../lifecycle/delete-compose-modal";
import { IsolationCard } from "../advanced/isolation-card";
import {
  COMPOSE_DELETE_REFUSAL,
  COMPOSE_UPDATE_REFUSAL,
  useComposeActions,
  useUpdateCompose,
} from "../use-compose";

/**
 * How this stack is deployed, and how to get rid of it.
 *
 * Four cards, and the choice of what is *not* here matters as much:
 *
 * - **Isolation** is its own card because it is a rewrite of the file, and the
 *   brief is right that a toggle like that has to say what it will change before
 *   it is switched on. `isolation-card.tsx`.
 * - **Randomize is absent.** There is no second rewrite toggle that suffixes
 *   every service, volume, network, config and secret name, because **this backend
 *   has no such feature** — `compose.schema.ts`'s header comment says the
 *   `randomize` and `suffix` columns were deliberately left out, and no util does
 *   that rewrite. Per the index's first locked decision, an
 *   unbuilt feature gets nothing on screen, not even a disabled control.
 * - **The deploy command and the compose type** are here rather than on Overview
 *   because both change *how* the file is applied rather than what is in it, and
 *   a change of either reaches Docker only on the next deploy — which the cards say.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      aside={(row) => <ComposeFactsCard compose={row} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`How ${row.name} is applied to its deploy target — and the settings most stacks never need.`}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

const deploySchema = z.object({
  composeType: z.enum(["docker-compose", "stack"]),
  command: z.string(),
});
type DeployValues = z.infer<typeof deploySchema>;

const sourceSchema = z.object({
  composePath: z.string().trim().min(1, "Name the file to deploy."),
  enableSubmodules: z.boolean(),
  watchPaths: z.string(),
});
type SourceValues = z.infer<typeof sourceSchema>;

function Body({ compose }: { compose: ComposeDetail }) {
  const router = useRouter();
  const update = useUpdateCompose(compose.composeId, compose.environmentId);
  const actions = useComposeActions(compose.composeId, compose.environmentId);
  const [deleting, setDeleting] = useState(false);
  const raw = compose.sourceType === "raw";
  // Both cards save through `PATCH /compose/:id`, which `findOwnedForUpdate`
  // holds to `service: ['update']`; `DELETE /compose/:id` is decorated
  // `service: ['delete']`.
  const canUpdate = usePermission({ service: ["update"] });
  const canDelete = usePermission({ service: ["delete"] });
  const deleteRefusalId = useId();

  const deployFields: FieldSpec<DeployValues>[] = [
    {
      kind: "select",
      name: "composeType",
      label: "Applied as",
      hint: "Docker Compose brings the file up on one host. A Swarm stack schedules it across the Swarm and ignores anything compose-only in the file; its Domains are routed by a Traefik config file Cloudgate writes on the stack's Server, not by labels.",
      options: [
        { value: "docker-compose", label: "Docker Compose" },
        { value: "stack", label: "Swarm stack" },
      ],
    },
    {
      kind: "text",
      name: "command",
      label: "Deploy command",
      optional: true,
      mono: true,
      placeholder:
        compose.composeType === "stack"
          ? `stack deploy -c docker-compose.yml ${compose.appName} --prune --with-registry-auth`
          : `compose -p ${compose.appName} -f docker-compose.yml up -d --build --remove-orphans`,
      hint: "Replaces the generated command entirely, and runs as its arguments — start it at the subcommand, without the word docker. Leave it empty to use the generated one.",
    },
  ];

  const sourceFields: FieldSpec<SourceValues>[] = [
    {
      kind: "text",
      name: "composePath",
      label: "Compose file",
      mono: true,
      placeholder: "./docker-compose.yml",
      hint: "Where the file sits in the repository, from its root.",
    },
    {
      kind: "switch",
      name: "enableSubmodules",
      label: "Clone submodules",
      hint: "Fetch the repository's submodules as well. Off unless the file needs them.",
    },
    {
      kind: "lines",
      name: "watchPaths",
      label: "Watch paths",
      optional: true,
      placeholder: "services/api\ndocker-compose.yml",
      // This promised push deploys, and nothing delivers one to a stack —
      // the GitHub App's webhook deploys Applications only — and no deploy
      // reads the column. Said so, rather than hidden, so a saved list is not lost.
      hint: "One per line. Nothing reads these yet: no push deploys a Compose stack, so every deploy is one someone starts.",
    },
  ];

  return (
    <>
      <IsolationCard compose={compose} save={(input) => update.mutateAsync(input)} />

      <SettingsCard
        title="How it is applied"
        lede="The Docker command this stack is deployed with."
        gate={{ allowed: canUpdate.allowed, refusal: COMPOSE_UPDATE_REFUSAL }}
        schema={deploySchema}
        fields={deployFields}
        savedMessage="Deploy settings saved."
        defaultValues={{
          composeType: compose.composeType,
          command: compose.command,
        }}
        submit={(values) =>
          update.mutateAsync({
            composeType: values.composeType,
            command: values.command.trim(),
          })
        }
        footer={
          <>
            <strong className="font-medium text-tx-2">
              Deploy after switching how it is applied.
            </strong>{" "}
            The next deploy removes the previous kind first — its containers and
            its network, not its volumes, which the new kind takes over — and
            then brings the stack up the new way. Until that deploy the old one
            keeps running, and Stop acts on the new kind. With a deploy command
            of your own set, nothing is removed for you.
          </>
        }
      />

      {raw ? null : (
        <SettingsCard
          title="From the repository"
          lede="Which file is deployed, and how the repository is cloned."
          gate={{ allowed: canUpdate.allowed, refusal: COMPOSE_UPDATE_REFUSAL }}
          schema={sourceSchema}
          fields={sourceFields}
          savedMessage="Repository settings saved."
          defaultValues={{
            composePath: compose.composePath,
            enableSubmodules: compose.enableSubmodules,
            watchPaths: (compose.watchPaths ?? []).join("\n"),
          }}
          submit={(values) =>
            update.mutateAsync({
              composePath: values.composePath.trim(),
              enableSubmodules: values.enableSubmodules,
              // F10's rule, on the clearing side: the column is nullable and an
              // empty list has to be expressible, so an empty box is `null` rather
              // than `[]` — which the backend would store and then filter nothing
              // against.
              watchPaths:
                values.watchPaths.trim() === ""
                  ? null
                  : values.watchPaths
                      .split("\n")
                      .map((line) => line.trim())
                      .filter((line) => line !== ""),
            })
          }
        />
      )}

      <Card>
        <Card.Header
          title="Delete this stack"
          sub="Its containers, its project directory and this row."
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-3">
          <p className="max-w-lede text-body text-tx-2">
            Everything this stack is running is{" "}
            {compose.composeType === "stack" ? "removed" : "taken down"} and the
            row goes with it — the compose file stored here, its variables, its
            domains and its Deployment history. The dialog says exactly what
            happens to its volumes, which is the part that differs by kind.
          </p>
          {canDelete.allowed ? null : (
            <p id={deleteRefusalId} className="text-meta text-tx-2">
              {COMPOSE_DELETE_REFUSAL}
            </p>
          )}
          <div>
            <Button
              variant="dngr"
              disabled={!canDelete.allowed}
              title={canDelete.allowed ? undefined : COMPOSE_DELETE_REFUSAL}
              aria-describedby={canDelete.allowed ? undefined : deleteRefusalId}
              onClick={() => {
                if (canDelete.allowed) setDeleting(true);
              }}
            >
              <Icon name="trash" size={15} />
              Delete {compose.name}
            </Button>
          </div>
        </Card.Body>
      </Card>

      <DeleteComposeModal
        compose={compose}
        open={deleting}
        onOpenChange={setDeleting}
        remove={(deleteVolumes, force) =>
          actions.remove.mutateAsync({ deleteVolumes, force })
        }
        // Back to the Environment it was in — its Services tab is the scope's
        // first, so the id alone is the address.
        onDeleted={() => router.push(`/environments/${compose.environmentId}`)}
      />
    </>
  );
}
