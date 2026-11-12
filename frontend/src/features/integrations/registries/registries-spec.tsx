import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import type { Column } from "@/components/console/data-table";
import type { ResourceSpec } from "@/components/console/resource-spec";
import { registriesApi, type Registry } from "@/lib/api/endpoints/registries";
import { redactSecrets } from "@/lib/format/redact";
import { example } from "@/components/console/form-spec";
import {
  probeServerBlocked,
  probeServerField,
  type ProbeFrom,
} from "@/lib/forms/probe-server-picker";

/**
 * A container registry, as a `ResourceSpec`.
 *
 * Three things here are decided by the backend rather than by taste:
 *
 * 1. **`url` is a hostname, never a URL.** `registryUrlSchema` refuses a scheme
 *    and refuses shell metacharacters, because the value is interpolated into a
 *    `docker login` argument. So the field says "hostname" and the hint gives
 *    the two shapes that pass, rather than letting someone paste
 *    `https://registry.example.com/` and read a regex back.
 * 2. **Empty `url` means Docker Hub.** The column defaults to `''` and
 *    `registry.utils.ts` reads that as the default registry, so a blank field is
 *    a real answer and the placeholder says so instead of looking unfinished.
 * 3. **The password never comes back**, so the edit form starts with it empty
 *    and a `PATCH` that omits it keeps the stored one.
 *
 * **The test is the push's own login, asked early**
 * A wrong
 * password used to save as "Registry saved." and fail at the push, after a whole
 * build. `spec.test` runs `docker login` against the hostname, and what it
 * reports on a refusal is the registry's own sentence — a 401, a refused
 * connection and an unknown host read as three different answers. Two routes
 * behind the one button, decided by the password box, exactly as on
 * Destinations: typed in, the values on screen are tested; left empty on an
 * edit, the registry is tested as it is saved.
 *
 * And one thing decided by the absence of a backend reader: **there is no Kind
 * field**. The form
 * used to make "Hosted by someone else" / "One you run" a required choice and
 * `registry_type` still holds the answer, but nothing has ever read it — not the
 * deployment engine, not `registry.utils.ts`, not this table. What actually
 * decides how Cloudgate reaches a registry is the hostname below: empty is Docker
 * Hub, anything else is the host `docker login` is given. Asking a question whose
 * answer changes nothing is worse than not asking it, so the column stays,
 * defaulted to `cloud`, and the dialog no longer offers it. A reader that one day
 * needs the distinction should bring the field back *with* the behaviour.
 */

const schema = z.object({
  /**
   * Which saved registry this form is editing, or `""` on an add. Not a
   * control — no `FieldSpec` names it — but `test.run` is handed the values and
   * nothing else, and "is there a saved row to test?" is the fact it turns on.
   */
  registryId: z.string(),
  name: z.string().min(1, "A registry needs a name."),
  url: z
    .string()
    .refine(
      (value) =>
        value === "" ||
        /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(:\d{1,5})?$/.test(value),
      "Give a hostname, optionally with a port — no https:// and no path.",
    ),
  imagePrefix: z.string(),
  username: z.string().min(1, "A registry needs a username."),
  password: z.string(),
  /**
   * The Server `docker login` runs from — only asked on the Hosted instance
   * `""` everywhere else (this Cloudgate host). Never saved.
   */
  serverId: z.string(),
});

export type RegistryValues = z.infer<typeof schema>;

export const registryColumns: Column<Registry>[] = [
  {
    id: "name",
    head: "Name",
    tone: "key",
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (row) => row.name,
  },
  {
    id: "url",
    head: "Registry",
    cell: (row) =>
      row.url ? (
        <span className="font-mono text-meta">{row.url}</span>
      ) : (
        // Not a `Dash`: the empty column is a real answer, not a missing one.
        <span className="text-tx-2">Docker Hub</span>
      ),
  },
  {
    id: "username",
    head: "Username",
    tone: "muted",
    cell: (row) => row.username,
  },
  {
    id: "imagePrefix",
    head: "Image prefix",
    cell: (row) =>
      row.imagePrefix ? (
        <Chip variant="mono">{row.imagePrefix}</Chip>
      ) : (
        <Dash word="None" />
      ),
  },
];

