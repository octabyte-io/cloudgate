"use client";

import Link from "next/link";
import { Controller, useFormContext, useWatch } from "react-hook-form";

import { Field } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  AskedInput,
  SetupDomain,
  SetupEnvironment,
} from "@/lib/api/endpoints/templates";
import { Icon } from "@/lib/design/icons";
import { settingsHref } from "@/lib/settings/sections";

import { isYesNo } from "./asked-value";
import { SetupDnsRecords } from "./setup-dns-records";

/**
 * The setup form's text fields: an asked value, with its one check's input
 * type, and each compose Domain's host (#1373). Apart from the form so it
 * stays within the file budget; each is a `Field` of the form around it.
 */

/** The asked value at `at` in the template's list. */
export function AskedField({ input, at }: { input: AskedInput; at: number }) {
  if (isYesNo(input)) return <YesNoField input={input} at={at} />;
  return (
    <Field
      name={`values.${at}`}
      label={input.label}
      optional={!input.required}
      hint={input.description ?? undefined}
    >
      {input.secret ? (
        <PasswordInput autoComplete="off" />
      ) : (
        <Input
          autoComplete="off"
          type={
            input.format === "email"
              ? "email"
              : input.format === "url"
                ? "url"
                : "text"
          }
        />
      )}
    </Field>
  );
}

/** A yes-or-no asked value, as a switch that stores `"true"` or `"false"`. */
function YesNoField({ input, at }: { input: AskedInput; at: number }) {
  const { control } = useFormContext();
  return (
    <Field
      name={`values.${at}`}
      label={input.label}
      hint={input.description ?? undefined}
      orientation="horizontal"
      manual
    >
      <Controller
        name={`values.${at}`}
        control={control}
        render={({ field }) => (
          <Switch
            checked={field.value === "true"}
            onCheckedChange={(next) => field.onChange(next ? "true" : "false")}
          />
        )}
      />
    </Field>
  );
}

/**
 * Each compose Domain's host (#1373): it starts on the generated sslip.io
 * host of the Environment, or for a new Project of the Deploy target, picked,
 * which the user may replace with their own domain; "Generate one for me"
 * puts the generated one back. Where none is generated, the user types one.
 * In a Cloud Environment (#1379) the stack's Stack VM has no generated host:
 * each host is typed, and the DNS record it needs is shown under it.
 */
export function DomainHostFields({
  domains,
  generated,
  cloud,
}: {
  domains: readonly SetupDomain[];
  /** The generated host of each Domain, by its name; null where none is. */
  generated: Readonly<Record<string, string>> | null;
  /** Set in a Cloud Environment: where its Domains point. */
  cloud: SetupEnvironment["cloudDomains"];
}) {
  const { setValue } = useFormContext();
  const hosts = useWatch({ name: "hosts" }) as string[] | undefined;
  return domains.map((domain, at) => {
    const offered = cloud ? undefined : generated?.[domain.name];
    const host = hosts?.[at] ?? "";
    return (
      <div key={domain.name} className="grid gap-2">
        <Field
          name={`hosts.${at}`}
          label={
            <>
              {domain.service}&rsquo;s Domain{" "}
              <span className="font-mono text-meta font-normal text-tx-3">
                port {domain.port}
                {domain.path === "/" ? "" : ` at ${domain.path}`}
              </span>
            </>
          }
          hint={hostHint(domain.service, {
            cloud: cloud !== null,
            offered,
            onOffered: offered !== undefined && host.trim() === offered,
          })}
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="app.example.com"
            className="font-mono text-meta md:text-meta"
          />
        </Field>
        {offered !== undefined && host.trim() !== offered ? (
          <div>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                setValue(`hosts.${at}`, offered, { shouldValidate: true })
              }
            >
              <Icon name="spark" size={14} />
              Generate one for me
            </Button>
          </div>
        ) : null}
        {cloud ? (
          <SetupDnsRecords host={host} pointsAt={cloud.pointsAt} />
        ) : null}
      </div>
    );
  });
}

/** What a Domain's host field says under it, for where the setup goes. */
function hostHint(
  service: string,
  {
    cloud,
    offered,
    onOffered,
  }: { cloud: boolean; offered: string | undefined; onOffered: boolean },
): React.ReactNode {
  if (cloud) {
    return "Type your own domain: a Stack VM has no generated host. Its Domain is added once the Plan's Apply has made the Stack VM.";
  }
  if (onOffered) {
    return "A free sslip.io address that works right away, over HTTPS when the Server's address is public. To use your own domain instead, type it here and point its DNS at the Server.";
  }
  if (offered !== undefined) {
    return `The address people open ${service} at: your own domain, with its DNS pointed at the Server, or a free sslip.io one.`;
  }
  // Nothing generated off the cloud: the platform host has no IP address
  // recorded, and its public address is where one is set.
  return (
    <>
      The address people open {service} at: your own domain, with its DNS
      pointed at the Server. For a free sslip.io address on this Cloudgate host,
      set its public IP under{" "}
      <Link
        href={settingsHref("instance")}
        className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
      >
        Settings, Instance
      </Link>
      .
    </>
  );
}
