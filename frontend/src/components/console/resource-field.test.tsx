import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FormProvider, type FieldValues } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import { useApiForm } from "@/components/console/use-api-form";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { portsSpec } from "@/features/application/advanced/networking-specs";
import { swarmConcerns } from "@/features/application/advanced/swarm/swarm-concerns";
import {
  toSwarmColumns,
  toSwarmValues,
  type SwarmValues,
} from "@/features/application/advanced/swarm/swarm-values";
import { PROVIDERS } from "@/features/integrations/git-providers/providers";
import { CHANNELS } from "@/features/integrations/notifications/channels";
import { errorRateThresholdSpec } from "@/features/service-health/error-rate-threshold-spec";
import { uptimeCheckSpec } from "@/features/service-health/uptime-check-spec";
import {
  metricsFields,
  metricsFormSchema,
} from "@/features/monitoring/setup/metrics-config-spec";

import { ResourceField } from "./resource-field";

afterEach(cleanup);

/**
 * **The census: every `kind: "number"` field in the console holds a
 * number.**
 *
 * `ResourceField` rendered `<Input type="number">` and registered it with
 * nothing, so react-hook-form held the box's **string**. Every spec written
 * against that survived only by saying `z.coerce.number()`; the ports spec
 * said `z.number()` and could never be saved — "Invalid input: expected
 * number, received string" under both boxes, for any value (U-72). Fixing the
 * one spec would have left the next plain `z.number()` to break the same way,
 * so the conversion is now in the field and this file holds the class
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites").
 *
 * Two halves, because a census built by hand misses a site:
 *
 * 1. **Which files declare a number field is read off the source**, not
 *    written down. A file that gains one and is not in `CENSUS` below reds the
 *    last test, so site N+1 arrives through this table.
 * 2. **Each exported producer is driven for real** — its own fields, its own
 *    schema, its own defaults, through `useApiForm` and `ResourceField` — and
 *    every number field it declares (read off the spec objects, not listed)
 *    has a digit typed into it and then the box cleared. Both directions:
 *    typed is a number, cleared is `undefined`, and never a string or `NaN`.
 *
 * Not asserted: whether the typed digit is *in range*. `7` is above ntfy's
 * priority ceiling and that refusal is the spec's own business; what this
 * holds is that no refusal is about the value's **type**.
 */

/** One form a module declares: its fields, its schema and where it starts. */
type Form = {
  label: string;
  fields: (values: FieldValues) => FieldSpec<FieldValues>[];
  schema: ZodType<FieldValues>;
  defaults: FieldValues;
  /** Anything the module does with the values after the schema passes. */
  after?: (values: FieldValues) => void;
};

type Entry =
  | { forms: () => Form[] }
  /**
   * A module whose fields live inline in a component, so there is nothing to
   * import and drive. Each says what its number field's value reaches, and
   * the mechanism test at the top of this file is what covers its box.
   */
  | { inline: string };

const noop = async () => undefined;

const application = {} as ApplicationDetail;

/**
 * Every source file declaring a `kind: "number"` field, and how it is held.
 * The keys are checked against the tree by the last test, both ways.
 */
