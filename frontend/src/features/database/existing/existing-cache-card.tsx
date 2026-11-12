import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import { Card } from "@/components/console/card";
import type { FieldSpec } from "@/components/console/form-spec";
import { KVList, KVRow } from "@/components/console/kv-list";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database } from "@/lib/api/endpoints/databases";
import {
  existingRedisApi,
  hasAuthToken,
  isGoogleCache,
  VALKEY_INSTANCE_NAME,
  type ExistingCache,
  type UpdateExistingCacheInput,
} from "@/lib/api/endpoints/existing-redis";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_UPDATE_REFUSAL } from "../use-database";
import { NotFoundNote } from "./not-found-note";
import {
  AUTH_TOKEN,
  AUTH_TOKEN_MESSAGE,
  REPLICATION_GROUP_ID,
} from "@/components/console/use-existing-cache-modal";

const schema = z.object({
  identifier: z
    .string()
    .trim()
    .regex(
      REPLICATION_GROUP_ID,
      "A replication group id: letters, digits and hyphens, starting with a letter.",
    ),
  /** Blank keeps the token that is set. */
  authToken: z.string().regex(AUTH_TOKEN, AUTH_TOKEN_MESSAGE).or(z.literal("")),
  /** Clears the token, for a cache with none. */
  clearToken: z.boolean(),
  tls: z.boolean(),
  madeReachable: z.boolean(),
});
type Values = z.infer<typeof schema>;

/**
 * On Google Cloud only the instance's name is the operator's to
 * give: its TLS and login are read from the instance at every plan.
 */
const googleSchema = z.object({
  identifier: z
    .string()
    .trim()
    .regex(
      VALKEY_INSTANCE_NAME,
      "A Valkey instance name: project/region/instance.",
    ),
});
type GoogleValues = z.infer<typeof googleSchema>;

const googleFields: FieldSpec<GoogleValues>[] = [
  {
    kind: "text",
    name: "identifier",
    label: "Instance name",
    mono: true,
    hint: "Another name is another cache: the next plan looks it up, and its Apply points Cloudgate's endpoints at it.",
  },
];

const fields: FieldSpec<Values>[] = [
  {
    kind: "text",
    name: "identifier",
    label: "Replication group id",
    mono: true,
    hint: "Another id is another cache: the next plan looks it up.",
  },
  {
    kind: "password",
    name: "authToken",
    label: "AUTH token",
    optional: true,
    placeholder: "Leave blank to keep it",
    hint: "Never shown again. A new one reaches the Services linking it on their next deploy.",
  },
  {
    kind: "switch",
    name: "clearToken",
    label: "The cache has no AUTH token",
    hint: "Clears the token Cloudgate keeps; its URL then carries no password.",
  },
  {
    kind: "switch",
    name: "tls",
    label: "TLS",
    hint: "On: rediss:// and a ca. Off: redis://, for a cache without in-transit encryption.",
  },
  {
    kind: "switch",
    name: "madeReachable",
    label: "I made it reachable from this Environment",
    hint: "Needed outside this Environment network's VPC. Cloudgate cannot check it.",
  },
];

/**
 * An Existing cache's page (ADR-0033): the replication group it
 * uses, where the last plan found it, its TLS flag and whether its AUTH
 * token is set, never the token. Cloudgate runs nothing for it, so there is
 * no image, container or resources here. Edits (`service: ['update']`)
 * never reach the cache; a new token or TLS flag marks the Services linking
 * it to deploy again.
 */
