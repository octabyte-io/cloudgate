import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  existingRedisApi,
  VALKEY_INSTANCE_NAME,
} from "@/lib/api/endpoints/existing-redis";

import { LetIn, Tick, useExistingForm } from "./existing-database-form";

/** An ElastiCache replication group id, as ElastiCache takes one. */
export const REPLICATION_GROUP_ID = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/;

/** An ElastiCache AUTH token: 16–128 printable characters, no space, `"`, `/` or `@`. */
export const AUTH_TOKEN = /^[!#-.0-?A-~]{16,128}$/;

export const AUTH_TOKEN_MESSAGE =
  'An AUTH token: 16 to 128 characters, none of them a space, ", / or @.';

const schema = z.object({
  // A replication group id on AWS, a Memorystore for Valkey instance name on
  // Google Cloud: the backend checks which the Cloud account's cloud
  // takes.
  identifier: z
    .string()
    .trim()
    .refine(
      (value) =>
        REPLICATION_GROUP_ID.test(value) || VALKEY_INSTANCE_NAME.test(value),
      "A replication group id (letters, digits and hyphens, starting with a letter) or a Valkey instance name (project/region/instance).",
    ),
  authToken: z.string().regex(AUTH_TOKEN, AUTH_TOKEN_MESSAGE).or(z.literal("")),
  tls: z.boolean(),
  madeReachable: z.boolean(),
});
type Values = z.infer<typeof schema>;

/**
 * "Use an existing database" for a `redis` (ADR-0033): an
 * Environment's `redis` entry stands for a node-based ElastiCache
 * replication group with cluster mode off that the operator already has,
 * without the Project config changing. Opened from the plan row that would
 * create the entry. Its AUTH token is stored encrypted and only ever read
 * back as set; TLS on (the default) hands out `rediss://` and a `ca`.
 *
 * With `switchFrom`, the redis Cloudgate made under that Config name
 * the same form asks for a switch (`service: ['update']`), made over
 * two Applies: the next plan's removes that Service, and once its Delete is
 * done the plan after it adds this one (ADR-0033).
 */
export function UseExistingCacheModal({
  open,
  onOpenChange,
  environmentId,
  configName,
  switchFrom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  configName: string;
  switchFrom?: string;
}) {
  const { form, reach } = useExistingForm<Values>({
    kind: "redis",
    environmentId,
    open,
    schema,
    defaultValues: {
      identifier: "",
      authToken: "",
      tls: true,
      madeReachable: false,
    },
    permission: switchFrom ? "update" : "create",
    save: (values) =>
      switchFrom
        ? existingRedisApi.switchToExisting(switchFrom, values)
        : existingRedisApi.create({ environmentId, configName, ...values }),
    refreshes: switchFrom
      ? { kind: "redis", databaseId: switchFrom }
      : undefined,
    done: (values) =>
      switchFrom
        ? {
            title: `${configName} switches to ${values.identifier} at the next plan.`,
            description:
              "Check for changes: that plan's Apply deletes the cache Cloudgate made. Once its Delete is done, the next plan's Apply adds this one. No data is copied.",
          }
        : {
            title: `${configName} uses ${values.identifier}.`,
            description:
              "Check for changes: the next plan looks it up instead of creating one.",
          },
    onClose: () => onOpenChange(false),
  });

  // A Memorystore for Valkey instance on Google Cloud, else an
  // ElastiCache replication group. Its TLS and login are read, never typed.
  const onGoogle = reach?.google != null;
  const what = onGoogle
    ? "A Memorystore for Valkey instance with cluster mode off and authorization off that you already have, in this Environment's region."
    : "A node-based ElastiCache replication group with cluster mode off that you already have, in this Environment's Cloud account and region.";

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={
          switchFrom
            ? `Switch ${configName} to an existing cache`
            : `Use an existing cache for ${configName}`
        }
        description={
          switchFrom
            ? `${what} The next plan's Apply deletes the cache Cloudgate made, with its usual confirmation and final snapshot. Once that Delete is done, the plan after it adds this one. No data is copied.`
            : `${what} ${onGoogle ? "Memorystore for Redis and Redis Cluster are refused." : "Serverless caches and cluster mode are refused."} Cloudgate looks it up at every plan and never changes or deletes it. The Project config does not change.`
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="identifier"
              label={onGoogle ? "Instance name" : "Replication group id"}
              hint={
                onGoogle
                  ? "Its project, region and instance id, project/region/instance."
                  : "As the ElastiCache console lists it, e.g. acme-cache."
              }
            >
              <Input
                placeholder={
                  onGoogle
                    ? "shop-prod/europe-west1/orders-cache"
                    : "acme-cache"
                }
                autoComplete="off"
              />
            </Field>
            {onGoogle && reach?.google ? (
              <div className="mt-3.5 grid gap-1 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-meta text-tx-2">
                <p className="font-medium text-tx">
                  Cloudgate reaches it through two endpoints of its own
                </p>
                <p>
                  Nothing is changed on the instance. After the Apply, its page
                  shows the one command that registers the endpoints on it;
                  linked Services deploy without waiting for it. Its TLS is read
                  from the instance.
                </p>
                <p>
                  In another project, let Cloudgate read it so every plan can
                  look it up:{" "}
                  <span className="font-mono break-all">
                    {reach.google.readGrant}
                  </span>
                </p>
              </div>
            ) : null}
            {onGoogle ? null : (
              <>
                <Field
                  name="authToken"
                  label="AUTH token"
                  hint="Stored encrypted and never shown again, only that it is set. Leave blank for a cache with none."
                >
                  <Input type="password" autoComplete="new-password" />
                </Field>
                <Tick
                  name="tls"
                  label="TLS"
                  hint="On: Services get a rediss:// URL and a ca. Off: a redis:// URL, for a cache without in-transit encryption."
                />
                <LetIn reach={reach} />
                <Tick
                  name="madeReachable"
                  label="I made it reachable from this Environment"
                  hint="Needed when it is outside this Environment network's VPC. Cloudgate cannot check it, and the plan says so."
                />
              </>
            )}
            {form.rootError ? <FormError message={form.rootError} /> : null}
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {switchFrom ? "Switch at the next plan" : "Use this cache"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
