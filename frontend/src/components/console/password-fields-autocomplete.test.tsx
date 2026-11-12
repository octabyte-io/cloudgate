import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { FormProvider, useForm, type FieldValues } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";

import type { FieldSpec } from "@/components/console/form-spec";
import { securitySpec } from "@/features/application/advanced/networking-specs";
import { DATABASE_KINDS } from "@/lib/api/endpoints/databases";
import { connectionFields } from "@/features/database/kinds";
import { aiSpec } from "@/features/integrations/ai/ai-spec";
import { destinationSpec } from "@/features/integrations/destinations/destinations-spec";
import { PROVIDERS } from "@/features/integrations/git-providers/providers";
import { CHANNELS } from "@/features/integrations/notifications/channels";
import { registrySpec } from "@/features/integrations/registries/registries-spec";
import { uptimeCheckSpec } from "@/features/service-health/uptime-check-spec";

import { ResourceField } from "./resource-field";

afterEach(cleanup);

/**
 * **The census: every `kind: "password"` field in the console renders
 * with an `autocomplete` Chrome will not fill the console login into.**
 *
 * The renderer defaulted to `autocomplete="off"`, which Chrome ignores on a
 * password input. Opening **Add an Uptime check** or **Add Slack** filled the
 * secret with the operator's saved console password — masked, so nothing
 * showed it — and saving sent that password to the probed host on every Probe.
 * The default is now `new-password`; a spec may still declare its own token.
 *
 * Two halves, as `resource-field.test.tsx`'s number census:
 *
 * 1. **Which files declare a password field is read off the source.** A file
 *    that gains one and is not in `CENSUS` reds the last test.
 * 2. **Each producer's fields are rendered for real** through `ResourceField`,
 *    and every password field it declares (read off the spec objects, not
 *    listed) is asserted on the `autocomplete` the DOM carries.
 */

type Entry =
  | { label: string; fields: () => FieldSpec<FieldValues>[] }[]
  /** A module whose field is held by its own component's test, said where. */
  | { inline: string };

const noop = async () => undefined;

const as = <V extends FieldValues>(fields: FieldSpec<V>[]) =>
  fields as unknown as FieldSpec<FieldValues>[];

const CENSUS: Record<string, Entry> = {
  "features/application/advanced/networking-specs.tsx": [
    {
      label: "Basic auth",
      fields: () =>
        as(
          securitySpec({
            applicationId: "app",
            create: noop,
            update: noop,
            remove: noop,
          }).fields,
        ),
    },
  ],
  "features/database/kinds.ts": DATABASE_KINDS.map((kind) => ({
    label: `Database (${kind})`,
    fields: () => as(connectionFields(kind)),
  })),
  "features/integrations/ai/ai-spec.tsx": [
    { label: "AI provider", fields: () => as(aiSpec(noop).fields) },
  ],
  "features/integrations/destinations/destinations-spec.tsx": [
    { label: "Destination", fields: () => as(destinationSpec(noop).fields) },
  ],
  "features/integrations/git-providers/providers.ts": PROVIDERS.map(
    (provider) => ({
      label: `Git provider (${provider.label})`,
      fields: () => as(provider.fields),
    }),
  ),
  "features/integrations/notifications/channels.ts": CHANNELS.map(
    (channel) => ({
      label: `Notification channel (${channel.label})`,
      fields: () => as(channel.fields),
    }),
  ),
  "features/integrations/registries/registries-spec.tsx": [
    { label: "Registry", fields: () => as(registrySpec(noop).fields) },
  ],
  "features/service-health/uptime-check-spec.tsx": [
    {
      label: "Uptime check",
      fields: () =>
        as(
          uptimeCheckSpec({
            serviceType: "application",
            serviceId: "app",
            domains: [],
            domainsPending: false,
            publishedPortsPending: false,
            create: noop,
            update: noop,
            remove: noop,
          }).fields,
        ),
    },
  ],
  "features/application/create/create-ai-model-modal.tsx": {
    inline:
      "`hfToken`, the vLLM AI model's Hugging Face token, on the default `new-password`; `create-ai-model-modal.test.tsx` asserts it.",
  },
  "features/database/existing/existing-database-card.tsx": {
    inline:
      "`databasePassword`, an Existing database's login, on the default `new-password`: it is the database's, never the operator's sign-in.",
  },
  "features/database/existing/existing-cache-card.tsx": {
    inline:
      "`authToken`, an Existing cache's AUTH token, on the default `new-password`: it is the cache's, never the operator's sign-in.",
  },
  "features/application/model/model-hf-token-card.tsx": {
    inline:
      "`hfToken`, the Model tab's Hugging Face token, on the default `new-password`; `model-hf-token-card.test.tsx` asserts it.",
  },
  "features/settings/account/profile-card.tsx": {
    inline:
      "`currentPassword`, which really is the sign-in password and declares `current-password`; `profile-card.test.tsx` asserts it.",
  },
};

function Harness({ fields }: { fields: FieldSpec<FieldValues>[] }) {
  const form = useForm<FieldValues>();
  return (
    <FormProvider {...form}>
      <form>
        {fields.map((field) => (
          // Shown whatever the form holds: a stored header value hides its
          // box, and the census is about the box, not the rule.
          <ResourceField
            key={field.name}
            spec={{ ...field, when: undefined }}
            values={{} as FieldValues}
          />
        ))}
      </form>
    </FormProvider>
  );
}

describe('every kind: "password" field in the console', () => {
  const forms = Object.entries(CENSUS).flatMap(([file, entry]) =>
    Array.isArray(entry) ? entry.map((form) => ({ file, form })) : [],
  );
  // Only the producers that declare one: a channel whose only field is a
  // topic has nothing to hold here.
  const driven = forms
    .map(({ file, form }) => ({
      file,
      label: form.label,
      secrets: form.fields().filter((field) => field.kind === "password"),
    }))
    .filter(({ secrets }) => secrets.length > 0);

  it("has a password field in every module it drives", () => {
    const files = new Set(driven.map(({ file }) => file));
    const drivenModules = Object.entries(CENSUS)
      .filter(([, entry]) => Array.isArray(entry))
      .map(([file]) => file);
    expect([...files].sort()).toEqual(drivenModules.sort());
  });

  it.each(driven.map((entry) => [`${entry.label} (${entry.file})`, entry] as const))(
    '%s renders each secret with autocomplete="new-password" or the token its spec declares',
    (_, { secrets }) => {
      render(<Harness fields={secrets} />);
      for (const field of secrets) {
        const box = document.querySelector(`input[name="${field.name}"]`);
        if (!box) throw new Error(`${field.name} is not on screen`);
        const declared =
          field.kind === "password" ? field.autoComplete : undefined;
        // `off` is the token Chrome ignores on a password input, so a spec
        // declaring it is the bug again.
        expect(declared).not.toBe("off");
        expect({
          [field.name]: box.getAttribute("autocomplete"),
        }).toEqual({ [field.name]: declared ?? "new-password" });
      }
    },
  );

  it("names every file in src that declares one, and nothing that no longer does", () => {
    const src = join(process.cwd(), "src");
    const declaring: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          /kind:\s*"password"/.test(withoutComments(readFileSync(path, "utf8")))
        ) {
          declaring.push(relative(src, path));
        }
      }
    };
    walk(src);

    // `form-spec.ts` declares the type every one of these is an instance of.
    const expected = [...Object.keys(CENSUS), "components/console/form-spec.ts"];
    expect(declaring.sort()).toEqual(expected.sort());
  });
});

/** A comment saying `kind: "password"` declares nothing. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
