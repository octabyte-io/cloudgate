import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Controller, FormProvider, type FieldValues } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";

import { Field } from "@/components/console/field";
import type { FieldSpec } from "@/components/console/form-spec";
import { useApiForm } from "@/components/console/use-api-form";
import { Switch } from "@/components/ui/switch";
import {
  CHANNELS,
  EVENT_FIELDS,
} from "@/features/integrations/notifications/channels";
import { errorRateThresholdSpec } from "@/features/service-health/error-rate-threshold-spec";
import { uptimeCheckSpec } from "@/features/service-health/uptime-check-spec";

import { ResourceField } from "./resource-field";

afterEach(cleanup);

/**
 * **Every spec-built switch is named by its label.**
 *
 * `Field` cloned its child to hand it `id`, `aria-describedby` and
 * `aria-invalid`, and for a switch that child is react-hook-form's
 * `Controller`, which drops all three. The label's `htmlFor` pointed at
 * nothing, so `getByRole("switch", { name: "Deployment succeeded" })` found
 * none of the thirteen event switches in Add a channel, and no hint or error
 * was linked to any of them. `Field` now wires whatever a `Controller` renders.
 */

function Harness({
  fields,
  schema,
  defaults,
}: {
  fields: FieldSpec<FieldValues>[];
  schema: ZodType<FieldValues>;
  defaults: FieldValues;
}) {
  const form = useApiForm<FieldValues>({
    schema,
    defaultValues: defaults,
    onSubmit: () => undefined,
  });
  const values = form.watch();
  return (
    <FormProvider {...form}>
      <form noValidate onSubmit={form.submit}>
        {fields.map((field) => (
          <ResourceField
            key={field.name}
            spec={{ ...field, when: undefined } as FieldSpec<FieldValues>}
            values={values}
          />
        ))}
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

const noop = async () => undefined;

describe("a kind: \"switch\" field", () => {
  it("is named by its label and described by its hint", () => {
    render(
      <Harness
        fields={[
          { kind: "switch", name: "on", label: "Deployment succeeded", hint: "When a deploy finishes." },
        ]}
        schema={z.object({ on: z.boolean() }) as ZodType<FieldValues>}
        defaults={{ on: false }}
      />,
    );
    const control = screen.getByRole("switch", { name: "Deployment succeeded" });
    expect(control.getAttribute("aria-describedby")).toBeTruthy();
    const described = control
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("When a deploy finishes.");
  });

  it("is marked invalid and linked to its error when the schema refuses it", async () => {
    render(
      <Harness
        fields={[{ kind: "switch", name: "on", label: "Agree" }]}
        schema={
          z.object({
            on: z.boolean().refine((value) => value, "Turn this on to go on."),
          }) as ZodType<FieldValues>
        }
        defaults={{ on: false }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Turn this on to go on.")).toBeTruthy());
    const control = screen.getByRole("switch", { name: "Agree" });
    expect(control.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("Turn this on to go on.");
    expect(control.getAttribute("aria-describedby")).toContain(error.id);
  });

  it("gives a kind: \"select\" field its label as its name too", () => {
    render(
      <Harness
        fields={[
          {
            kind: "select",
            name: "pick",
            label: "Region",
            options: [{ value: "a", label: "A" }],
          },
        ]}
        schema={z.object({ pick: z.string() }) as ZodType<FieldValues>}
        defaults={{ pick: "" }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Region" })).toBeTruthy();
  });
});

describe("a hand-written Field around a Controller", () => {
  it("names the switch the Controller renders", () => {
    function Inline() {
      const form = useApiForm<FieldValues>({
        schema: z.object({ autoDeploy: z.boolean() }) as ZodType<FieldValues>,
        defaultValues: { autoDeploy: true },
        onSubmit: () => undefined,
      });
      return (
        <FormProvider {...form}>
          <Field name="autoDeploy" label="Deploy on push" hint="Off builds nothing." manual>
            <Controller
              name="autoDeploy"
              control={form.control}
              render={({ field }) => (
                <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
              )}
            />
          </Field>
        </FormProvider>
      );
    }
    render(<Inline />);
    expect(screen.getByRole("switch", { name: "Deploy on push" })).toBeTruthy();
  });
});

/** The producers that declare switches, driven through their own specs. */
const PRODUCERS: { label: string; fields: FieldSpec<FieldValues>[] }[] = [
  {
    label: "Add a channel's events",
    fields: EVENT_FIELDS as FieldSpec<FieldValues>[],
  },
  ...CHANNELS.map((channel) => ({
    label: `${channel.label} channel`,
    fields: channel.fields as FieldSpec<FieldValues>[],
  })),
  {
    label: "Uptime check",
    fields: uptimeCheckSpec({
      serviceType: "application",
      serviceId: "app",
      domains: [],
      domainsPending: false,
      publishedPortsPending: false,
      create: noop,
      update: noop,
      remove: noop,
    }).fields as FieldSpec<FieldValues>[],
  },
  {
    label: "Error-rate threshold",
    fields: errorRateThresholdSpec({ put: noop, remove: noop })
      .fields as FieldSpec<FieldValues>[],
  },
];

describe("every switch a producer declares", () => {
  const withSwitches = PRODUCERS.filter(({ fields }) =>
    fields.some((field) => field.kind === "switch"),
  );

  it("covers the thirteen event switches and more", () => {
    const count = withSwitches.flatMap(({ fields }) =>
      fields.filter((field) => field.kind === "switch"),
    ).length;
    expect(count).toBeGreaterThan(13);
  });

  it.each(withSwitches.map((producer) => [producer.label, producer] as const))(
    "%s: each switch is named by its label",
    (_, { fields }) => {
      const switches = fields.filter((field) => field.kind === "switch");
      render(
        <Harness
          fields={switches}
          schema={z.object({}).passthrough() as ZodType<FieldValues>}
          defaults={Object.fromEntries(switches.map((field) => [field.name, false]))}
        />,
      );
      for (const field of switches) {
        expect(
          screen.getByRole("switch", { name: String(field.label) }),
        ).toBeTruthy();
      }
    },
  );
});
