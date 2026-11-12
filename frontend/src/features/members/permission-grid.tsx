import {
  type RolePermissions,
  type RoleVocabulary,
} from "@/lib/api/endpoints/roles";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * **What a role is allowed to do, as the backend's own vocabulary** (F16).
 *
 * Every subject and every action comes from `GET /custom-roles/statements`,
 * which returns `rbac/access-control.ts`'s `statements` object unchanged — so
 * the grid offers exactly the pairs the `@RequirePermission` guards check, and a
 * resource added to the backend appears here on the next deploy with no edit.
 * Nothing on this screen is written down twice; the labels below are the one
 * exception and they are *labels*, so a missing one degrades to the key rather
 * than to a wrong claim.
 *
 * **F16 renders it, F18 makes it writable.** That split is F18's brief, not a
 * convenience: creating and editing a custom role is `enterpriseProcedure`
 * behind a licence check, while `statements` and the role listing are open to
 * every member. So the useful, unlicensed half of this feature is *reading* —
 * answering "what can a member actually do here", which is the question people
 * arrive at a members screen with — and that half ships now. `onChange` is
 * already in the signature so F18 adds a call site and not a component.
 *
 * ## The two annotations, and why they are not decoration
 *
 * - **Managed by Cloudgate** (`vocabulary.internalResources`).
 *   `validatePermissions` refuses `organization`, `invitation`, `team` and `ac`
 *   in a custom role's grant map. They are still rendered, because an *owner*
 *   genuinely does hold `organization: delete` and hiding it would make the read
 *   of "what does owner get" wrong in order to answer a different question. When
 *   the grid is editable they are off and say why.
 * - **Not enforced for built-in roles** (`vocabulary.enterpriseOnlyResources`).
 *   `PermissionService` skips the check entirely for owner, admin and member —
 *   so two thirds of the ticks against `owner` below are describing a rule that
 *   is never evaluated. Leaving that unsaid would be the most misleading thing
 *   on the screen: somebody would read `member` having no `server` grant and
 *   conclude a member cannot add a Server, which is not what happens.
 *
 * **Both annotations used to come from hand-copied constants and now arrive with
 * the rows**. One
 * prop rather than three is the point of that change on this component: an
 * annotation read from a different request than the row it annotates is how a
 * grid ends up marking the wrong rows after a statement moves.
 */
