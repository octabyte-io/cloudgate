import type { ReactNode } from "react";

import { Banner, BannerRow } from "@/components/console/banner";
import { useLicenseStatus } from "@/features/enterprise/use-license";

import { useCustomRoles } from "./use-members";

/**
 * How many members a lapsed licence has locked out, on both screens that can
 * answer for them.
 *
 * **One condition, one wording.** The Roles screen has said this for a
 * long time; the Members screen is where the people are, so it has to say it
 * too — and two differently-worded warnings about one fact is a worse outcome
 * than one, so the sentence lives here and both screens render it. They differ
 * only in where their button goes: from Roles you want the people, from Members
 * you want the roles.
 *
 * The count is `memberCount` summed over the Organization's custom roles, which
 * is the same arithmetic the backend's lapse check does with a `notInArray`
 * against the three static roles — so the number here and the number in the
 * warning the periodic check logs are the same number.
 *
 * **A licence nobody has answered about yet is not an absent licence.** Both
 * queries have to have landed before this renders anything: `licensed` is
 * `false` on an unanswered `useLicenseStatus`, and reading that as "no licence"
 * would flash "3 members are locked out" onto a perfectly licensed screen on
 * every cold load. Same rule the role picker follows.
 */
export function StrandedMembersBanner({ action }: { action?: ReactNode }) {
  const roles = useCustomRoles();
  const status = useLicenseStatus();

  if (!status.data || !roles.data || status.data.licensed) return null;

  const count = roles.data.reduce((sum, role) => sum + role.memberCount, 0);
  if (count === 0) return null;

  return (
    <Banner title="One thing needs attention">
      <BannerRow
        tone="bad"
        title={`${count} ${count === 1 ? "member is" : "members are"} locked out by a custom role`}
        description="Without a license, a member holding a custom role is refused every permission-checked action — including the ones their role grants, not only the licensed ones. Move them to Admin or Member, or activate a license."
        action={action}
      />
    </Banner>
  );
}
