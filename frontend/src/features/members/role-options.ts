import type { PickerOption } from "@/components/console/picker";
import type { CustomRole } from "@/lib/api/endpoints/roles";

/**
 * The roles a person can be put on, as the Role picker lists them — shared by
 * **Change role** and **Invite someone**
 * which used to
 * disagree: the invite dialog offered Member and Admin only, so the one way
 * onto a custom role was to join as Member and be moved afterwards, holding
 * Member's grant in between.
 *
 * The built-ins come first and the Organization's custom roles after them,
 * each marked with how many people hold it — which is what sets them apart as
 * a group in a list with no headings. Owner is never offered: it is
 * non-delegable, and both routes refuse it.
 *
 * `licensed === false` withholds the custom roles, because both routes refuse
 * assigning one without a valid licence — offering it would be offering
 * a guaranteed 403. `RoleLicenceNotices` says so beside the picker. The one
 * exception is `heldRole`: a member already sitting on a custom role keeps it
 * in the list, or the picker would show no option matching its own value.
 * `undefined` — the licence read in flight or failed — withholds nothing,
 * because an unanswered question is not "unlicensed".
 */
export function roleOptions({
  custom,
  licensed,
  heldRole,
}: {
  custom: readonly CustomRole[];
  /** `undefined` while the licence read is in flight or has failed. */
  licensed: boolean | undefined;
  /** The role the person holds now, when there is a person yet. */
  heldRole?: string;
}): PickerOption[] {
  const offered =
    licensed === false
      ? custom.filter((entry) => entry.role === heldRole)
      : custom;
  return [
    { value: "member", label: "Member" },
    { value: "admin", label: "Admin" },
    ...offered.map((entry) => ({
      value: entry.role,
      label: entry.role,
      detail: `${entry.memberCount} ${entry.memberCount === 1 ? "member" : "members"}`,
    })),
  ];
}
