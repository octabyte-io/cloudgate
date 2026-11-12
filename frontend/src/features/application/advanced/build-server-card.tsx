import Link from "next/link";
import { z } from "zod";

import { KVList, KVRow } from "@/components/console/kv-list";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import type { FieldSpec } from "./resource-spec";
import { SettingsCard } from "@/components/console/settings-card";

/**
 * Which host builds the image, when it should not be the one that runs it.
 *
 * A build is the expensive thing a deploy target does — it pulls layers,
 * compiles, and fills the disk with cache — and doing it on the Server already
 * serving traffic is what makes a deploy visible to visitors. Pointing builds at
 * a separate host is the fix, and this is the one control for it.
 *
 * **The read-out above the picker names both hosts**, because the pair is the
 * information: "builds on `builder-eu`, runs on `swarm-prod-1`" is legible in a
 * way that a Select showing one name is not, and the deploy target itself is not
 * editable here (it is chosen when the Application is created).
 *
 * It also matters for a reason that is invisible until it bites: the Deployment
 * log lives on **whichever host built it** — `buildServerId` first, `serverId`
 * otherwise, the precedence `deployments.service.ts` used when it created the
 * file. F09's `deployment-facts.ts` carries the same rule.
 *
 * **A dedicated build Server requires a Registry, and this control never said
 * so**. The image is built on that host as `appName:latest` and only a
 * Registry moves it anywhere: with none linked the Server that runs the service
 * is handed an image reference it has never had. The backend refuses that
 * Deployment now, but the refusal arrives one deploy after the choice, and this
 * is the screen where the choice is made — so the requirement is in the picker's
 * own hint, before it is picked.
 *
 * The card also warns for a row **already** in that state, which is the half a
 * hint cannot reach: the Applications this ticket is about were configured
 * before anything said this, and their operator has no reason to open this card
 * again. The warning reads the saved row rather than the unsaved selection,
 * because what it is reporting is a *deploy that will fail*, and nothing fails
 * on a value still in the form.
 *
 * The link goes to Overview rather than to the registry list: the Registry is
 * *linked* on the Build settings card there ("Push the image to"), and sending
 * someone to `/settings/registries` leaves them with a connected registry and an
 * Application that still does not use it.
 */

const schema = z.object({ buildServerId: z.string() });

/** Where an Application with no Server runs and builds. */
const OWN_HOST = "Cloudgate's own host";
type Values = z.infer<typeof schema>;

/**
 * Whether the saved row is the configuration that cannot deploy —
 * `DeploymentEngineService.assertBuiltImageReachesRunServer`, in the same three
 * clauses and the same order.
 *
 * A `docker` source is exempt because it builds nothing: the image is pulled
 * from where it already lives, and the run Server pulls it the same way. Either
 * registry counts, because the push and the converge agree on which of the two
 * names the image.
 */
function cannotReachRunServer(application: ApplicationDetail): boolean {
  return (
    application.sourceType !== "docker" &&
    application.buildServerId !== null &&
    application.registryId === null &&
    application.buildRegistryId === null
  );
}

export function BuildServerCard({
  application,
  servers,
  serversPending,
  save,
}: {
  application: ApplicationDetail;
  servers: Server[];
  serversPending: boolean;
  save: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  // `checkServerAccess` on the chosen Server is narrower, and stays the
  // backend's to refuse.
  const canSave = usePermission({ service: ["update"] });
  const fields: FieldSpec<Values>[] = [
    {
      kind: "select",
      name: "buildServerId",
      label: "Build server",
      optional: true,
      pending: serversPending,
      placeholder: "Build where it runs",
      options: [
        { value: "", label: "Build where it runs" },
        ...servers.map((server) => ({
          value: server.serverId,
          label: server.name,
          detail: server.ipAddress,
        })),
      ],
      hint:
        application.sourceType === "docker"
          ? "Anything other than the deploy target keeps image builds off the host serving traffic. The Deployment log is written on whichever host builds."
          : "Anything other than the deploy target keeps image builds off the host serving traffic, and needs a registry to push the built image to — the host that runs this Application cannot read an image left on another one. The Deployment log is written on whichever host builds.",
    },
  ];

  return (
    <SettingsCard
      title="Build server"
      gate={{ allowed: canSave.allowed, refusal: APPLICATION_SETTINGS_REFUSAL }}
      lede="Where the image is built, if not where it runs."
      schema={schema}
      fields={fields}
      savedMessage="Build server saved."
      defaultValues={{ buildServerId: application.buildServerId ?? "" }}
      submit={(values) =>
        save({ buildServerId: values.buildServerId === "" ? null : values.buildServerId })
      }
      footer="The next Deployment builds on the chosen host."
    >
      <KVList>
        {/* Both empty is Cloudgate's own host, and said in the words
            Overview's "Where it runs" uses: a dash here read as
            "unknown" beside a card that knew. */}
        <KVRow
          label="Runs on"
          value={application.server?.name ?? OWN_HOST}
        />
        <KVRow
          label="Builds on"
          value={
            application.buildServer?.name ??
            application.server?.name ??
            OWN_HOST
          }
        />
      </KVList>

      {cannotReachRunServer(application) ? (
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-meta text-tx">
          <strong className="font-medium">
            This Application cannot deploy as it is configured.
          </strong>{" "}
          It builds on{" "}
          {application.buildServer?.name ?? "another Server"} and no registry is
          linked, so the built image stays there and never reaches{" "}
          {application.server?.name ?? "the Server that runs it"}. Link a
          registry under{" "}
          <Link
            href={`/applications/${application.applicationId}`}
            className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Build settings
          </Link>{" "}
          — the <em>Push the image to</em> field — or build where it runs.
        </p>
      ) : null}
    </SettingsCard>
  );
}
