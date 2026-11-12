import { z } from "zod";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import type { FieldSpec } from "./resource-spec";
import { SettingsCard } from "@/components/console/settings-card";

/**
 * What the container runs, when the image's own entrypoint is not it.
 *
 * **Two fields because Docker has two**, and conflating them is the mistake this
 * card exists to prevent. `command` replaces the image's entrypoint and `args`
 * replaces its default arguments — `mechanize.ts`'s `buildServiceSettings`
 * splits the command on spaces into `Command` and passes the arguments through
 * as `Args`. An image whose entrypoint is right and whose arguments are wrong
 * needs only the second one, and typing the whole line into the first is how a
 * working entrypoint gets replaced by a broken copy of itself.
 *
 * The space split is worth saying out loud too: the command is **not** run
 * through a shell, so a pipe or a `&&` in it is an argument, not a pipeline.
 */

const schema = z.object({
  command: z.string().trim(),
  args: z.string(),
});

type Values = z.infer<typeof schema>;

const fields: FieldSpec<Values>[] = [
  {
    kind: "text",
    name: "command",
    label: "Command",
    optional: true,
    mono: true,
    placeholder: "node server.js",
    hint: "Replaces the image's entrypoint. Split on spaces and run directly — there is no shell, so a pipe or && would be passed as an argument.",
  },
  {
    kind: "textarea",
    name: "args",
    label: "Arguments",
    optional: true,
    mono: true,
    rows: 4,
    placeholder: "--port\n8080",
    hint: "One per line. These replace the image's default arguments, and are not split further — a value with a space in it belongs on one line.",
  },
];

export function RuntimeCard({
  application,
  save,
}: {
  application: ApplicationDetail;
  save: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  // `command` and `args` are config-owned: a repository-kept config's file
  // sets them.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );
  return (
    <SettingsCard
      title="Run command"
      gate={{
        allowed: canSave.allowed && lock === null,
        refusal:
          canSave.allowed && lock
            ? lockRefusal(lock)
            : APPLICATION_SETTINGS_REFUSAL,
      }}
      lede="What the container runs, if not what the image says."
      schema={schema}
      fields={fields}
      savedMessage="Run command saved."
      defaultValues={{
        command: application.command ?? "",
        args: (application.args ?? []).join("\n"),
      }}
      submit={(values) =>
        save({
          command: values.command === "" ? null : values.command,
          args: toLines(values.args),
        })
      }
      footer="Both take effect on the next Deployment."
    >
      {lock ? (
        <ConfigLockNote lock={lock} what="The command and arguments are" />
      ) : null}
    </SettingsCard>
  );
}

/**
 * Lines, minus the empty ones — but `null` rather than `[]` when there is
 * nothing, because the column is a nullable array and the engine tests
 * `args && args.length > 0`. An empty array and a null behave the same today;
 * writing the one the column was designed for keeps it that way.
 */
function toLines(value: string): string[] | null {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? lines : null;
}
