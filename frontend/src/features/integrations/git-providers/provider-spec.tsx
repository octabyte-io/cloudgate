import { z } from "zod";

import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import type { ResourceSpec } from "@/components/console/resource-spec";
import {
  connectionId,
  gitProvidersApi,
  type GitConnection,
  type GitProviderKind,
} from "@/lib/api/endpoints/git-providers";
import { timeExact } from "@/lib/format/time";

import { authorizes, AuthorizeConnection } from "./authorize-connection";
import { providerOf, type ProviderValues } from "./providers";

/**
 * One provider kind's connections, as a `ResourceSpec`.
 *
 * The two shapes of id are the thing to get right and the reason this is not
 * four copies: **create, update and the two reads take the strategy row's id;
 * delete takes the base row's**, because no strategy controller has a `DELETE`
 * at all. Written once here, correct for all four.
 */

export function providerColumns(
  kind: GitProviderKind,
): Column<GitConnection>[] {
  const descriptor = providerOf(kind);
  return [
    {
      id: "name",
      head: "Name",
      tone: "key",
      compare: (a, b) =>
        (a.gitProvider?.name ?? "").localeCompare(b.gitProvider?.name ?? ""),
      cell: (row) => row.gitProvider?.name ?? "",
    },
    {
      id: "identity",
      head: "Reaches",
      tone: "wrap",
      cell: (row) => (
        <span className="font-mono text-meta">{descriptor.summary(row)}</span>
      ),
    },
    // **There is no readiness column, and its absence is deliberate.**
    // A "Can clone" column is the obvious thing to want and this screen cannot
    // know it: the credentials that decide it are exactly the ones `sanitize()`
    // strips on the way out. Reporting on the non-secret columns instead was
    // tried and dropped — it guesses at the answer from the half of the row
    // that does not determine it.
    // An incomplete connection *is* in this table (the four listings no longer
    // filter on those columns), so such a column would now have rows to mark.
    // It still should not: what it would be marking is a guess. The honest
    // version of this is `descriptor.requirement`, said in the form before the
    // save, where it can still change what someone types.
    //
    // **`expiresAt` is the one exception, and only for the two providers whose
    // grant it describes**.
    // It is not a guess and not a secret: it is a plain integer column that
    // *only* the OAuth callback writes, so it says exactly one true thing —
    // whether this connection has ever completed the handshake. It once
    // was null on every row, which is why no column here reported it.
    ...(authorizes(kind)
      ? [
          {
            id: "grant",
            head: "Grant",
            compare: (a: GitConnection, b: GitConnection) =>
              (a.expiresAt ?? 0) - (b.expiresAt ?? 0),
            cell: (row: GitConnection) => <GrantCell connection={row} />,
          } satisfies Column<GitConnection>,
        ]
      : []),
  ];
}

/**
 * Which of the three states a grant is in.
 *
 * Module scope, not the component body, for the same reason `lib/format/time.ts`
 * puts its clock reads there: `react-hooks/purity` refuses a `Date.now()` in
 * render, and it is right to — a component that re-renders would silently change
 * its own answer.
 */
function grantState(
  expiresAt: number | null | undefined,
): "none" | "live" | "expired" {
  if (!expiresAt) return "none";
  return expiresAt * 1000 > Date.now() ? "live" : "expired";
}

/**
 * What the connection's `expiresAt` says about its OAuth grant. The three states
 * are genuinely different outcomes, and the difference matters most for GitLab: an
 * *expired* grant is refreshed automatically on the next call, while *never
 * authorized* is the state in which every call refuses.
 */
function GrantCell({ connection }: { connection: GitConnection }) {
  const state = grantState(connection.expiresAt);
  if (state === "none") {
    return <Chip>Not authorized</Chip>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Chip variant="brand">
        {state === "expired" ? "Refreshes on use" : "Authorized"}
      </Chip>
      <span className="text-meta text-tx-3">
        {state === "expired" ? "expired" : "until"}{" "}
        {timeExact(new Date((connection.expiresAt ?? 0) * 1000).toISOString())}
      </span>
    </span>
  );
}

export function providerSpec(
  kind: GitProviderKind,
  onDone: () => Promise<unknown>,
): ResourceSpec<GitConnection, ProviderValues> {
  const descriptor = providerOf(kind);

  const schema = z.object({
    name: z.string().min(1, "A connection needs a name."),
    ...descriptor.shape,
  }) as unknown as ResourceSpec<GitConnection, ProviderValues>["schema"];

  return {
    noun: "connection",
    plural: "connections",
    title: descriptor.label,
    lede: descriptor.blurb,
    icon: descriptor.icon,
    addLabel: `Connect ${descriptor.label}`,
    emptyTitle: `No ${descriptor.label} accounts yet`,
    emptyBody:
      "Connect one and its repositories become selectable as an Application's source.",
    tableLabel: `${descriptor.label} connections`,

    columns: providerColumns(kind),
    getRowId: (row) => connectionId(kind, row),
    rowName: (row) => row.gitProvider?.name ?? descriptor.label,
    defaultSort: { id: "name", dir: "asc" },

    schema,
    fields: [
      // **Said before the save, not after it.** An
      // incomplete connection is listed and can be opened and completed, so what is
      // missing costs the clone rather than the row — but the moment to say so is still
      // while the form is open, not when a repository list comes back empty.
      ...(descriptor.requirement
        ? [
            {
              name: "__requirement" as const,
              label: `Before Cloudgate can clone from ${descriptor.label}`,
              kind: "section" as const,
              hint: `This connection needs ${descriptor.requirement}.`,
            },
          ]
        : []),
      ...descriptor.fields,
    ],

    toDefaults: (row) =>
      ({
        name: row?.gitProvider?.name ?? "",
        ...descriptor.toDefaults(row),
      }) as ProviderValues,

    // What each write asks for: `POST` and `PATCH /<kind>` name
    // `gitProviders: ['create']` — there is no `update` — and the delete is
    // `DELETE /git-providers/:id`.
    permissions: {
      create: { gitProviders: ["create"] },
      update: { gitProviders: ["create"] },
      remove: { gitProviders: ["delete"] },
    },
    create: async (values) => {
      await gitProvidersApi.create(kind, {
        name: values.name,
        ...descriptor.toBody(values),
      });
      await onDone();
    },

    update: async (row, values) => {
      await gitProvidersApi.update(kind, connectionId(kind, row), {
        name: values.name,
        ...descriptor.toBody(values),
      });
      await onDone();
    },

    // The one asymmetry, and the brief's endpoint audit asked about it: the
    // base row's id, not the strategy row's.
    remove: async (row) => {
      await gitProvidersApi.remove(row.gitProviderId);
      await onDone();
    },

    // **Authorizing is a row control, not a form control**. What it acts on
    // is a *saved* connection — the OAuth application's client ID and secret have
    // to be stored before there is anything to authorize — and it navigates away
    // rather than opening anything, so it has none of `RepositoryCheck`'s reason
    // to stay out of a table cell.
    rowExtras: authorizes(kind)
      ? (row) => <AuthorizeConnection kind={kind} connection={row} />
      : undefined,

    deleteNote: (row) => (
      <>
        Any Application whose source is{" "}
        <strong className="font-medium text-tx">
          {row.gitProvider?.name ?? descriptor.label}
        </strong>{" "}
        stops being able to clone, and its next Deployment fails. Nothing at{" "}
        {descriptor.label} is changed — this deletes the credentials Cloudgate
        holds.
      </>
    ),
  };
}
