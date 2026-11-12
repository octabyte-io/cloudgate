import { LinkButton } from "@/components/console/link-button";

/**
 * The way out of a terminal auth state, as a link that looks like the one action
 * on the screen.
 *
 * The full-width primary shape is the whole of what this adds: an auth screen's
 * one action fills its column (`auth-panel`), which is not how a console action
 * behaves. Everything else it needs — being a real link rather than a button, and
 * the choice between a client navigation and a document load — is `LinkButton`'s, since F07
 * needed the same thing for the console and the reasoning is not auth's.
 *
 * `reload` matters here more than anywhere: accepting an invitation moves the
 * active Organization on the backend, so the console must be rendered against
 * that rather than against the session this tab loaded with.
 */
export function AuthAction({
  href,
  reload,
  children,
}: {
  href: string;
  reload?: boolean;
  children: React.ReactNode;
}) {
  return (
    <LinkButton href={href} reload={reload} variant="pri" className="w-full">
      {children}
    </LinkButton>
  );
}
