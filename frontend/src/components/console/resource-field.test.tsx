import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { FormProvider, type FieldValues } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";

import { Card } from "@/components/console/card";
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
  place = "form",
}: {
  form: Form;
  onReady: (read: () => FieldValues) => void;
  /**
   * Where the fields sit: in a `<form>` (the default), in a form inside a
   * titled card, in a form whose Save is refused, or in no form at all.
   */
  place?: Place;
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
  const fields = spec.fields(values).map((field) => (
    <ResourceField
      key={field.name}
      // Shown whatever the form holds: a Pushover retry is only on screen
      // at priority 2, and the census is about the box, not the rule.
      spec={field.kind === "number" ? { ...field, when: undefined } : field}
      values={values}
    />
  ));
  if (place === "none") {
    return <FormProvider {...form}>{fields}</FormProvider>;
  }
  const inForm = (
    <form method="post" onSubmit={form.submit}>
      {fields}
      {place === "refused" ? (
        <button type="submit" disabled title="Your role cannot change mounts.">
          Save
        </button>
      ) : (
        <button type="submit">Save</button>
      )}
    </form>
  );
  return (
    <FormProvider {...form}>
      {place === "card" ? (
        <Card>
          <Card.Header title="Mounts" />
          <Card.Body>{inForm}</Card.Body>
        </Card>
      ) : (
        inForm
      )}
    </FormProvider>
  );
}

const TYPE_REFUSAL = /expected number|received (string|nan|undefined)/i;

type Place = "form" | "card" | "refused" | "none";

function mount(form: Form, place?: Place) {
  let read: () => FieldValues = () => ({});
  render(<Harness form={form} place={place} onReady={(next) => (read = next)} />);
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

/**
 * Spec #118: a text box holding a whole file (a mount's content, a
 * certificate, a shell command) opens in the window-filling editor, and a
 * text box holding a sentence does not.
 */
describe("ResourceField as a text box", () => {
  const STORED = "server {\n}\n";
  const EDITED = "server {\n  listen 80;\n}\n";

  function files(after?: (values: FieldValues) => void): Form {
    return {
      label: "a mount",
      after,
      fields: () => [
        { kind: "textarea", name: "content", label: "Content", mono: true },
        { kind: "textarea", name: "note", label: "Note" },
      ],
      schema: z.object({
        content: z.string(),
        note: z.string(),
      }) as ZodType<FieldValues>,
      defaults: { content: STORED, note: "" },
    };
  }

  it("shows Expand on a mono text box and not on a plain one", () => {
    mount(files());

    const expands = screen.getAllByRole("button", { name: "Expand Content" });
    expect(expands).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Expand Note/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Expand/ })).toHaveLength(1);
  });

  it("opens the file filling the window, and a typed edit reaches the form and stays on Back to page", async () => {
    const read = mount(files());

    fireEvent.click(screen.getByRole("button", { name: "Expand Content" }));
    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("heading", { name: "Content" })).toBeTruthy();
    const expanded = dialog.querySelector("textarea");
    if (!expanded) throw new Error("the expanded editor has no text box");
    expect(expanded.value).toBe(STORED);

    fireEvent.change(expanded, { target: { value: EDITED } });
    expect(read().content).toBe(EDITED);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to page" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const box = document.querySelector<HTMLTextAreaElement>(
      'textarea[name="content"]',
    );
    expect(box?.value).toBe(EDITED);
  });

  it("saves the form from the top bar with the form's own Save, back on the page", async () => {
    let submitted: FieldValues | null = null;
    mount(
      files((values) => {
        submitted = values;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand Content" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Content"), {
      target: { value: EDITED },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    // Back on the page, where the form's own result or refusal is shown.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(submitted).toEqual({ content: EDITED, note: "" }));
  });

  it("is off in the top bar, with the reason, while the form's own Save is", () => {
    mount(files(), "refused");

    fireEvent.click(screen.getByRole("button", { name: "Expand Content" }));
    const save = within(screen.getByRole("dialog")).getByRole("button", { name: "Save" });

    expect(
      save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(save.getAttribute("title")).toBe("Your role cannot change mounts.");
  });

  it("offers no Save for a text box that is in no form", () => {
    mount(files(), "none");

    fireEvent.click(screen.getByRole("button", { name: "Expand Content" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).queryByRole("button", { name: /Save/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Back to page" })).toBeTruthy();
  });

  it("says where the file belongs by the card its form is in", () => {
    mount(files(), "card");

    fireEvent.click(screen.getByRole("button", { name: "Expand Content" }));
    const dialog = screen.getByRole("dialog");

    expect(dialog.textContent).toContain("Mounts");
    expect(dialog.textContent).not.toContain("Saved with the rest of this form");
  });

  it("keeps the sentence for a form nothing titles", () => {
    mount(files());

    fireEvent.click(screen.getByRole("button", { name: "Expand Content" }));

    expect(screen.getByRole("dialog").textContent).toContain(
      "Saved with the rest of this form, from its own Save.",
    );
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