export function PermissionGrid({
  vocabulary,
  value,
  onChange,
  /** Off for a built-in role, whose grants are code rather than data. */
  readOnly,
  /** Say which of the two annotations apply. On for a static role's read-out. */
  explainBypass = true,
}: {
  vocabulary: RoleVocabulary;
  value: RolePermissions;
  onChange?: (next: RolePermissions) => void;
  readOnly?: boolean;
  explainBypass?: boolean;
}) {
  const { statements } = vocabulary;
  const editable = !readOnly && onChange !== undefined;
  const resources = Object.keys(statements);

  function toggle(resource: string, action: string, on: boolean) {
    if (!onChange) return;
    const held = new Set(value[resource] ?? []);
    if (on) held.add(action);
    else held.delete(action);
    onChange({ ...value, [resource]: [...held] });
  }

  return (
    <div className="grid gap-0">
      {resources.map((resource) => {
        const actions = statements[resource] ?? [];
        const held = new Set(value[resource] ?? []);
        const internal = vocabulary.internalResources.includes(resource);
        const bypassed =
          vocabulary.enterpriseOnlyResources.includes(resource);

        return (
          <div
            key={resource}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-b border-line py-2.5 last:border-b-0"
          >
            <div className="min-w-0 basis-52 grow">
              <p className="text-body font-medium text-tx">
                {RESOURCE_LABELS[resource] ?? humanise(resource)}
              </p>
              {/*
                **The two annotations are about different things, so one of them
                does not answer to `explainBypass`** (fixed by F18, found by
                driving the builder). "Not checked for the built-in roles" is a
                statement about a static role's read-out and is exactly what
                `explainBypass` is for. "Managed by Cloudgate" is a statement
                about *this form*: the row's checkboxes are off, and F03's one
                inert rule is that a control which cannot run says why, in place.
                F18's builder passes `explainBypass={false}` — correctly, since
                every tick in a custom role really is checked — and that left
                four rows disabled with no reason given.
              */}
              {internal && (editable || explainBypass) ? (
                <p className="mt-0.5 text-meta text-tx-3">
                  Managed by Cloudgate — a custom role cannot be given this.
                </p>
              ) : !internal && bypassed && explainBypass ? (
                <p className="mt-0.5 text-meta text-tx-3">
                  Not checked for the built-in roles.
                </p>
              ) : null}
              {/*
                **The third annotation, and it answers to neither flag**.
                The two above are about whether a row's ticks are *evaluated*;
                this one is about how far a tick reaches once it is, which is
                true of a built-in role's read-out and of a custom role's
                builder alike. It exists because the grant this grid offers is
                named after a row — "Projects", "Environments" — while an
                `update` on either rewrites the variables every Service beneath
                it resolves its references against, across Environments and
                Services the same role may be refused. That reach is deliberate
                and decided (ADR-0014);
                what was objected to is that it was not visible from the
                toggle's name, and withholding the two `*EnvVars` toggles that
                have since been deleted read as a narrower guarantee than the
                grid could actually make.
              */}
              {RESOURCE_REACH[resource] ? (
                <p className="mt-0.5 text-meta text-tx-3">
                  {RESOURCE_REACH[resource]}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
              {actions.length === 0 ? (
                <span className="text-meta text-tx-3">No actions</span>
              ) : (
                actions.map((action) =>
                  editable ? (
                    <label
                      key={action}
                      className={cn(
                        "flex items-center gap-1.75 text-ui",
                        internal ? "text-tx-3" : "text-tx-2",
                      )}
                    >
                      <Checkbox
                        checked={held.has(action)}
                        disabled={internal}
                        onCheckedChange={(next) =>
                          toggle(resource, action, next === true)
                        }
                      />
                      {action}
                    </label>
                  ) : (
                    <span
                      key={action}
                      className={cn(
                        "inline-flex h-chip items-center rounded-md border px-1.75 text-chip font-medium",
                        held.has(action)
                          ? "border-ok-line bg-ok-tint text-ok"
                          : "border-line bg-panel-2 text-tx-3",
                      )}
                    >
                      {/* The tick and the strike are decoration; the word after
                          them is the state, so greyscale and a screen reader
                          both get the same answer. */}
                      <span aria-hidden="true" className="mr-1">
                        {held.has(action) ? "✓" : "✕"}
                      </span>
                      {action}
                      <span className="sr-only">
                        {held.has(action) ? " allowed" : " not allowed"}
                      </span>
                    </span>
                  ),
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Human labels for the subjects whose key is not already a word.
 *
 * Deliberately incomplete: anything absent falls through to `humanise`, so a
 * subject added to the backend reads as `Volume backup` rather than as nothing.
 * The vocabulary rule applies — these are Cloudgate's nouns, and `service` keeps
 * the name the shared row components already use for "the three things an
 * Environment holds".
 */
const RESOURCE_LABELS: Record<string, string> = {
  ac: "Roles",
  auditLog: "Audit log",
  cloudAccount: "Cloud accounts",
  environment: "Environments",
  gitProviders: "Git providers",
  service: "Services — Applications, databases and Compose stacks",
  sshKeys: "SSH keys",
  traefikFiles: "Traefik files",
  volumeBackup: "Volume backups",
};

/**
 * How far a grant on this subject reaches, for the subjects where the answer is
 * wider than the subject's own row.
 *
 * Two entries, and they are the two the backend gates a parent-row write on: a
 * Project and an Environment each own an `env` that every Service beneath it
 * reads at deploy, and the entitlement lists on a member row — which Projects,
 * which Environments, which Services they may reach — do not bound what that
 * write lands on. ADR-0014 decided it should stay that way and that the reach
 * should be said out loud instead, which is this map.
 *
 * **The wording is `reference`, not `inherit`, and that is a correction
 * rather than a stylistic choice.** The platform does not merge a parent's
 * variables downward — `prepareEnvironmentVariables` resolves `${{project.…}}`
 * and `${{environment.…}}` references and returns the Service's own keys — so
 * "inherits" is the sentence that sends an operator off to set a Project
 * variable and get nothing, which is what `variables-card.tsx`'s empty state
 * was fixed for. The reach is real either way: what a reference already written
 * resolves to is exactly what these grants let somebody change.
 *
 * `projectEnvVars` and `environmentEnvVars` used to appear here as their own
 * rows, labelled "Project variables" and "Environment variables". Both
 * statements were deleted: nothing in the backend consulted them, so the rows
 * offered an operator a restriction they were not getting. The reach they
 * looked like they described belongs to these two subjects, and now says so.
 *
 * **`envVars` was the third of that shape and is gone too**
 * It had a
 * label rather than a reach note — "Service variables" — on the reasoning that
 * a Service's own variables reach one Service, which is the row the grant is
 * named after, so a note would be the narration §1.2 rules out. That reasoning
 * was sound and the row was still a lie: nothing in the backend consulted the
 * statement, and a Service's `env` is written behind `service: ["update"]`
 * which this grid already renders. So the toggle an operator wanted is
 * on the `service` row and always was. `logs` went the same way and never had
 * an entry in either map — log access is authorized by entitlement, not by a
 * statement (ADR-0007, ADR-0008).
 */
const RESOURCE_REACH: Record<string, string> = {
  environment:
    "Update also rewrites the Environment variables that every Service in it " +
    "can reference — including Services this role is not granted.",
  project:
    "Update also rewrites the Project variables that every Service in every " +
    "Environment under it can reference — including Environments and Services " +
    "this role is not granted.",
};

/** `volumeBackup` → `Volume backup`. Only ever a fallback. */
function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
