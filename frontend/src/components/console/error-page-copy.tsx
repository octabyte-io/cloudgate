"use client";

import { useBrandingOrDefault } from "@/lib/api/use-branding";

/**
 * An error page's sentence, as the operator worded it.
 *
 * `children` is the stock copy and stands whenever the branding says nothing,
 * so an unbranded instance reads exactly as before. `supportUrl` adds one
 * sentence rather than a button: the page's one action is already the way back
 * into the console, and a second button would compete with it.
 *
 * Inline content only — it renders inside `Outcome`'s `<p>`.
 */
export function ErrorPageCopy({
  kind,
  children,
}: {
  kind: "notFound" | "serverError";
  children: React.ReactNode;
}) {
  const { errorPages } = useBrandingOrDefault();
  const message =
    kind === "notFound"
      ? errorPages.notFoundMessage
      : errorPages.serverErrorMessage;

  return (
    <>
      {message ?? children}
      {errorPages.supportUrl ? (
        <>
          {" "}
          If you need a hand,{" "}
          <a
            href={errorPages.supportUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            contact support
          </a>
          .
        </>
      ) : null}
    </>
  );
}
