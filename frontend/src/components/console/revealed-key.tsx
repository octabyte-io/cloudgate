// No `"use client"`: a leaf, rendered only inside dialogs whose importers
// already carry it.

import { CopyButton } from "./copy-button";

/**
 * A secret shown once — a personal key at creation, and an Agent's key at
 * creation or Add key. Built inside `features/settings/account/` and
 * promoted here when the Agents section became its second
 * importer. `label` names which kind of key the copy button copies.
 */
export function RevealedKey({
  value,
  label = "Personal key",
}: {
  value: string;
  label?: string;
}) {
  return (
    <div className="rounded-lg border border-warn-line bg-warn-tint p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body font-medium text-tx">Copy this key now</p>
        <CopyButton value={value} label={label} />
      </div>
      <p className="mt-1 text-meta text-tx-2">
        Cloudgate stores a hash of it and cannot show it again. Closing this box
        is the last you will see of it.
      </p>
      <code className="mt-2.5 block rounded-md bg-panel px-2.5 py-2 font-mono text-ui wrap-anywhere text-tx">
        {value}
      </code>
    </div>
  );
}
