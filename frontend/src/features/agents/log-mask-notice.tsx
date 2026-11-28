// No `"use client"`: a leaf, rendered only inside the Agents section's
// dialogs, whose importer is already inside the boundary.

/**
 * The sentence for the access step, shown whatever is ticked: the mask covers
 * what Cloudgate stores, and a Deployment log is text a build printed, so an
 * Agent granted a Service can read whatever that build echoed. A Runtime log
 * is the app's own output, read only with Can read runtime logs on
 * (ADR-0095), and the mask catches even less of it. Said before the grant is
 * made, not discovered after.
 *
 * It names both logs by the glossary's terms, Deployment log and Runtime
 * log (CONTEXT.md avoids "Build log"); pinned by `create-agent-modal.test.tsx`.
 */
export const LOG_MASK_NOTICE =
  "This Agent can always read the Deployment logs of what you grant, and their Runtime logs only with Can read runtime logs on. Cloudgate masks the secrets it stores, not what a build or a running Service prints.";

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