const CENSUS: Record<string, Entry> = {
  "features/application/advanced/networking-specs.tsx": {
    forms: () => {
      const spec = portsSpec({
        applicationId: "app",
        create: noop,
        update: noop,
        remove: noop,
      });
      return [
        {
          label: "Ports",
          fields: () => spec.fields as FieldSpec<FieldValues>[],
          schema: spec.schema as ZodType<FieldValues>,
          defaults: spec.toDefaults(null),
        },
      ];
    },
  },
  "features/integrations/notifications/channels.ts": {
    forms: () =>
      CHANNELS.filter((channel) =>
        channel.fields.some((field) => field.kind === "number"),
      ).map((channel) => ({
        label: channel.label,
        fields: () => channel.fields as FieldSpec<FieldValues>[],
        schema: z.object(channel.shape) as ZodType<FieldValues>,
        defaults: channel.toDefaults(null),
        after: (values) => {
          channel.toBody(values as never);
        },
      })),
  },
  "features/integrations/git-providers/providers.ts": {
    forms: () =>
      PROVIDERS.filter((provider) =>
        provider.fields.some((field) => field.kind === "number"),
      ).map((provider) => ({
        label: provider.label,
        fields: () => provider.fields as FieldSpec<FieldValues>[],
        schema: z.object(provider.shape) as ZodType<FieldValues>,
        defaults: provider.toDefaults(null),
        after: (values) => {
          provider.toBody(values as never);
        },
      })),
  },
  "features/monitoring/setup/metrics-config-spec.ts": {
    forms: () => [
      {
        label: "Metrics",
        fields: () => metricsFields("over SSH") as FieldSpec<FieldValues>[],
        schema: metricsFormSchema as ZodType<FieldValues>,
        defaults: {
          refreshRate: 60,
          retentionDays: 2,
          cronJob: "0 3 * * *",
          cpuThreshold: 0,
          memoryThreshold: 0,
          containerRefreshRate: 60,
          include: "",
          exclude: "",
        },
      },
    ],
  },
  // Every Swarm number is optional and folded by `swarm-values.ts`, and the
  // hints read nanoseconds back off the live value — so both the fold and a
  // re-render with a typed number are part of what is driven here.
  "features/application/advanced/swarm/swarm-concerns.tsx": {
    forms: () => [
      {
        label: "Docker Swarm",
        fields: (values) =>
          swarmConcerns(values as SwarmValues).flatMap(
            (concern) => concern.fields,
          ) as FieldSpec<FieldValues>[],
        schema: z.object({}).passthrough() as ZodType<FieldValues>,
        defaults: toSwarmValues(application),
        after: (values) => {
          toSwarmColumns(values as SwarmValues, application);
        },
      },
    ],
  },
  "features/service-health/uptime-check-spec.tsx": {
    forms: () => {
      const spec = uptimeCheckSpec({
        serviceType: "application",
        serviceId: "app",
        domains: [],
        domainsPending: false,
        publishedPortsPending: false,
        create: noop,
        update: noop,
        remove: noop,
      });
      return [
        {
          label: "Uptime check",
          fields: () => spec.fields as FieldSpec<FieldValues>[],
          schema: spec.schema as ZodType<FieldValues>,
          defaults: spec.toDefaults(null),
        },
      ];
    },
  },
  "features/service-health/error-rate-threshold-spec.tsx": {
    forms: () => {
      const spec = errorRateThresholdSpec({ put: noop, remove: noop });
      return [
        {
          label: "Error-rate threshold",
          fields: () => spec.fields as FieldSpec<FieldValues>[],
          schema: spec.schema as ZodType<FieldValues>,
          defaults: spec.toDefaults(null),
        },
      ];
    },
  },
  "features/application/advanced/resources-card.tsx": {
    inline: "`replicas`, defaulted from the row as a number and sent as-is.",
  },
  "features/application/advanced/port-card.tsx": {
    inline: "`port`, defaulted from the row as a number and sent as-is.",
  },
  "features/application/advanced/copy-range-card.tsx": {
    inline:
      "`minCopies` and `maxCopies`, each defaulted from the row as a number and coerced by the schema.",
  },
  "features/database/panels/advanced-resources-card.tsx": {
    inline: "`replicas`, defaulted from the row as a number and sent as-is.",
  },
  "features/application/panels/previews-settings-card.tsx": {
    inline:
      "`previewLimit` and `requestedPreviewLimit`, each defaulted from the row as a number and sent as-is.",
  },
  "features/server/settings/connection-card.tsx": {
    inline: "`port`, defaulted from the row as a number and sent as-is.",
  },
  "features/settings/platform/concurrent-builds-card.tsx": {
    inline:
      "`buildsConcurrency`, defaulted from the row as a number and sent as-is.",
  },
  "features/application/create/create-ai-model-modal.tsx": {
    inline:
      "`gpus`, defaulted to 0 as a number, coerced by the schema and sent through `Number`; `create-ai-model-modal.test.tsx` drives it.",
  },
  "features/application/panels/extend-preview-modal.tsx": {
    inline:
      "`ttlMinutes`, defaulted to 60 as a number and sent as-is; `extend-preview-modal.test.tsx` drives it.",
  },
  "features/settings/platform/requested-preview-max-ttl-card.tsx": {
    inline:
      "`requestedPreviewMaxTtlMinutes`, defaulted from the row as a number and sent as-is.",
  },
  "features/database/backups/cloud-retention-card.tsx": {
    inline:
      "`retentionDays`, defaulted from the row as a number and coerced by the schema.",
  },
  "features/database/panels/elasticache-settings-card.tsx": {
    inline:
      "`snapshotRetentionDays`, defaulted from the row as a number and coerced by the schema.",
  },
  "features/database/panels/rds-settings-card.tsx": {
    inline:
      "`storageGb`, `maxStorageGb` and `backupRetentionDays`, defaulted from the row as numbers and coerced by the schema.",
  },
  "features/settings/platform/cloud-run-limits-card.tsx": {
    inline:
      "`cloudRunsConcurrency` and `cloudRunTimeLimitMinutes`, defaulted from the row as numbers and sent as-is.",
  },
  "features/compose/stack-vm/stack-vm-card.tsx": {
    inline:
      "`dataDiskGb`, defaulted from the stack's Stack VM facts as a number and coerced by the schema.",
  },
};

/** Whatever a module's own `after` threw, since `useApiForm` would swallow it. */
const thrown: unknown[] = [];
afterEach(() => {
  thrown.length = 0;
});

