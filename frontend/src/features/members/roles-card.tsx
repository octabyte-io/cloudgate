import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Picker } from "@/components/console/picker";
import { Segmented } from "@/components/console/segmented";
import {
  STATIC_ROLES,
  type RolePermissions,
} from "@/lib/api/endpoints/roles";
import { useRoleVocabulary } from "@/lib/api/use-role-vocabulary";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { PermissionGrid } from "./permission-grid";
import { useCustomRoles } from "./use-members";

/**
 * What each role in this Organization is allowed to do.
 *
 * **This card exists because the member table cannot answer the question it
 * raises.** A column reading "member" is a word, and the decision somebody is
 * actually making at that table is "can this person delete a Project" — which is
 * in `rbac/access-control.ts` and nowhere on any screen until now.
 *
 * The three built-in roles come from the served vocabulary's `staticRoles`,
 * which is the backend's own `ac.newRole({...})` results rather than a
 * restatement of them,
 * and every entry is rendered *against* the `statements` beside it — so a grant
 * naming a subject the backend has dropped simply does not appear, rather than
 * appearing as a claim about a permission that no longer exists. Custom roles
 * come from `GET /custom-roles` and carry their real stored grant map.
 *
 * A `Segmented` and not tabs: these are three-to-a-few mutually exclusive
 * readings of one thing, each acting immediately, which is that control's whole
 * definition. Past four it becomes a `Picker`, which is what happens on an
 * instance with custom roles.
 */
export function RolesCard() {
  const vocabulary = useRoleVocabulary();
  const customRoles = useCustomRoles();
  const [role, setRole] = useState("member");

  const arrival = useArrival(vocabulary.isPending);
  if (vocabulary.isPending) {
    return <SectionPending title="What each role can do" rows={5} />;
  }
  if (vocabulary.error || !vocabulary.data) {
    return (
      <SectionFailed title="What each role can do" error={vocabulary.error}>
        The permission vocabulary comes from the backend, so this card has
        nothing to describe roles with until that read works.
      </SectionFailed>
    );
  }

  const custom = customRoles.data ?? [];
  const options = [
    { value: "member", label: "Member" },
    { value: "admin", label: "Admin" },
    { value: "owner", label: "Owner" },
    ...custom.map((entry) => ({ value: entry.role, label: entry.role })),
  ];

  const permissions: RolePermissions =
    vocabulary.data.staticRoles[role] ??
    custom.find((entry) => entry.role === role)?.permissions ??
    {};

  const isStatic = STATIC_ROLES.includes(role);

  return (
    <Card className={arrival}>
      <Card.Header
        title="What each role can do"
        sub="Straight from the permission table the guards check."
        headingLevel={2}
        actions={
          custom.length > 0 ? (
            <Chip>
              {custom.length} custom {custom.length === 1 ? "role" : "roles"}
            </Chip>
          ) : null
        }
      />
      <Card.Body className="grid gap-3.5">
        {/* `Segmented`'s own rule: two to four visible choices, and past that a
            Select. Three is the unlicensed case; an Organization with custom
            roles crosses the line, which is exactly the situation the rule was
            written for. */}
        {options.length <= 4 ? (
          <Segmented
            label="Role"
            value={role}
            onChange={setRole}
            options={options}
          />
        ) : (
          <div className="max-w-64">
            <Picker value={role} onValueChange={setRole} options={options} />
          </div>
        )}

        <p className="text-meta text-tx-2">
          {isStatic ? (
            <>
              Built-in roles are defined in Cloudgate&rsquo;s own source, not in
              this Organization — nobody can change what {role} means here.
            </>
          ) : (
            <>
              A custom role. Its grants are stored against this Organization, and
              editing them needs an enterprise license.
            </>
          )}
        </p>

        <PermissionGrid
          vocabulary={vocabulary.data}
          value={permissions}
          readOnly
          explainBypass={isStatic}
        />
      </Card.Body>
      <Card.Footer>
        The owner role cannot be given away or taken: no route transfers it, and{" "}
        <code className="font-mono">PATCH /organizations/members/:id</code>{" "}
        refuses it in both directions.
      </Card.Footer>
    </Card>
  );
}
