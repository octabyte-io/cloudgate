import { ErrorPageCopy } from "@/components/console/error-page-copy";
import { LinkButton } from "@/components/console/link-button";
import { Outcome } from "@/components/console/outcome";

/**
 * A console address that names nothing — **inside the shell**, which is the whole
 * point of it living here rather than only at the app root.
 *
 * Every `notFound()` thrown under `(console)` lands on this: an invented tab, a
 * database engine we do not have, a mistyped path. Whoever hits it is signed in
 * and mid-task, so they get the masthead, their rail and their way out, not a
 * bare page that looks like the app has fallen over. That includes an address
 * that matches no route at all, which `(console)/[...missing]` turns into a
 * `notFound()` here. The root `app/not-found.tsx` is left for a
 * `notFound()` outside the console, where there may be no session to render a
 * shell around.
 *
 * This one paints on hydration rather than in the HTML, and always did:
 * `notFound()` is caught by a client boundary and React does not run those
 * during SSR. What changed when `loading.tsx` was deleted is that the response
 * carrying it is a real 404 now — `layout.tsx` has the whole of that argument.
 */
export default function NotFound() {
  return (
    <Outcome
      tone="info"
      icon="search"
      title="That page is not here."
      action={
        <LinkButton href="/" variant="pri">
          Go to Organization home
        </LinkButton>
      }
    >
      <ErrorPageCopy kind="notFound">
        The address may be mistyped, or it may name something this Organization
        does not have. Everything you can reach is in the rail beside this.
      </ErrorPageCopy>
    </Outcome>
  );
}
