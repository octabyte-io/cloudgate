import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

import { DATABASE_KIND } from "../kinds";

/**
 * When a credential saved on the Credentials card reaches the engine — said
 * above the fields, because it is the most expensive misunderstanding on the
 * tab, and read from the descriptor's `credentials` because the answer is two
 * different things.
 *
 * **What was wrong first.** This was one static paragraph telling all six
 * engines they read their credentials *"only on first start"*, and its own
 * comment gave the reason — *every one of these images only reads them when
 * its data directory is empty*. That is true of four. A Redis password is the
 * `--requirepass` of every start, and LibSQL's basic auth is `SQLD_HTTP_AUTH`,
 * read by sqld on every start; on both, a saved value replaces the old one at
 * the next deploy on the same data, so *"change it in the engine as well"*
 * sent the operator to do work the next deploy undoes.
 *
 * The Redis sentence about the Run command comes from `entrypoint`, not from a
 * third `credentials` answer: the wrapper that applies the password is the
 * same one the Run command card already says a Command turns off, and saying
 * so here in one clause keeps the two cards from disagreeing.
 */
export function CredentialsNotice({
  row,
  kind,
}: {
  row: Database;
  kind: DatabaseKind;
}) {
  const descriptor = DATABASE_KIND[kind];

  if (descriptor.credentials === "every-deploy") {
    return (
      <p className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-meta text-tx-2">
        {descriptor.label}{" "}
        reads these from the container&apos;s environment on every start, so a
        saved change{" "}
        <strong>applies at the next deploy</strong>, on the same data — the old
        value stops working then, and anything connecting with it needs the
        new one.
        {descriptor.entrypoint(row) === "password-wrapper" ? (
          <>
            {" "}
            That holds while the Advanced tab&apos;s Run command is empty: the
            password is enforced by the start command Cloudgate generates, and a
            Run command of your own replaces it.
          </>
        ) : null}
      </p>
    );
  }

  // The image's entrypoint reads the environment only against an empty data
  // directory, so changing a value here changes what Cloudgate believes and
  // what the next deploy puts in the environment — and not what the running
  // engine will accept.
  return (
    <p className="rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx-2">
      These are handed to the container as environment variables, and{" "}
      {descriptor.label} reads them <strong>only on first start</strong>,
      against an empty data directory. On a database that already holds data,
      changing a value here updates what Cloudgate shows and hands to the next
      deploy — it does not change the credential inside the engine. To actually
      rotate one, change it in the engine as well; to start over from these
      values, rebuild, which deletes the data.
    </p>
  );
}
