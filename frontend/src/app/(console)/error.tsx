"use client";

import { Button } from "@/components/ui/button";
import { ErrorPageCopy } from "@/components/console/error-page-copy";
import { Outcome } from "@/components/console/outcome";
import { useScope } from "@/components/shell/scope-provider";

/**
 * A console screen that threw while rendering.
 *
 * **One boundary, not one per scope**: it
 * sits directly under the console layout, so the masthead, the rail and ⌘K all
 * survive — someone whose Deployments tab crashed can still leave it — and the
 * words that *are* scope-specific come from `useScope()` rather than from which
 * folder the file is in.
 *
 * There is deliberately no sibling `loading.tsx` — it was deleted, because
 * a Suspense boundary above the tab registry's check flushed the shell, and with
 * it a 200, before any `notFound()` could set a status. See `layout.tsx`.
 *
 * `unstable_retry` and not `reset`: retry re-fetches and re-renders the segment,
 * which is what a transient failure needs. `reset` only clears the error state
 * and re-renders the same inputs, so it is the right call in the narrow case
 * where nothing needs re-fetching — not here
 * (`03-file-conventions/error.md`).
 *
 * It does not log: the docs' example ships the error to a reporting service and
 * this app has none, so a `console.error` here would only add noise to the one
 * place a defect shows up honestly — the browser console, which every phase is
 * required to leave clean.
 *
 * **It does not say "Nothing was changed"**, which it used to
 * A render
 * failure changes nothing by itself, but it can follow a mutation that was
 * already accepted — a Deploy whose live log then threw — and the sentence told
 * that operator their deploy had not happened while it ran to completion.
 *
 * Never `error.message`. A Server Component's message is replaced with a generic
 * one in production, and a Client Component's is written for whoever reads the
 * stack. This screen says what happened and what to do about it.
 *
 * ## The one `"use client"` in `src` that still warns, and must
 *
 * An earlier change dropped the directive from every file that is not a
 * boundary. This file keeps it because an `error.tsx` *is* one — the framework
 * renders it directly, and the convention requires a Client Component. That
 * leaves the last 71007 ("props must be serializable… rename to
 * `unstable_retryAction`"), and it is a plugin false positive with no fix:
 * `unstable_retry` is Next's own prop name (`03-file-conventions/error.md`,
 * added in v16.2.0), so renaming it would simply stop the prop arriving. The
 * plugin's exemption list (`server/typescript/rules/client-boundary.js`) still
 * only knows the older `reset`, which it was never updated past.
 */
export default function ConsoleError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const { identity, scope } = useScope();
  const subject =
    scope.kind === "organization"
      ? "This screen"
      : identity
        ? `“${identity.name}”`
        : "This screen";

  return (
    <Outcome
      tone="bad"
      icon="alert"
      title={`${subject} could not be shown.`}
      action={
        <Button variant="pri" onClick={() => unstable_retry()}>
          Try again
        </Button>
      }
    >
      <ErrorPageCopy kind="serverError">
        Try again to reload this page. Anything you had already started, such
        as a deploy, keeps running.
      </ErrorPageCopy>
    </Outcome>
  );
}
