import Link from "next/link";
import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import { usePermission } from "@/lib/auth/use-permission";
import { settingsHref } from "@/lib/settings/sections";

import {
  APPLICATION_SETTINGS_REFUSAL,
  type useApplication,
  type useUpdateApplication,
} from "../use-application";

const settingsSchema = z
  .object({
    isPreviewDeploymentsActive: z.boolean(),
    previewWildcard: z.string().trim(),
    previewDnsChallenge: z.boolean(),
    previewLimit: z.coerce
      .number()
      .int("The limit has to be a whole number.")
      .min(0, "The limit cannot be negative."),
    previewPort: z.coerce
      .number()
      .int("The port has to be a whole number.")
      .min(1, "A port is between 1 and 65535.")
      .max(65535, "A port is between 1 and 65535."),
    previewEnv: z.string(),
    previewBuildArgs: z.string(),
    requestedPreviewsAllowed: z.boolean(),
    requestedPreviewLimit: z.coerce
      .number()
      .int("The limit has to be a whole number.")
      .min(
        1,
        "At least one. To allow none, turn requested previews off instead.",
      ),
  })
  .refine(
    (values) =>
      !values.isPreviewDeploymentsActive || values.previewWildcard !== "",
    {
      path: ["previewWildcard"],
      message: "Previews need a wildcard host to carve their own hosts out of.",
    },
  )
  .refine(
    (values) =>
      values.previewWildcard === "" || values.previewWildcard.startsWith("*."),
    {
      path: ["previewWildcard"],
      // The backend's own rule (`updateApplicationSchema`), said before it
      // refuses rather than after.
      message:
        'A wildcard has to start with "*." — for example *.preview.example.com.',
    },
  );

/**
 * Whether pull requests get their own environment, and where they answer.
 *
 * The settings were two columns of eleven; the four that
 * carried weight have landed. The **limit** is what this card leads with, because
 * it changes whether someone should turn the feature on at all: it is what stands
 * between an active repository and one service, one router and one set of volumes
 * per open pull request. It is enforced where previews are created, so the
 * eleventh pull request against a limit of ten is refused rather than queued.
 *
 * **What happens past the limit is stated once, on the field's own hint**
 * The footer used
 * to say the rest "wait for a slot", which is a queue the product does not have:
 * `PreviewDeploymentsService.ensurePreview` returns `null` once the open rows
 * reach `previewLimit` and the webhook `continue`s past it, so the refused pull
 * request is not written down anywhere and gets a preview only when it next
 * pushes into a free slot. The footer keeps the half that is its own — what each
 * preview *costs*, and that none of these settings reach a running one until it
 * is redeployed — and says nothing about what happens past the limit, so the
 * hint is the only place on the screen that answers it.
 *
 * **And the pull request is now told the same thing**
 * the refusal
 * used to happen in silence, so the hint's promise was the only account of it
 * anywhere. `PreviewDeploymentsService` posts it on the refused pull request in
 * these words — refused, not queued, and closing another one frees a slot — so
 * the sentence here and the one the contributor reads are one behaviour
 * described twice rather than two claims.
 *
 * The two **variable blobs** are the other half of that: without them a preview
 * builds with this Application's own `env` and `buildArgs`, production database
 * included. Set either one and it replaces production's for previews only —
 * left empty, the old inheriting behaviour is what still happens, which is why
 * the hints say so rather than leaving it to be discovered.
 *
 * **The port is the container port the preview's host is routed to**
 * each preview
 * gets its own Traefik router, written once its build converges, pointed at
 * this port on the preview's own service. It was held back while nothing read
 * it; now a preview of an Application listening anywhere but 3000 answers 502
 * without it.
 *
 * **Requested previews are their own group at the bottom**
 * the switch
 * `requestedPreviewsAllowed` and its cap `requestedPreviewLimit`.
 * The wildcard, the port and the two variable blobs above serve both kinds of
 * preview, so they stay where they are and the group holds only what is the
 * requested kind's alone. The switch's hint carries the warning, because
 * that is the moment it matters: a requested preview is unmerged branch code
 * with no pull request, running on this Application's storage and — unless
 * Preview variables are set — its environment. The cap's minimum is 1 because
 * none is what the switch is for. **`previewLimit` counts pull-request previews
 * only**, and its hint says so; the footer speaks of both limits.
 * There is no create here: asking for one is MCP's and the HTTP route's.
 *
 * **The DNS-01 switch sits under the wildcard it certifies**. It is off,
 * natively, while the form holds no wildcard — an sslip.io host cannot get a
 * DNS-01 certificate — and a save with the wildcard emptied sends it off
 * rather than asking the backend to refuse it. The other half of its
 * precondition, a DNS-01 setup on this Application's machine, is only the
 * backend's to check, so its hint links to where that is set and its refusal
 * comes back through the form like any other.
 */
