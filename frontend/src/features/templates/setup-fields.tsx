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
import {
  addressInSslipName,
  isSslip,
} from "@/features/application/domains/dns-helper";
import { Icon } from "@/lib/design/icons";
import { hostnameValue, isHostname } from "@/lib/forms/hostname";
import { settingsHref } from "@/lib/settings/sections";

import { isYesNo } from "./asked-value";
import { SetupDnsCheck } from "./setup-dns-check";
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
  platformHost,
}: {
  domains: readonly SetupDomain[];
  /** The generated host of each Domain, by its name; null where none is. */
  generated: Readonly<Record<string, string>> | null;
  /** Set in a Cloud Environment: where its Domains point. */
  cloud: SetupEnvironment["cloudDomains"];
  /** Whether the setup goes on this Cloudgate host, the platform host. */
  platformHost: boolean;
}) {
  return domains.map((domain, at) => (
    <DomainHostField
      key={domain.name}
      domain={domain}
      at={at}
      offered={cloud ? undefined : generated?.[domain.name]}
      cloud={cloud}
      platformHost={platformHost}
    />
  ));
}

/**
 * One compose Domain's host. On a Server or this Cloudgate host, an own
 * domain typed in place of the generated one gets the Add a domain dialog's
 * DNS panel under it: the A record and Check DNS (`SetupDnsCheck`). An
 * sslip.io host gets neither, generated or typed, since sslip.io answers
 * from the name and there is no record to make.
 *
 * **Where the record points is read off the generated host**, which is
 * `generateHostForNewService`'s name carrying the very address the Domain
 * is routed on: the Server's, or the platform host's public address. The
 * setup form carries no address of its own, and adding one would be a second
 * answer to a question the generated host already answers. No generated host
 * off the cloud is the platform host with no public address recorded, which
 * the panel says where to set. A generated host whose address cannot be read
 * back (an IPv6 Server's dashed name) shows no panel: `DnsHelper` prints an A
 * record, and an A record for a v6 address, or one "pointing at this
 * Cloudgate host", would be a wrong instruction rather than a missing one.
 */
function DomainHostField({
  domain,
  at,
  offered,
  cloud,
  platformHost,
}: {
  domain: SetupDomain;
  at: number;
  offered: string | undefined;
  cloud: SetupEnvironment["cloudDomains"];
  platformHost: boolean;
}) {
  const { setValue } = useFormContext();
  const host = hostnameValue(
    (useWatch({ name: `hosts.${at}` }) as string | undefined) ?? "",
  );
  const address = offered === undefined ? null : addressInSslipName(offered);
  const ownDomain =
    cloud === null &&
    isHostname(host) &&
    !isSslip(host) &&
    (offered === undefined || address !== null);
  const generate =
    offered !== undefined && host !== offered ? (
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
    ) : null;
  return (
    <div className="grid gap-2">
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
          address,
          onOffered: offered !== undefined && host === offered,
          platformHost,
        })}
      >
        <Input
          autoComplete="off"
          spellCheck={false}
          placeholder="app.example.com"
          className="font-mono text-meta md:text-meta"
        />
      </Field>
      {ownDomain ? (
        <SetupDnsCheck host={host} pointsAt={address} beside={generate} />
      ) : generate ? (
        <div>{generate}</div>
      ) : null}
      {cloud ? <SetupDnsRecords host={host} pointsAt={cloud.pointsAt} /> : null}
    </div>
  );
}

/** What a Domain's host field says under it, for where the setup goes. */
function hostHint(
  service: string,
  {
    cloud,
    offered,
    address,
    onOffered,
    platformHost,
  }: {
    cloud: boolean;
    offered: string | undefined;
    /** The address the generated host carries; null where it carries none. */
    address: string | null;
    onOffered: boolean;
    /** Whether the setup goes on this Cloudgate host. */
    platformHost: boolean;
  },
): React.ReactNode {
  if (cloud) {
    return "Type your own domain: a Stack VM has no generated host. Its Domain is added once the Plan's Apply has made the Stack VM.";
  }
  const record = `an A record for it pointing at ${address ?? "the Server's address"}`;
  if (onOffered) {
    return `A free sslip.io address that works right away, over HTTPS when the Server's address is public. To use your own domain instead, type it here and add ${record}.`;
  }
  if (offered !== undefined) {
    return `The address people open ${service} at: your own domain, with ${record}, or a free sslip.io one.`;
  }
  // Nothing generated on a Server, or before a Deploy target is chosen: the
  // record points at the Server, and there is no Instance setting to send
  // anyone to. Said in place of the platform host's sentence, which a Hosted
  // customer can neither deploy to nor change (#128).
  if (!platformHost) {
    return `The address people open ${service} at: your own domain, with ${record}.`;
  }
  // Nothing generated on the platform host: it has no IP address recorded,
  // and its public address is where one is set.
  return (
    <>
      The address people open {service}{" "}
      at: your own domain, with an A record for it pointing at this Cloudgate
      host. For the record&rsquo;s address, and a free sslip.io one, set its
      public IP under{" "}
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
