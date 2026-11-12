import { LinkButton } from "@/components/console/link-button";
import {
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  acceptInvitationPath,
  withNext,
} from "@/lib/auth/routes";

import { AuthAction } from "./auth-action";
import { AuthFallback } from "./auth-fallback";
import { AuthPanel } from "./auth-panel";
import { InvitationNotOpen, useInvitationPreview } from "./invitation-preview";

/**
 * What a **signed-out** visitor gets: the two doors — once the link has been
 * checked.
 *
 * Before the public read this said "You have been invited" for any id at all,
 * because better-auth's `get-invitation` needs a session. `GET
 * /auth/invitations/:id` is Cloudgate's public read: a closed or unknown id is
 * refused here, before any form, and an open one names its Organization and the
 * address it was sent to — what the email holding the link already said, and
 * nothing for an id that is not open. A failed read is not a verdict, so it
 * falls back to the doors without the names.
 */
export function InvitationDoors({ invitationId }: { invitationId: string }) {
  const back = acceptInvitationPath(invitationId);
  const { ready, preview } = useInvitationPreview(invitationId);

  if (!ready) return <AuthFallback />;
  if (preview && !preview.open) return <InvitationNotOpen code={preview.code} />;
  const invited = preview?.open ? preview : null;

  return (
    <AuthPanel
      title="You have been invited"
      lede={
        invited
          ? `${invited.email} has been invited to ${invited.organizationName}. Sign in to accept it, or create an account with that address.`
          : "Sign in to accept it, or create an account with the address it was sent to."
      }
    >
      <div className="grid gap-2.5">
        <AuthAction href={withNext(SIGN_IN_PATH, back)}>
          Sign in to accept
        </AuthAction>
        <LinkButton
          variant="gh"
          className="w-full"
          href={`${SIGN_UP_PATH}?invitation=${encodeURIComponent(invitationId)}`}
        >
          Create an account
        </LinkButton>
        <p className="mt-1 text-meta text-tx-2">
          An invitation is for one email address. Use the one it was sent to, or it
          will be refused.
        </p>
      </div>
    </AuthPanel>
  );
}