export function registrySpec(
  onDone: () => Promise<unknown>,
  /** The Hosted instance's probe-from picker; `null` asks nothing. */
  probeFrom: ProbeFrom | null = null,
): ResourceSpec<Registry, RegistryValues> {
  return {
    noun: "registry",
    plural: "registries",
    title: "Registries",
    lede: "A registry is where a build pushes the image it made, and where the deploy target pulls it from.",
    icon: "box",
    addLabel: "Connect a registry",
    emptyTitle: "No registries yet",
    emptyBody:
      "Connect one to push built images somewhere other than the machine that built them — which is what makes a build on one Server deployable on another.",
    tableLabel: "Connected registries",

    columns: registryColumns,
    getRowId: (row) => row.registryId,
    rowName: (row) => row.name,
    defaultSort: { id: "name", dir: "asc" },

    schema,
    fields: [
      {
        name: "name",
        label: "Name",
        kind: "text",
        placeholder: example("Production images"),
        hint: "What this connection is called in Cloudgate. Only you see it.",
      },
      {
        name: "url",
        label: "Hostname",
        kind: "text",
        mono: true,
        optional: true,
        placeholder: "registry.example.com",
        hint: "A hostname, optionally with a port. Leave it empty for Docker Hub.",
      },
      {
        name: "imagePrefix",
        label: "Image prefix",
        kind: "text",
        mono: true,
        optional: true,
        placeholder: example("acme"),
        hint: "Put in front of the image name — an organization or a namespace.",
      },
      {
        name: "username",
        label: "Username",
        kind: "text",
        // AWS ECR really does want the literal string "AWS", which is why the
        // backend trims but does not lower-case this.
        hint: "Kept exactly as you type it. AWS ECR wants the literal AWS.",
      },
      {
        name: "password",
        label: "Password or access token",
        kind: "password",
        hint: "Stored encrypted and never shown again. Leave it empty when editing to keep the one already saved — a test then logs in with the stored one.",
      },
      ...(probeFrom ? [probeServerField<RegistryValues>(probeFrom)] : []),
    ],

    toDefaults: (row) => ({
      registryId: row?.registryId ?? "",
      name: row?.name ?? "",
      url: row?.url ?? "",
      imagePrefix: row?.imagePrefix ?? "",
      username: row?.username ?? "",
      password: "",
      serverId: "",
    }),

    secrets: [{ name: "password", label: "the password", required: true }],
    test: {
      label: "Test connection",
      blocked: (values) => {
        if (!values.registryId && !values.password) {
          return "Fill in the password and the test logs in with it. Nothing is saved yet, so there is nothing else to log in with.";
        }
        if (values.password && !values.username.trim()) {
          return "Fill in the username the password belongs to.";
        }
        return probeServerBlocked(probeFrom, values);
      },
      run: async (values) => {
        if (values.password) {
          await registriesApi.testConnection({
            url: values.url,
            username: values.username,
            password: values.password,
            ...(values.serverId ? { serverId: values.serverId } : {}),
          });
          return `${values.url || "Docker Hub"} accepted ${values.username.trim()} with the password you typed.`;
        }
        // The saved row is what logs in — its hostname and username too, not
        // the ones on screen. Said in the answer, where it can be believed.
        await (values.serverId
          ? registriesApi.testSavedConnection(
              values.registryId,
              values.serverId,
            )
          : registriesApi.testSavedConnection(values.registryId));
        return "The registry accepted this login as it is saved. Anything changed in this dialog was not part of that — save it, or type the password in to test these values instead.";
      },
      // Nothing the backend answers should hold the password — it reaches
      // `docker login` on stdin and never a command line, and the route
      // masks it too. This is the last pass before a shared screen.
      redact: (message, values) => redactSecrets(message, [values.password]),
    },

    // What `/registries` asks of each write. The edit is `registry: ['create']`
    // too: that is what its `PATCH` names, and there is no `update` to ask for.
    permissions: {
      create: { registry: ["create"] },
      update: { registry: ["create"] },
      remove: { registry: ["delete"] },
    },
    create: async (values) => {
      await registriesApi.create({
        name: values.name,
        url: values.url,
        // An empty optional is `undefined` when creating and `null` when
        // updating — F10's rule, and `imagePrefix` is `nullish()` on both.
        imagePrefix: values.imagePrefix || undefined,
        username: values.username,
        password: values.password,
      });
      await onDone();
    },

    update: async (row, values) => {
      await registriesApi.update(row.registryId, {
        name: values.name,
        url: values.url,
        imagePrefix: values.imagePrefix || null,
        username: values.username,
        // Omitted rather than sent empty: a `PATCH` that does not mention the
        // column leaves it exactly as it was, which is what "leave it blank to
        // keep the saved one" has to mean.
        ...(values.password ? { password: values.password } : {}),
      });
      await onDone();
    },

    remove: async (row) => {
      await registriesApi.remove(row.registryId);
      await onDone();
    },

    deleteNote: (row) => (
      <>
        Any Application pushing to <strong className="font-medium text-tx">{row.name}</strong>{" "}
        loses it — the column is cleared rather than the build refused, so the
        next Deployment builds the image and leaves it on the machine that built
        it. Nothing already pushed to the registry is touched.
      </>
    ),
  };
}
