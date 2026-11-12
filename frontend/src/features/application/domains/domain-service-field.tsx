import { Controller, useFormContext } from "react-hook-form";

import { Field } from "@/components/console/field";
import { Picker } from "@/components/console/picker";
import { Input } from "@/components/ui/input";

import type { DomainValues, ServiceChoice } from "./domain-schema";
import { example } from "@/components/console/form-spec";

/**
 * Which service in a compose file this host reaches — a Compose stack only.
 *
 * A picker when the file could be read and a text box when it could not, which is
 * the *normal* state for a git-sourced stack that has never been deployed: the
 * route `cat`s the clone. A name typed from the repository is a perfectly good
 * answer and an empty picker is a dead end.
 */
export function DomainServiceField({ service }: { service: ServiceChoice }) {
  const form = useFormContext<DomainValues>();
  const names = service.names;

  return (
    <Field
      name="serviceName"
      label="Service"
      hint={
        names
          ? "Which service in the compose file this host reaches."
          : "Typed, because the file could not be read — it is cloned by a Deployment, and this stack may not have had one yet."
      }
      manual={names !== undefined}
    >
      {names ? (
        <Controller
          name="serviceName"
          control={form.control}
          render={({ field }) => (
            <Picker
              mono
              options={names.map((name) => ({ value: name, label: name }))}
              value={field.value}
              onValueChange={field.onChange}
              pending={service.pending}
              placeholder={
                names.length === 0
                  ? "This file declares no services"
                  : "Choose a service"
              }
            />
          )}
        />
      ) : (
        <Input
          placeholder={example("web")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      )}
    </Field>
  );
}