/** The form under test, with a handle on what it holds and what it submitted. */
function Harness({
  form: spec,
  onReady,
}: {
  form: Form;
  onReady: (read: () => FieldValues) => void;
}) {
  const form = useApiForm<FieldValues>({
    schema: spec.schema,
    defaultValues: spec.defaults,
    onSubmit: (values) => {
      try {
        spec.after?.(values);
      } catch (error) {
        thrown.push(error);
      }
    },
  });
  onReady(() => form.getValues());
  const values = form.watch();
  return (
    <FormProvider {...form}>
      <form method="post" onSubmit={form.submit}>
        {spec.fields(values).map((field) => (
          <ResourceField
            key={field.name}
            // Shown whatever the form holds: a Pushover retry is only on screen
            // at priority 2, and the census is about the box, not the rule.
            spec={
              field.kind === "number" ? { ...field, when: undefined } : field
            }
            values={values}
          />
        ))}
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

const TYPE_REFUSAL = /expected number|received (string|nan|undefined)/i;

function mount(form: Form) {
  let read: () => FieldValues = () => ({});
  render(<Harness form={form} onReady={(next) => (read = next)} />);
  return () => read();
}

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  // Resolver, then errors rendered: one tick is not enough for either.
  await waitFor(() => undefined);
}

describe("ResourceField", () => {
  it("hands a spec's plain z.number() a number, and an emptied box as undefined", async () => {
    let submitted: FieldValues | null = null;
    const form: Form = {
      label: "one port",
      fields: () => [
        { kind: "number", name: "port", label: "Port", optional: true },
      ],
      schema: z.object({
        port: z.number().int().optional(),
      }) as ZodType<FieldValues>,
      defaults: { port: 8080 },
      after: (values) => {
        submitted = values;
      },
    };
    mount(form);
    const box = screen.getByLabelText(/^Port/);

    fireEvent.change(box, { target: { value: "18080" } });
    await submit();
    expect(document.body.textContent).not.toMatch(TYPE_REFUSAL);
    expect(submitted).toEqual({ port: 18080 });

    fireEvent.change(box, { target: { value: "" } });
    await submit();
    expect(document.body.textContent).not.toMatch(TYPE_REFUSAL);
    // `undefined`, not `NaN` (which `valueAsNumber` gives) and not `""`.
    expect(submitted).toEqual({ port: undefined });
  });

  it("says a required number box left empty needs a number, in words", async () => {
    mount({
      label: "one port",
      fields: () => [{ kind: "number", name: "port", label: "Port" }],
      schema: z.object({ port: z.number().int() }) as ZodType<FieldValues>,
      defaults: { port: 8080 },
    });
    fireEvent.change(screen.getByLabelText(/^Port/), { target: { value: "" } });
    await submit();
    // zod's own words here are "Invalid input: expected number, received
    // undefined" — for a coerced schema, "received NaN".
    expect(screen.getByText("Enter a number.")).toBeTruthy();
  });
});

describe('every kind: "number" field in the console', () => {
  const driven = Object.entries(CENSUS).flatMap(([file, entry]) =>
    "forms" in entry ? entry.forms().map((form) => ({ file, form })) : [],
  );

  it.each(
    driven.map(({ file, form }) => [`${form.label} (${file})`, form] as const),
  )(
    "%s holds a number once a digit is typed, and undefined once the box is emptied",
    async (_, form) => {
      const read = mount(form);
      const numbers = form
        .fields(read())
        .filter((field) => field.kind === "number");
      // A module registered here with nothing to drive is a census that
      // proves nothing about it.
      expect(numbers.length).toBeGreaterThan(0);

      for (const field of numbers) {
        // By name, not label: update and rollback config both have a
        // "Parallelism", and the name is what the census is about.
        const box = document.querySelector(`input[name="${field.name}"]`);
        if (!box) throw new Error(`${field.name} is not on screen`);

        fireEvent.change(box, { target: { value: "7" } });
        // Still mounted: a render that throws reading the value back (a hint's
        // live reading) unmounts the tree under React 19 rather than failing
        // anything, so the box going away is the only sign of it.
        expect(box.isConnected).toBe(true);
        expect({ [field.name]: read()[field.name] }).toEqual({
          [field.name]: 7,
        });
        await submit();
        expect(document.body.textContent).not.toMatch(TYPE_REFUSAL);
        // What the module does after its schema passes — a fold, a body —
        // threw nothing.
        expect(thrown).toEqual([]);

        fireEvent.change(box, { target: { value: "" } });
        expect({ [field.name]: read()[field.name] }).toEqual({
          [field.name]: undefined,
        });
        await submit();
        // Nothing reached `NaN` on the way: not the schema, not a fold, not a
        // hint reading the value back.
        expect(document.body.textContent).not.toMatch(/NaN/);
      }
    },
  );

  it("names every file in src that declares one, and nothing that no longer does", () => {
    // `import.meta.url` is not a file URL under jsdom; vitest runs from the
    // package root, which is where `src` is.
    const src = join(process.cwd(), "src");
    const declaring: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          /kind:\s*"number"/.test(withoutComments(readFileSync(path, "utf8")))
        ) {
          declaring.push(relative(src, path));
        }
      }
    };
    walk(src);

    // `form-spec.ts` declares the type every one of these is an instance of.
    const expected = [
      ...Object.keys(CENSUS),
      "components/console/form-spec.ts",
    ];
    expect(declaring.sort()).toEqual(expected.sort());
  });
});

/** A comment saying `kind: "number"` declares nothing. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
