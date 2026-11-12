"use client";

import { useWatch } from "react-hook-form";

import { Field } from "@/components/console/field";
import { PasswordInput } from "@/components/console/password-input";
import { Input } from "@/components/ui/input";
import type {
  AskedInput,
  SetupDomain,
  SetupEnvironment,
} from "@/lib/api/endpoints/templates";

import { SetupDnsRecords } from "./setup-dns-records";

/**
 * The setup form's text fields: an asked value, with its one check's input
 * type, and each compose Domain's host (#1373). Apart from the form so it
 * stays within the file budget; each is a `Field` of the form around it.
 */

/** The asked value at `at` in the template's list. */
export function AskedField({ input, at }: { input: AskedInput; at: number }) {
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

/**
 * Each compose Domain's host (#1373): it starts on the Environment's
 * generated sslip.io host, which the user may replace with their own domain;
 * where none is generated, the user types one. In a Cloud Environment
 * (#1379) the stack's Stack VM has no generated host: each host is typed,
 * and the DNS record it needs is shown under it.
 */
export function DomainHostFields({
  domains,
  cloud,
}: {
  domains: readonly SetupDomain[];
  /** Set in a Cloud Environment: where its Domains point. */
  cloud: SetupEnvironment["cloudDomains"];
}) {
  const hosts = useWatch({ name: "hosts" }) as string[] | undefined;
  return domains.map((domain, at) => (
    <div key={domain.name} className="grid gap-2">
      <Field
        name={`hosts.${at}`}
        label={`Host of ${domain.service}, port ${domain.port}${domain.path === "/" ? "" : ` at ${domain.path}`}`}
        hint={
          cloud
            ? "Type your own domain: a Stack VM has no generated host. Its Domain is added once the Plan's Apply has made the Stack VM."
            : "A generated sslip.io host reaches it at once, over plain HTTP; replace it with your own domain, pointed at the Server, to serve it over HTTPS with a Let's Encrypt certificate."
        }
      >
        <Input autoComplete="off" />
      </Field>
      {cloud ? (
        <SetupDnsRecords host={hosts?.[at] ?? ""} pointsAt={cloud.pointsAt} />
      ) : null}
    </div>
  ));
}
