// No `"use client"`: a leaf, rendered only inside the Agents section's
// dialogs, whose importer is already inside the boundary.

/**
 * The spec's sentence for the access step, shown whatever is ticked: the mask
 * covers what Cloudgate stores, and a Deployment log is text a build printed,
 * so an Agent granted a Service can read whatever that build echoed. Said
 * before the grant is made, not discovered after.
 *
 * The wording is the spec's verbatim, which is why it says "build and run
 * logs" rather than the glossary's term: it is a quotation, pinned by
 * `create-agent-modal.test.tsx`.
 */
export const LOG_MASK_NOTICE =
  "This Agent can read the build and run logs of what you grant. Cloudgate masks the secrets it stores, not what a build prints.";

/**
 * {@link LOG_MASK_NOTICE} in its warning box — one component, because the
 * create dialog's access step and Manage access both show it, and a grant
 * made later is as exposed as the first.
 */
export function LogMaskNotice() {
  return (
    <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
      {LOG_MASK_NOTICE}
    </p>
  );
}
