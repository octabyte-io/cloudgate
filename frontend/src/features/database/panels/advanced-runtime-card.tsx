import { z } from "zod";

import { example, type FieldSpec } from "@/components/console/form-spec";
import { SettingsCard } from "@/components/console/settings-card";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { usePermission } from "@/lib/auth/use-permission";

import { DATABASE_KIND } from "../kinds";
import {
  DATABASE_UPDATE_REFUSAL,
  type useUpdateDatabase,
} from "../use-database";

const runtimeSchema = z.object({
  command: z.string().trim(),
  args: z.string(),
});

type RuntimeValues = z.infer<typeof runtimeSchema>;

/**
 * What the container runs, if not what the image says.
 *
 * **The run command warning is not the Application's warning.** For an
 * Application, replacing the entrypoint means the process starts differently.
 * For three of these six engines the entrypoint is *how the credentials get
 * applied* — Redis's is a `redis-server --requirepass` wrapper, LibSQL's is the
 * sqld launcher, Mongo's is a replica-set bootstrap script — and for the other
 * three it is the image's own, which drops root and initialises the data
 * directory. Every engine's answer is said on the card, from the descriptor,
 * because a person cannot be expected to know which engine is which.
 *
 * **No Command placeholder, on any engine.** It was
 * `postgres -c max_connections=200`, shown on all six, and on the official
 * image that command runs as root and refuses to start; the Arguments
 * placeholder already carried the working shape. An engine-specific example
 * was rejected for the same reason the descriptor exists: an example is what
 * gets typed, and on four of the six engines a Command is the wrong field.
 */
export function RuntimeCard({
  row,
  kind,
  update,
}: {
  row: Database;
  kind: DatabaseKind;
  update: ReturnType<typeof useUpdateDatabase>;
}) {
  // `PATCH /<engine>/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const descriptor = DATABASE_KIND[kind];

  // What these two fields will actually do for this engine, from the
  // descriptor. Four answers, each said below — see `entrypoint` in
  // `kinds.ts`.
  const entrypoint = descriptor.entrypoint(row);
  const launcher = descriptor.launcher;

  const runtimeFields = (values: RuntimeValues): FieldSpec<RuntimeValues>[] => [
    {
      kind: "text",
      name: "command",
      label: "Command",
      optional: true,
      mono: true,
      hint:
        // Beside the field and as it is typed, so it is on screen at the save.
        // A warning rather than a refusal: see `launcher` in `kinds.ts`.
        launcher &&
        values.command.trim() !== "" &&
        !launcher.listens(values.command) ? (
          <span className="text-bad">
            This command does not listen on {launcher.address}, so nothing
            outside the container will reach the database after the next
            deploy. Include <code className="font-mono">--http-listen-addr{" "}
            {launcher.address}</code>, or leave Command empty.
          </span>
        ) : (
          "Replaces the image's entrypoint. Split on spaces and run directly — there is no shell, so a pipe or && would be passed as an argument."
        ),
    },
    {
      kind: "textarea",
      name: "args",
      label: "Arguments",
      optional: true,
      mono: true,
      rows: 4,
      // An example, never a value set: one argument per line.
      placeholder: `${example("-c")}\nmax_connections=200`,
      hint: "One per line. These replace the image's default arguments and are not split further — a value with a space in it belongs on one line.",
    },
  ];

  return (
    <SettingsCard
      title="Run command"
      gate={{ allowed: canSave.allowed, refusal: DATABASE_UPDATE_REFUSAL }}
      lede="What the container runs, if not what the image says."
      schema={runtimeSchema}
      fields={runtimeFields}
      savedMessage="Run command saved."
      defaultValues={{
        command: row.command ?? "",
        args: (row.args ?? []).join("\n"),
      }}
      submit={(values) =>
        update.mutateAsync({
          command: values.command === "" ? null : values.command,
          args: toLines(values.args),
        })
      }
      footer="Both take effect on the next deploy."
    >
      {entrypoint === "row" ? (
        // The image's own entrypoint is what makes these engines start at all:
        // measured on postgres:18, a Command of `postgres` exits with
        // "must be started under an unprivileged user ID".
        <p className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-meta text-tx-2">
          To pass flags to {descriptor.label},{" "}
          <strong>leave Command empty and put engine flags in Arguments</strong>
          , one per line. A Command replaces the image&apos;s entrypoint, which
          is the part that drops privileges and initialises the data directory
          on first start — without it the engine starts as root, or against an
          uninitialised directory, and does not start at all.
        </p>
      ) : entrypoint === "replaces-launcher" && launcher ? (
        // `LibsqlService.containerCommand`: `row.command ?? DEFAULT_SQLD_COMMAND`,
        // and only the namespaces flag appended. It used to say "saved and then
        // ignored", and a Command of `sqld` left sqld on 127.0.0.1.
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx-2">
          <strong className="text-bad">
            A Command replaces the whole sqld invocation Cloudgate generates.
          </strong>{" "}
          Left empty, {descriptor.label} starts as{" "}
          <code className="font-mono">{launcher.command}</code>. A Command of
          your own has to carry those listen addresses and the database path
          itself — without{" "}
          <code className="font-mono">--http-listen-addr {launcher.address}</code>{" "}
          sqld listens only inside the container and the database becomes
          unreachable. Arguments are ignored.
        </p>
      ) : entrypoint === "generated" ? (
        // `MongoService.replicaSetStartupScript` runs `command` in the
        // background once the replica set is initiated and always ends waiting
        // on mongod: `args` is read by nothing, and `command` is honoured
        // — the card said both were ignored.
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx-2">
          {descriptor.label} is started by a bootstrap script Cloudgate
          generates from the settings on the Credentials tab.{" "}
          <strong>Arguments are ignored.</strong>{" "}
          {"A Command runs in the background once the replica set is initiated, beside the server: the container still stops when the server exits, and a Stop does not wait on the Command."}
        </p>
      ) : entrypoint === "password-wrapper" ? (
        // Redis's requirepass wrapper is only applied when neither column is
        // set (`RedisService.containerCommand`), so setting one silently turns
        // the password off. This is the sharpest footgun in the phase.
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx-2">
          <strong className="text-bad">
            Setting either of these turns the password off.
          </strong>{" "}
          {descriptor.label} has no password setting of its own — Cloudgate
          enforces it by starting the container with a{" "}
          <code className="font-mono">--requirepass</code> entrypoint, and that
          entrypoint is only used when both of these are empty. A command here
          replaces it, and the result is an unauthenticated server. If you need
          a custom command, put the password back into it yourself.
        </p>
      ) : null}
    </SettingsCard>
  );
}

/**
 * Lines, minus the empty ones — `null` rather than `[]` when there is nothing,
 * because the column is a nullable array and the spec builder tests
 * `args && args.length > 0`.
 */
function toLines(value: string): string[] | null {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? lines : null;
}
