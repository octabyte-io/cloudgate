import type { Metadata } from "next";

import { AcceptInvitation } from "../../_components/accept-invitation";

export const metadata: Metadata = { title: "Invitation" };

/**
 * `params` is a **promise** in this version of Next, and `PageProps<'/route'>` is
 * the globally generated helper that types it from the route literal — both are
 * this version's conventions rather than choices
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`).
 *
 * The id in the URL is the invitation's own id: it is what
 * `POST /organizations/invitations/:id/accept` takes, and what the backend's
 * `assertSignUpAllowed` looks up when an invited person signs up carrying it in the
 * `x-cloudgate-token` header.
 */
export default async function AcceptInvitationPage(
  props: PageProps<"/accept-invitation/[id]">,
) {
  const { id } = await props.params;
  return <AcceptInvitation invitationId={id} />;
}
