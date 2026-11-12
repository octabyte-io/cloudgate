"use client";

import { z } from "zod";

import { Banner, BannerRow } from "@/components/console/banner";
import { Chip } from "@/components/console/chip";
import { PageHeader } from "@/components/console/page-header";
import { OpenShellButton } from "@/features/service-shell/open-shell-button";
import { SettingsCard } from "@/components/console/settings-card";
import { example, type FieldSpec } from "@/components/console/form-spec";
import {
  COMPOSE_TYPE_LABEL,
  runsOnStackVm,
  type ComposeDetail,
} from "@/lib/api/endpoints/compose";
import { usePermission } from "@/lib/auth/use-permission";
import { serviceNameField } from "@/lib/forms/service-name";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { HealthFactRow } from "@/components/console/service-health-state";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { ComposeFileCard } from "../editor/compose-file-card";
import { ComposeActions } from "../lifecycle/compose-actions";
import { ComposeSourceCard } from "../source/compose-source-card";
import { StackVmCard } from "../stack-vm/stack-vm-card";
import { COMPOSE_UPDATE_REFUSAL, useUpdateCompose } from "../use-compose";

/**
 * The stack: what it is, where its file comes from, and the file itself.
 *
 * **The editor is on this tab and not behind one**, because for this service kind
 * the file *is* the configuration — an Application has a source, a builder, a run
 * command and eleven Swarm concerns, and a stack has a file that says all of it.
 * So the reading order is identity → where the file comes from → the file, and
 * everything else in this scope is a consequence of that file: which containers
 * exist, what they log, which service a domain routes into.
 */

const identitySchema = z.object({
  name: serviceNameField("A stack needs a name."),
  description: z.string(),
});

type IdentityValues = z.infer<typeof identitySchema>;

const IDENTITY_FIELDS: FieldSpec<IdentityValues>[] = [
  {
    kind: "text",
    name: "name",
    label: "Name",
    hint: "What this stack is called in Cloudgate. The Docker stack keeps its own immutable name.",
  },
  {
    kind: "text",
    name: "description",
    label: "Description",
    optional: true,
    placeholder: example("Redis, MinIO and the worker that reads them"),
    hint: "What this stack is for, for whoever finds it next.",
  },
];

export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      aside={(row) => (
        <ComposeFactsCard
          compose={row}
          health={
            <HealthFactRow serviceType="compose" serviceId={row.composeId} />
          }
        />
      )}
      header={(row) => (
        <PageHeader
          title={row.name}
          icon={props.icon}
          badges={
            /* No `StatusPill` — see the note in the Application's overview. The
               masthead and `ComposeFactsCard` both carry this status already. */
            <>
              <Chip variant="brand">{COMPOSE_TYPE_LABEL[row.composeType]}</Chip>
              <Chip variant="mono">{row.appName}</Chip>
            </>
          }
          lede={`${row.description || "A Compose stack"} — in ${row.environment.project.name} / ${row.environment.name}.`}
          actions={
            <>
              {/* To the Shell tab, wherever there is one. */}
              <OpenShellButton />
              <ComposeActions compose={row} />
            </>
          }
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const update = useUpdateCompose(compose.composeId, compose.environmentId);
  // `PATCH /compose/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canUpdate = usePermission({ service: ["update"] });

  return (
    <>
      {compose.composeStatus === "error" ? (
        <Banner
          icon="alert"
          title="The last Deployment did not finish."
          className="animate-rise border-bad-line"
        >
          <BannerRow
            tone="bad"
            title="Docker refused the stack, or a container never started."
            description="The build log on the Deployments tab holds the reason — an unparsable file, an image that would not pull, or a port already taken on the deploy target. Containers that did start are still running: the Containers tab shows which."
          />
        </Banner>
      ) : null}

      <SettingsCard
        title="Identity"
        lede="What this stack is called, and what it is for."
        gate={{ allowed: canUpdate.allowed, refusal: COMPOSE_UPDATE_REFUSAL }}
        schema={identitySchema}
        fields={IDENTITY_FIELDS}
        savedMessage="Identity saved."
        defaultValues={{
          name: compose.name,
          description: compose.description ?? "",
        }}
        submit={(values) =>
          update.mutateAsync({
            name: values.name,
            // F10's rule: an empty optional is `null` on an update, never `""` —
            // `updateComposeSchema` types this one `.nullable()` precisely so
            // clearing it is expressible.
            description:
              values.description.trim() === ""
                ? null
                : values.description.trim(),
          })
        }
      />

      {/* A stack in a Cloud account: the Stack VM it runs on (ADR-0070). */}
      {runsOnStackVm(compose) ? <StackVmCard compose={compose} /> : null}

      <ComposeSourceCard
        compose={compose}
        save={(input) => update.mutateAsync(input)}
      />

      <ComposeFileCard
        compose={compose}
        save={(input) => update.mutateAsync(input)}
      />
    </>
  );
}