export function ExistingCacheCard({
  row,
  existing,
}: {
  row: Database;
  existing: ExistingCache;
}) {
  const canSave = usePermission({ service: ["update"] });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (input: UpdateExistingCacheInput) =>
      existingRedisApi.update(row.databaseId, input),
    onSuccess: () =>
      invalidate.database({
        kind: "redis",
        databaseId: row.databaseId,
        environmentId: row.environmentId,
      }),
  });
  const tokenSet = hasAuthToken(row);
  const google = isGoogleCache(existing);
  const registration = existing.registration ?? null;

  return (
    <>
      <Card>
        <Card.Header
          title="Existing cache"
          sub="Cloudgate uses this cache but doesn't manage it: it looks it up at every plan and never changes or deletes it."
          headingLevel={2}
        />
        <Card.Body>
          <NotFoundNote notFound={existing.notFound} />
          {registration?.sentence ? (
            <div
              role="status"
              className="mb-3 grid gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-body text-tx"
            >
              <p className="font-medium">{registration.sentence}.</p>
              {registration.command ? (
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-meta text-tx-2">
                  {registration.command}
                </pre>
              ) : null}
            </div>
          ) : null}
          <KVList>
            <KVRow
              label={google ? "Instance" : "Replication group"}
              value={existing.identifier}
              title={existing.identifier}
              mono
            />
            <KVRow label="Region" value={existing.region} mono />
            <KVRow
              label="Found at"
              value={
                existing.address
                  ? `${existing.address.host}:${existing.address.port}`
                  : google
                    ? "Cloudgate's endpoints are made by the next Apply"
                    : "Not looked up yet — Check for changes"
              }
              title={existing.address
                  ? `${existing.address.host}:${existing.address.port}`
                  : google
                    ? "Cloudgate's endpoints are made by the next Apply"
                    : "Not looked up yet — Check for changes"}
              mono={existing.address !== null}
            />
            <KVRow
              label="TLS"
              value={`${existing.tls ? "On (rediss://)" : "Off (redis://)"}${google ? ", as the instance reports it" : ""}`}
              title={`${existing.tls ? "On (rediss://)" : "Off (redis://)"}${google ? ", as the instance reports it" : ""}`}
            />
            {google ? null : (
              <KVRow label="AUTH token" value={tokenSet ? "Set" : "Not set"} />
            )}
            <KVRow
              label="Reachable"
              value={
                google
                  ? registration
                    ? registration.status === "registered"
                      ? "Through Cloudgate's two endpoints, registered on the instance"
                      : "Through Cloudgate's two endpoints, waiting for registration"
                    : "Through Cloudgate's two endpoints, made by the next Apply"
                  : existing.madeReachable
                    ? "You made it reachable from this Environment"
                    : "Only from inside this Environment network"
              }
              title={google
                  ? registration
                    ? registration.status === "registered"
                      ? "Through Cloudgate's two endpoints, registered on the instance"
                      : "Through Cloudgate's two endpoints, waiting for registration"
                    : "Through Cloudgate's two endpoints, made by the next Apply"
                  : existing.madeReachable
                    ? "You made it reachable from this Environment"
                    : "Only from inside this Environment network"}
            />
          </KVList>
        </Card.Body>
      </Card>

      {google ? (
        <SettingsCard
          title="Instance"
          lede="What Cloudgate looks up at every plan. Nothing here is written to the instance."
          gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
          schema={googleSchema}
          fields={googleFields}
          savedMessage="Existing cache saved."
          defaultValues={{ identifier: existing.identifier }}
          submit={(values) => save.mutateAsync(values)}
          footer="A new name is read by the next plan."
        />
      ) : (
        <SettingsCard
          title="Replication group and AUTH token"
          lede="What Cloudgate builds this cache's Outputs from. Nothing here is written to the cache."
          gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
          schema={schema}
          fields={fields}
          savedMessage="Existing cache saved."
          defaultValues={{
            identifier: existing.identifier,
            authToken: "",
            clearToken: !tokenSet,
            tls: existing.tls,
            madeReachable: existing.madeReachable,
          }}
          submit={({ authToken, clearToken, ...values }) =>
            save.mutateAsync({
              ...values,
              ...(authToken !== ""
                ? { authToken }
                : clearToken && tokenSet
                  ? { authToken: "" }
                  : {}),
            })
          }
          footer="A new id, TLS flag or tick is read by the next plan."
        />
      )}
    </>
  );
}
