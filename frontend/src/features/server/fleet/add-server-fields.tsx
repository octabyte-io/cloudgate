import { Field } from "@/components/console/field";
import { Input } from "@/components/ui/input";
import { example } from "@/components/console/form-spec";

/**
 * The five text fields, in two rows: what the machine is called, then where it is.
 *
 * The port and user show **the backend's own defaults** rather than being left
 * blank — a port field showing nothing looks optional, and this one has an answer.
 */
export function AddServerFields() {
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Field name="name" label="Name" className="min-w-0 flex-[1_1_190px]">
          <Input placeholder={example("web-1")} autoComplete="off" />
        </Field>
        <Field
          name="description"
          label="Description"
          optional
          className="min-w-0 flex-[1_1_190px]"
        >
          <Input
            placeholder={example("EU host, takes the storefront")}
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-3">
        <Field
          name="ipAddress"
          label="Address"
          hint="An IP address or a hostname."
          className="min-w-0 flex-[1_1_190px]"
        >
          <Input
            placeholder={example("203.0.113.10")}
            autoComplete="off"
            className="font-mono"
          />
        </Field>
        <Field name="port" label="SSH port" className="w-28">
          <Input type="number" inputMode="numeric" className="font-mono" />
        </Field>
        <Field
          name="username"
          label="SSH user"
          hint="Root, or a user with passwordless sudo."
          className="min-w-0 flex-[1_1_150px]"
        >
          <Input autoComplete="off" className="font-mono" />
        </Field>
      </div>
    </>
  );
}
