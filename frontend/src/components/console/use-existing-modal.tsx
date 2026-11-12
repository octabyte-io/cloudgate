import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  existingRdsApi,
  type RdsKind,
} from "@/lib/api/endpoints/existing-postgres";

import { LetIn, Tick, useExistingForm } from "./existing-database-form";

const schema = z.object({
  // An RDS identifier on AWS, a Cloud SQL connection name on Google Cloud
  // the backend checks which the Cloud account's cloud takes.
  identifier: z
    .string()
    .trim()
    .regex(
      /^(?:[a-zA-Z][a-zA-Z0-9-]{0,62}|[a-z][a-z0-9.:-]*:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9-]*)$/,
      "An RDS identifier (letters, digits and hyphens, starting with a letter) or a Cloud SQL connection name (project:region:instance).",
    ),
  databaseUser: z.string().trim().min(1, "The login the apps use."),
  databasePassword: z.string().min(1, "Its password."),
  databaseName: z.string().trim().min(1, "The database the apps use."),
  madeReachable: z.boolean(),
});
type Values = z.infer<typeof schema>;

/**
 * "Use an existing database" (ADR-0033): an Environment's `postgres`
 * entry, or its `mysql`, stands for an RDS instance the operator already has, without the
 * Project config changing. Opened from the plan row that would create the
 * entry. The login is the apps' own, never an admin one; it is stored
 * encrypted and only ever read back as set.
 *
 * It shows where this Environment's Services reach a database from, so the
 * operator can let them into its security group: Cloudgate never changes
 * that group. Once saved, the next plan looks the database up instead of
 * creating one.
 *
 * With `switchFrom`, the postgres Cloudgate made under that Config name
 * the same form asks for a switch (`service: ['update']`), made over
 * two Applies: the next plan's removes that Service, and once its Delete is
 * done the plan after it adds this one (ADR-0033).
 */
export function UseExistingModal({
  open,
  onOpenChange,
  environmentId,
  configName,
  switchFrom,
  kind = "postgres",
}: {
  kind?: RdsKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  configName: string;
  switchFrom?: string;
}) {
  const api = existingRdsApi(kind);
  const engine = kind === "mysql" ? "MySQL" : "PostgreSQL";
  const { form, reach } = useExistingForm<Values>({
    kind,
    environmentId,
    open,
    schema,
    defaultValues: {
      identifier: "",
      databaseUser: "",
      databasePassword: "",
      databaseName: "",
      madeReachable: false,
    },
    permission: switchFrom ? "update" : "create",
    save: (values) =>
      switchFrom
        ? api.switchToExisting(switchFrom, values)
        : api.create({ environmentId, configName, ...values }),
    refreshes: switchFrom ? { kind, databaseId: switchFrom } : undefined,
    done: (values) =>
      switchFrom
        ? {
            title: `${configName} switches to ${values.identifier} at the next plan.`,
            description:
              "Check for changes: that plan's Apply deletes the database Cloudgate made. Once its Delete is done, the next plan's Apply adds this one. No data is copied.",
          }
        : {
            title: `${configName} uses ${values.identifier}.`,
            description:
              "Check for changes: the next plan looks it up instead of creating one.",
          },
    onClose: () => onOpenChange(false),
  });

  // A Cloud SQL instance on Google Cloud, else an RDS one.
  const onGoogle = reach?.google != null;
  const instance = onGoogle
    ? `A Cloud SQL for ${engine} instance`
    : `An RDS for ${engine} instance`;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={
          switchFrom
            ? `Switch ${configName} to an existing database`
            : `Use an existing database for ${configName}`
        }
        description={
          switchFrom
            ? `${instance} you already have, in this Environment's region. The next plan's Apply deletes the database Cloudgate made, with its usual confirmation and final snapshot. Once that Delete is done, the plan after it adds this one. No data is copied.`
            : `${instance} you already have, in this Environment's region. Cloudgate looks it up at every plan and never changes, stops or deletes it. The Project config does not change.`
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="identifier"
              label={onGoogle ? "Connection name" : "RDS identifier"}
              hint={
                onGoogle
                  ? "As the Cloud SQL console lists it, project:region:instance."
                  : "As the RDS console lists it, e.g. acme-prod."
              }
            >
              <Input
                placeholder={
                  onGoogle ? "shop-prod:europe-west1:acme-prod" : "acme-prod"
                }
                autoComplete="off"
              />
            </Field>
            <Field
              name="databaseUser"
              label="Login"
              hint="The login your apps use, not an admin one. Cloudgate makes no user."
            >
              <Input autoComplete="off" />
            </Field>
            <Field
              name="databasePassword"
              label="Password"
              hint="Stored encrypted and never shown again, only that it is set."
            >
              <Input type="password" autoComplete="new-password" />
            </Field>
            <Field
              name="databaseName"
              label="Database"
              hint="The database your apps use. Cloudgate makes no database."
            >
              <Input autoComplete="off" />
            </Field>
            <LetIn reach={reach} />
            {onGoogle ? null : (
              <Tick
                name="madeReachable"
                label="I made it reachable from this Environment"
                hint="Needed when it is outside this Environment network's VPC, as one made before it always is. Cloudgate cannot check it, and the plan says so."
              />
            )}
            {form.rootError ? <FormError message={form.rootError} /> : null}
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {switchFrom ? "Switch at the next plan" : "Use this database"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