export function PreviewSettingsCard({
  row,
  update,
}: {
  row: NonNullable<ReturnType<typeof useApplication>["data"]>;
  update: ReturnType<typeof useUpdateApplication>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  return (
    <SettingsCard
      title="Preview settings"
      gate={{ allowed: canSave.allowed, refusal: APPLICATION_SETTINGS_REFUSAL }}
      lede="Whether pull requests and requested branches get their own environment, and where they answer."
      schema={settingsSchema}
      fields={(values) => [
        {
          kind: "switch",
          name: "isPreviewDeploymentsActive",
          label: "Build a preview for every pull request",
          hint: "Applies to pull requests against this Application's tracked branch.",
        },
        {
          kind: "text",
          name: "previewWildcard",
          label: "Wildcard host",
          mono: true,
          placeholder: "*.preview.example.com",
          hint: "Each preview gets its own host under this. The DNS record has to exist and point at the Server already — nothing here creates it.",
        },
        {
          kind: "switch",
          name: "previewDnsChallenge",
          label: "Issue the wildcard certificate through DNS-01 (Let's Encrypt)",
          disabled: values.previewWildcard.trim() === "",
          hint: (
            <DnsChallengeHint
              serverId={row.serverId}
              serverName={row.server?.name ?? null}
              noWildcard={values.previewWildcard.trim() === ""}
            />
          ),
        },
        {
          kind: "number",
          name: "previewLimit",
          label: "Most previews at once",
          min: 0,
          hint: "Counts pull-request previews only; requested previews have their own limit below. A pull request opened once this many are already running is refused, not queued — closing one frees its slot. Zero turns previews off for every pull request.",
        },
        {
          kind: "number",
          name: "previewPort",
          label: "Container port",
          min: 1,
          hint: "The port the preview's container listens on. Its host is routed there once its build finishes.",
        },
        {
          kind: "textarea",
          name: "previewEnv",
          label: "Preview variables",
          optional: true,
          mono: true,
          rows: 4,
          placeholder: "DATABASE_URL=postgres://staging",
          hint: "One KEY=value per line. These replace this Application's own variables for previews only. Empty means a preview builds with production's — staging database or not.",
        },
        {
          kind: "textarea",
          name: "previewBuildArgs",
          label: "Preview build arguments",
          optional: true,
          mono: true,
          rows: 3,
          placeholder: "API_HOST=api.staging.example.com",
          hint: "The same, for --build-arg on the preview's build. Empty means production's build arguments are baked into the preview image.",
        },
        {
          kind: "section",
          // A section's name is only a React key; no value is read or
          // written (`form-spec.ts`), so it names no column of the schema.
          name: "requestedPreviewsSection" as never,
          label: "Requested previews",
          hint: "A preview of a branch, asked for by a person or an Agent holding deployment create here, with no pull request. Each one expires on its own.",
        },
        {
          kind: "switch",
          name: "requestedPreviewsAllowed",
          label: "Allow requested previews",
          hint: "A requested preview runs a branch against this Application's storage and environment: its volumes, and its variables unless the preview variables above say otherwise. Turning this off refuses new requests; ones already running last until they expire.",
        },
        {
          kind: "number",
          name: "requestedPreviewLimit",
          label: "Most requested previews at once",
          min: 1,
          hint: "A request made once this many are held is refused — deleting one or waiting for one to expire frees its slot. An expired preview counts until its teardown finishes.",
        },
      ]}
      defaultValues={{
        isPreviewDeploymentsActive: row.isPreviewDeploymentsActive,
        previewWildcard: row.previewWildcard ?? "",
        previewDnsChallenge: row.previewDnsChallenge ?? false,
        previewLimit: row.previewLimit,
        previewPort: row.previewPort,
        previewEnv: row.previewEnv ?? "",
        previewBuildArgs: row.previewBuildArgs ?? "",
        requestedPreviewsAllowed: row.requestedPreviewsAllowed,
        requestedPreviewLimit: row.requestedPreviewLimit,
      }}
      savedMessage="Preview settings saved."
      submit={(values) =>
        update.mutateAsync({
          isPreviewDeploymentsActive: values.isPreviewDeploymentsActive,
          previewWildcard:
            values.previewWildcard === "" ? null : values.previewWildcard,
          // No wildcard, nothing to certify: sent off rather than refused.
          previewDnsChallenge:
            values.previewWildcard !== "" && values.previewDnsChallenge,
          previewLimit: values.previewLimit,
          previewPort: values.previewPort,
          // Empty is `null`, not `""` — the deploy tests these for "was one
          // set" before falling back to production's blobs.
          previewEnv: blank(values.previewEnv),
          previewBuildArgs: blank(values.previewBuildArgs),
          requestedPreviewsAllowed: values.requestedPreviewsAllowed,
          requestedPreviewLimit: values.requestedPreviewLimit,
        })
      }
      footer={
        <>
          <strong>The limits are what cap the deploy target.</strong> Each open
          preview is a separate service with its own container and volumes, which
          is what each limit is counting. None of this reaches a preview that is
          already running until it is redeployed.
        </>
      }
    />
  );
}

/**
 * What the DNS-01 switch needs, and where the half this form cannot see is
 * set: the platform host's Traefik screen, or the Server's Settings tab.
 */
function DnsChallengeHint({
  serverId,
  serverName,
  noWildcard,
}: {
  serverId: string | null;
  serverName: string | null;
  noWildcard: boolean;
}) {
  const link =
    "font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline";
  return (
    <>
      {noWildcard ? "Off until a wildcard host is set above. " : null}
      Asks the letsencrypt-dns resolver for a certificate covering the wildcard,
      so previews answer over https once it is issued. Needs a preview wildcard
      and a DNS-01 setup on the machine this Application runs on —{" "}
      {serverId === null ? (
        <Link href={settingsHref("traefik")} className={link}>
          Settings → Traefik
        </Link>
      ) : (
        <Link href={`/servers/${serverId}/settings`} className={link}>
          {serverName ?? "this Server"}&rsquo;s Settings tab
        </Link>
      )}
      .
    </>
  );
}

/** Empty means "not set", which is what the deploy falls back on. */
const blank = (value: string) => (value.trim() === "" ? null : value.trim());
