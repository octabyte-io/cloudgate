import type { RequiredPermissions } from "./use-permission";

/**
 * **The register of every control `usePermission`'s rule has been applied to**.
 *
 * The rule itself is written beside `usePermission`. This file is the mapping
 * it produced — which control, which statement, and the route that statement
 * was read off — kept as data so `gated-controls.test.ts` can check it from
 * both ends: that every control listed here really consults the verdict (the
 * census), and that the statement listed is what the backend asks for and
 * what the roles hold (the mapping). A census on its own proves the sites
 * agree; the second half is what proves they agree on the right thing.
 *
 * Nothing in the app imports this. It is not configuration — the sites read
 * their statements themselves, in the same words, and the test is what fails
 * when a site and its entry drift apart.
 */

/**
 * How a control is gated.
 *
 * - a statement — the site calls `usePermission` with exactly this;
 * - `"instance"` — the site takes `useInstanceGate()` (ADR-0013's authority,
 *   answered by the instance-authority read beside it: the rule's case 2);
 * - `"caller"` — a shared component, handed the verdict by whoever renders it
 *   (`ResourceList` by its spec, `VariablesCard` and `SettingsCard` by `gate`,
 *   `DangerZone` by `unavailable`). Its callers are in {@link GATED_CALLERS}
 *   and {@link GATED_SPECS}.
 * - `"answer"` — the route's own answer to whether it would accept the caller
 *   now: `route` is a `GET` that says `allowed` and why not, asked about the
 *   write beside it (`GET /organizations/creation` for `POST /organizations`).
 *   For a write whose refusal is no role in the open Organization — a limit,
 *   a license, a plan — so no statement is claimed in the browser.
 */
export type Requires = RequiredPermissions | "instance" | "caller" | "answer";

export type GatedControl = {
  /** Under `frontend/src/`. */
  file: string;
  /**
   * The control's words as the census reads them: its text, or one of the
   * string literals it can show, or `{expression}` when it has no literal.
   */
  label: string;
  requires: Requires;
  /**
   * The route the statement was read off, `VERB /path`. Where the route carries
   * `@RequirePermission`, the test holds `requires` to it.
   */
  route?: string;
  /**
   * Where the statement is checked when the route has no decorator — a service
   * method, or better-auth's own check. Required exactly then, so a decorator
   * added later makes this line stale and the test says so.
   */
  checkedIn?: string;
};

const BETTER_AUTH = "better-auth's organization plugin";

export const GATED_CONTROLS: GatedControl[] = [
  // ── /settings/members ────────────────────────────────────────────────
  { file: "features/members/members-card.tsx", label: "Invite someone", requires: { invitation: ["create"] }, route: "POST /organizations/invitations", checkedIn: `${BETTER_AUTH}: createInvitation` },
  { file: "features/members/members-card.tsx", label: "Change role", requires: { member: ["update"] }, route: "PATCH /organizations/members/:id", checkedIn: "OrganizationsService.updateMemberRole: owner or admin, who both hold it" },
  { file: "features/members/members-card.tsx", label: "Manage access", requires: { member: ["update"] }, route: "PATCH /organizations/members/:id/entitlements" },
  { file: "features/members/members-card.tsx", label: "Remove", requires: { member: ["delete"] }, route: "DELETE /organizations/members/:id", checkedIn: `${BETTER_AUTH}: removeMember` },
  { file: "features/members/invitations-card.tsx", label: "Revoke", requires: { invitation: ["cancel"] }, route: "DELETE /organizations/invitations/:id", checkedIn: "OrganizationsService.removeInvitation: owner or admin, who both hold it" },
  { file: "features/members/invitations-card.tsx", label: "Delete", requires: { invitation: ["cancel"] }, route: "DELETE /organizations/invitations/:id", checkedIn: "OrganizationsService.removeInvitation: owner or admin, who both hold it" },
  { file: "features/members/teams-card.tsx", label: "Create a team", requires: { team: ["create"] }, route: "POST /organizations/teams", checkedIn: `${BETTER_AUTH}: createTeam` },
  { file: "features/members/team-row.tsx", label: "Rename", requires: { team: ["update"] }, route: "PATCH /organizations/teams/:id", checkedIn: `${BETTER_AUTH}: updateTeam` },
  { file: "features/members/team-row.tsx", label: "Delete", requires: { team: ["delete"] }, route: "DELETE /organizations/teams/:id", checkedIn: `${BETTER_AUTH}: removeTeam` },
  { file: "features/members/team-row.tsx", label: "Add", requires: { member: ["update"] }, route: "POST /organizations/teams/:id/members", checkedIn: `${BETTER_AUTH}: addTeamMember` },
  { file: "features/members/team-row.tsx", label: "Remove", requires: { member: ["delete"] }, route: "DELETE /organizations/teams/:id/members/:userId", checkedIn: `${BETTER_AUTH}: removeTeamMember` },

  // ── /settings/roles ──────────────────────────────────────────────────
  // A kept-but-stopped role's people: moving them is the member row's Change role.
  { file: "features/enterprise/roles/role-columns.tsx", label: "Change their role", requires: { member: ["update"] }, route: "PATCH /organizations/members/:id", checkedIn: "OrganizationsService.updateMemberRole: owner or admin, who both hold it" },

  // ── /settings/billing ────────────────────────────────────────────────
  // `BillingService.assertAdmin` admits owner and admin only, who both hold
  // `organization: ['update']`.
  { file: "features/billing/plan-card.tsx", label: "Add a card at Stripe", requires: { organization: ["update"] }, route: "POST /billing/portal", checkedIn: "BillingService.assertAdmin: owner or admin, who both hold it" },
  { file: "features/billing/plan-catalogue.tsx", label: "Start", requires: { organization: ["update"] }, route: "POST /billing/checkout", checkedIn: "BillingService.assertAdmin: owner or admin, who both hold it" },
  // Organizations on this plan (ADR-0059): the Paying Organization is the
  // open one, and both writes admit its owners and admins only.
  { file: "features/billing/organizations-on-plan-card.tsx", label: "Add an Organization to this plan", requires: { organization: ["update"] }, route: "POST /organizations", checkedIn: "OrganizationsService.payingFor: owner or admin of the Paying Organization, who both hold it" },
  { file: "features/billing/organizations-on-plan-card.tsx", label: "Stop paying for it", requires: { organization: ["update"] }, route: "POST /billing/attached-organizations/:organizationId/stop-paying", checkedIn: "StopPaying.stopPaying: owner or admin of the Paying Organization, who both hold it" },
  { file: "features/billing/starter-checklist.tsx", label: "Stop paying for it", requires: { organization: ["update"] }, route: "POST /billing/attached-organizations/:organizationId/stop-paying", checkedIn: "StopPaying.stopPaying: owner or admin of the Paying Organization, who both hold it" },

  // ── New organization ─────────────────────────────────────────────────
  // `POST /organizations` refuses by a limit (the Self-hosted one-Organization
  // limit, the Hosted owned count), never by a role in the open Organization;
  // `GET /organizations/creation` gives its answer before anyone clicks.
  { file: "features/settings/organization/organizations-section.tsx", label: "New organization", requires: "answer", route: "GET /organizations/creation" },
  { file: "components/shell/org-switcher.tsx", label: "New organization", requires: "answer", route: "GET /organizations/creation" },

  // ── /settings/agents ─────────────────────────────────────────────────
  // `AgentsService` then admits owner and admin only, who both hold these.
  { file: "features/agents/agents-card.tsx", label: "Create an Agent", requires: { member: ["create"] }, route: "POST /agents" },
  { file: "features/agents/agent-row.tsx", label: "Delete", requires: { member: ["delete"] }, route: "DELETE /agents/:id" },
  { file: "features/agents/agent-row.tsx", label: "Suspend", requires: { member: ["update"] }, route: "POST /agents/:id/suspend" },
  { file: "features/agents/agent-row.tsx", label: "Resume", requires: { member: ["update"] }, route: "POST /agents/:id/resume" },
  { file: "features/agents/agent-row.tsx", label: "Change role", requires: { member: ["update"] }, route: "PATCH /organizations/members/:id", checkedIn: "OrganizationsService.updateMemberRole: owner or admin, who both hold it" },
  { file: "features/agents/agent-row.tsx", label: "Manage access", requires: { member: ["update"] }, route: "PATCH /organizations/members/:id/entitlements" },
  { file: "features/agents/agent-key-list.tsx", label: "Add key", requires: { member: ["update"] }, route: "POST /agents/:id/keys" },
  { file: "features/agents/agent-key-list.tsx", label: "Revoke", requires: { member: ["update"] }, route: "DELETE /agents/:id/keys/:keyId" },
  // An AI model's Model tab: the same create, preset to a Caller.
  { file: "features/application/model/model-connect-card.tsx", label: "Create a caller Agent", requires: { member: ["create"] }, route: "POST /agents" },
  // The Hugging Face token card's Remove token sends `hfToken: ''` through the same PATCH as its
  // Replace token form.
  { file: "features/application/model/model-hf-token-card.tsx", label: "Remove token", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },

  // ── a Service's Health tab: the Error-rate threshold ──────────
  // One threshold per Service, so its section is facts and buttons rather
  // than a ResourceList; the modal and the confirmation are its spec's.
  { file: "features/service-health/threshold-section.tsx", label: "Add a threshold", requires: { service: ["update"] }, route: "PUT /error-rate-thresholds/:serviceId" },
  { file: "features/service-health/threshold-section.tsx", label: "Edit", requires: { service: ["update"] }, route: "PUT /error-rate-thresholds/:serviceId" },
  { file: "features/service-health/threshold-section.tsx", label: "Remove", requires: { service: ["update"] }, route: "DELETE /error-rate-thresholds/:serviceId" },
  { file: "features/agents/agent-key-list.tsx", label: "Remove", requires: { member: ["update"] }, route: "DELETE /agents/:id/keys/:keyId" },

  // ── /projects ────────────────────────────────────────────────────────
  { file: "features/project/projects-screen.tsx", label: "New Project", requires: { project: ["create"] }, route: "POST /projects" },
  // The row menu is a column declaration, so the screen reads the two
  // statements and hands them down as `grants`.
  { file: "features/project/project-columns.tsx", label: "Rename", requires: "caller" },
  { file: "features/project/project-columns.tsx", label: "Delete", requires: "caller" },
  { file: "features/project/project-details-form.tsx", label: "Save changes", requires: { project: ["update"] }, route: "PATCH /projects/:id", checkedIn: "ProjectsService.update" },
  { file: "features/environment/environment-details-form.tsx", label: "Save changes", requires: { environment: ["update"] }, route: "PATCH /environments/:id", checkedIn: "EnvironmentsService.findOwnedForUpdate" },
  // The Deploy target and the Config branch are fields of the
  // same Environment update, under the same statement.
  { file: "features/environment/environment-deploy-target-card.tsx", label: "Save Deploy target", requires: { environment: ["update"] }, route: "PATCH /environments/:id", checkedIn: "EnvironmentsService.findOwnedForUpdate" },
  { file: "features/environment/environment-config-branch-card.tsx", label: "Save Config branch", requires: { environment: ["update"] }, route: "PATCH /environments/:id", checkedIn: "EnvironmentsService.findOwnedForUpdate" },
  // The whole-YAML edit stores a plan per Environment and applies nothing
  // asking for a plan is a read of the Environment (US68).
  { file: "features/project/panels/config.tsx", label: "Save and plan", requires: { environment: ["read"] }, route: "POST /projects/:projectId/config/plans" },
  { file: "features/project/panels/settings.tsx", label: "Delete", requires: { project: ["delete"] }, route: "DELETE /projects/:id" },
  { file: "features/project/panels/environments.tsx", label: "New Environment", requires: { environment: ["create"] }, route: "POST /environments" },
  // The Environments table's row menu, a column declaration like the Projects
  // list's: the panel above reads `environment: ['update']` (PATCH
  // /environments/:id, findOwnedForUpdate) and `['delete']` (DELETE
  // /environments/:id) and hands them down as `grants`.
  { file: "features/environment/environment-columns.tsx", label: "Rename", requires: "caller" },
  { file: "features/environment/environment-columns.tsx", label: "Delete", requires: "caller" },
  { file: "features/environment/panels/settings.tsx", label: "Delete", requires: { environment: ["delete"] }, route: "DELETE /environments/:id" },
  { file: "features/tags/manage-tags-modal.tsx", label: "Add tag", requires: { tag: ["create"] }, route: "POST /tags" },
  { file: "features/tags/tag-row.tsx", label: "Rename", requires: { tag: ["update"] }, route: "PATCH /tags/:id" },
  { file: "features/tags/tag-row.tsx", label: "Delete", requires: { tag: ["delete"] }, route: "DELETE /tags/:id" },

  // ── /servers ─────────────────────────────────────────────────────────
  { file: "features/server/fleet/fleet-screen.tsx", label: "Add a Server", requires: { server: ["create"] }, route: "POST /servers" },
  { file: "features/server/settings/server-danger-card.tsx", label: "Delete", requires: { server: ["delete"] }, route: "DELETE /servers/:id" },
  { file: "features/server/settings/bought-server-size.tsx", label: "Change size", requires: { server: ["create"] }, route: "PUT /bought-servers/:id/size" },
  { file: "features/server/settings/maintenance-card.tsx", label: "Start maintenance", requires: { server: ["create"] }, route: "POST /servers/:id/start-maintenance" },
  { file: "features/server/settings/maintenance-card.tsx", label: "End maintenance", requires: { server: ["create"] }, route: "POST /servers/:id/end-maintenance" },
  { file: "features/ssh-keys/manage-keys-modal.tsx", label: "Add key", requires: { sshKeys: ["create"] }, route: "POST /ssh-keys" },
  { file: "features/ssh-keys/ssh-key-row.tsx", label: "Rename", requires: { sshKeys: ["create"] }, route: "PATCH /ssh-keys/:id" },
  { file: "features/ssh-keys/ssh-key-row.tsx", label: "Delete", requires: { sshKeys: ["delete"] }, route: "DELETE /ssh-keys/:id" },

  // ── /get-started (the templates website's Deploy button) ────────────
  { file: "features/get-started/own-server-form.tsx", label: "Save and continue", requires: { server: ["create"] }, route: "POST /servers" },
  { file: "features/get-started/own-flow.tsx", label: "Start free trial", requires: { organization: ["update"] }, route: "POST /billing/checkout", checkedIn: "BillingService.assertAdmin: owner or admin, who both hold it" },
  { file: "features/get-started/details-step.tsx", label: "Deploy", requires: { service: ["create"] }, route: "POST /templates/setup" },

  // ── an Environment's services ────────────────────────────────────────
  { file: "features/environment/panels/services.tsx", label: "Add an Application", requires: { service: ["create"] }, route: "POST /applications" },
  { file: "features/environment/panels/services.tsx", label: "Add a database", requires: { service: ["create"] }, route: "POST /postgres" },
  { file: "features/environment/panels/services.tsx", label: "Add a Compose stack", requires: { service: ["create"] }, route: "POST /compose" },
  { file: "features/environment/panels/services.tsx", label: "Add an AI model", requires: { service: ["create"] }, route: "POST /applications" },
  { file: "features/environment/panels/services.tsx", label: "Draft one with AI", requires: { service: ["create"] }, route: "POST /ai/deploy", checkedIn: "AiService.deploy: checkServiceAccess(projectId, 'create')" },

  // ── /settings/cloud-accounts ──────────────────────────────────
  // The dialog's first step is `POST /cloud-accounts/setup`, which asks the same,
  // for an AWS account and a Google Cloud project alike (slice 6).
  { file: "features/settings/cloud-accounts/cloud-accounts-section.tsx", label: "Connect a Cloud account", requires: { cloudAccount: ["create"] }, route: "POST /cloud-accounts" },
  { file: "features/settings/cloud-accounts/cloud-accounts-section.tsx", label: "Edit", requires: { cloudAccount: ["update"] }, route: "PATCH /cloud-accounts/:id" },
  { file: "features/settings/cloud-accounts/cloud-accounts-section.tsx", label: "Delete", requires: { cloudAccount: ["delete"] }, route: "DELETE /cloud-accounts/:id" },
  { file: "features/settings/cloud-accounts/cloud-accounts-section.tsx", label: "New key", requires: { cloudAccount: ["update"] }, route: "POST /cloud-accounts/:id/key" },
  // A row's out-of-date policy, handed `cloudAccount: update` by the
  // section above: `GET /cloud-accounts/:id/template` asks it.
  { file: "features/settings/cloud-accounts/policy-standing-cell.tsx", label: "New CloudFormation template", requires: "caller" },
  { file: "features/settings/cloud-accounts/policy-standing-cell.tsx", label: "New setup script", requires: "caller" },

  // ── /settings/notifications and /settings/git-providers ─────────────
  { file: "features/integrations/notifications/notifications-section.tsx", label: "Add a channel", requires: { notification: ["create"] }, route: "POST /notifications/slack" },
  { file: "features/integrations/notifications/notifications-section.tsx", label: "Edit", requires: { notification: ["update"] }, route: "PATCH /notifications/slack/:id" },
  { file: "features/integrations/notifications/notifications-section.tsx", label: "Remove", requires: { notification: ["delete"] }, route: "DELETE /notifications/:id" },
  { file: "features/integrations/git-providers/connect-github-app.tsx", label: "Create the app on GitHub", requires: { gitProviders: ["create"] }, route: "POST /git-providers/oauth/github/manifest" },
  { file: "features/integrations/git-providers/authorize-connection.tsx", label: "Authorize", requires: { gitProviders: ["create"] }, route: "POST /git-providers/oauth/gitlab/:id/authorize" },
  { file: "features/integrations/git-providers/unlisted-connections.tsx", label: "Remove", requires: { gitProviders: ["delete"] }, route: "DELETE /git-providers/:id" },

  // ── an Application ───────────────────────────────────────────────────
  { file: "features/application/source/source-card.tsx", label: "Change source", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/source/build-card.tsx", label: "Edit", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/deploy/deploy-button.tsx", label: "Deploy", requires: { deployment: ["create"] }, route: "POST /applications/:applicationId/deployments" },
  { file: "features/application/cron/run-now-button.tsx", label: "Run now", requires: { deployment: ["create"] }, route: "POST /applications/:id/run" },
  { file: "features/application/lifecycle/redeploy-button.tsx", label: "Redeploy", requires: { deployment: ["create"] }, route: "POST /applications/:applicationId/redeploy" },
  { file: "features/application/lifecycle/application-actions.tsx", label: "Restart", requires: { deployment: ["create"] }, route: "POST /applications/:id/reload" },
  { file: "features/application/lifecycle/application-actions.tsx", label: "Start", requires: { deployment: ["create"] }, route: "POST /applications/:id/start" },
  { file: "features/application/lifecycle/application-actions.tsx", label: "Stop", requires: { deployment: ["create"] }, route: "POST /applications/:id/stop" },
  { file: "features/compose/lifecycle/compose-actions.tsx", label: "Restart", requires: { deployment: ["create"] }, route: "POST /compose/:id/restart" },
  // Cancel of a build, a held build or a Cron service's run.
  { file: "features/application/lifecycle/cancel-build-button.tsx", label: "Cancel", requires: { deployment: ["cancel"] }, route: "POST /deployments/:deploymentId/cancel" },
  // Stop the run: Cancel's statement, past the point Cancel refuses.
  { file: "features/application/lifecycle/stop-run-button.tsx", label: "Stop the run", requires: { deployment: ["cancel"] }, route: "POST /deployments/:deploymentId/stop-run" },
  { file: "features/application/panels/static-rollbacks.tsx", label: "Roll back", requires: { deployment: ["create"] }, route: "POST /rollbacks/:rollbackId/rollback" },
  { file: "features/application/panels/static-rollbacks.tsx", label: "Delete", requires: { deployment: ["create"] }, route: "DELETE /rollbacks/:rollbackId" },
  // A cloud Service's Domains: the same routes as a Server's, whose
  // update is `domain: create` too.
  { file: "features/application/domains/cloud-domains-card.tsx", label: "Add a domain", requires: { domain: ["create"] }, route: "POST /domains" },
  { file: "features/application/domains/cloud-domains-card.tsx", label: "Edit", requires: { domain: ["create"] }, route: "PATCH /domains/:id" },
  { file: "features/application/domains/cloud-domains-card.tsx", label: "Remove", requires: { domain: ["delete"] }, route: "DELETE /domains/:id" },
  // The Advanced tab's Swarm form: one Save for eleven cards.
  { file: "features/application/advanced/swarm/swarm-section.tsx", label: "Save Swarm settings", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/lifecycle/delete-application-card.tsx", label: "Delete", requires: { service: ["delete"] }, route: "DELETE /applications/:id" },
  // The Previews tab's two lists: a pull-request preview's controls,
  // then a Requested preview's. Expire now is its Delete, worded as what a
  // Delete does to one.
  { file: "features/application/panels/previews-list-card.tsx", label: "Redeploy", requires: { deployment: ["create"] }, route: "POST /preview-deployments/:previewDeploymentId/redeploy" },
  { file: "features/application/panels/previews-list-card.tsx", label: "Tear down", requires: { deployment: ["cancel"] }, route: "DELETE /preview-deployments/:previewDeploymentId" },
  { file: "features/application/panels/requested-previews-card.tsx", label: "Extend", requires: { deployment: ["create"] }, route: "POST /preview-deployments/:previewDeploymentId/extend" },
  { file: "features/application/panels/requested-previews-card.tsx", label: "Redeploy", requires: { deployment: ["create"] }, route: "POST /preview-deployments/:previewDeploymentId/redeploy" },
  { file: "features/application/panels/requested-previews-card.tsx", label: "Expire now", requires: { deployment: ["cancel"] }, route: "DELETE /preview-deployments/:previewDeploymentId" },

  // ── a Compose stack ───────────────────────────────────────────
  { file: "features/compose/source/compose-source-card.tsx", label: "Change source", requires: { service: ["update"] }, route: "PATCH /compose/:id", checkedIn: "ComposeService.findOwnedForUpdate" },
  { file: "features/compose/editor/compose-file-card.tsx", label: "Save the file", requires: { service: ["update"] }, route: "PATCH /compose/:id", checkedIn: "ComposeService.findOwnedForUpdate" },
  { file: "features/compose/advanced/isolation-card.tsx", label: "Save", requires: { service: ["update"] }, route: "PATCH /compose/:id", checkedIn: "ComposeService.findOwnedForUpdate" },
  { file: "features/compose/panels/advanced.tsx", label: "Delete", requires: { service: ["delete"] }, route: "DELETE /compose/:id" },

  // ── a database (the same routes on all six engines) ────────────
  // The route's decorator. Its service also runs `findOwnedForUpdate`
  // (`service: ['update']`), and the card reads that too.
  { file: "features/database/credentials/external-ports-card.tsx", label: "Save ports", requires: { service: ["create"] }, route: "POST /postgres/:id/external-port" },
  { file: "features/database/panels/advanced.tsx", label: "Delete", requires: { service: ["delete"] }, route: "DELETE /postgres/:id" },

  // ── a bucket's Rotate key ─────────────────────────────────────
  { file: "features/bucket/bucket-key-card.tsx", label: "Rotate key", requires: { service: ["update"] }, route: "POST /buckets/:id/rotate-key" },
  // ── a bucket's browser-upload origins ─────────────────────────
  { file: "features/bucket/bucket-screen.tsx", label: "Delete", requires: { service: ["delete"] }, route: "DELETE /buckets/:id" },
  { file: "features/bucket/bucket-origins-card.tsx", label: "Add origin", requires: { service: ["update"] }, route: "PUT /buckets/:id/origins" },
  { file: "features/bucket/bucket-origins-card.tsx", label: "Remove", requires: { service: ["update"] }, route: "PUT /buckets/:id/origins" },
  { file: "features/bucket/bucket-volume-backups.tsx", label: "Run now", requires: { volumeBackup: ["create"] }, route: "POST /volume-backups/:id/run" },
  { file: "features/bucket/bucket-volume-backups.tsx", label: "Restore a volume", requires: { volumeBackup: ["restore"] }, route: "POST /volume-backups/restore" },
  // ── a Server bucket's Domains: the same routes as a Service's ──
  { file: "features/bucket/bucket-domains-card.tsx", label: "Add a domain", requires: { domain: ["create"] }, route: "POST /domains" },
  { file: "features/bucket/bucket-domains-card.tsx", label: "Edit", requires: { domain: ["create"] }, route: "PATCH /domains/:id" },
  { file: "features/bucket/bucket-domains-card.tsx", label: "Remove", requires: { domain: ["delete"] }, route: "DELETE /domains/:id" },

  // ── /settings/instance and /settings/maintenance (ADR-0013) ──────────
  { file: "features/settings/platform/instance-danger-zone.tsx", label: "Update and restart", requires: "instance" },
  { file: "features/settings/platform/instance-danger-zone.tsx", label: "Restart Cloudgate", requires: "instance" },
  { file: "features/settings/platform/instance-danger-zone.tsx", label: "Empty the queue", requires: "instance" },
  { file: "features/settings/platform/maintenance-cleanup-card.tsx", label: "{cleanup.button}", requires: "instance" },
  { file: "features/settings/platform/maintenance-scheduled-card.tsx", label: "Save schedule", requires: "instance" },
  { file: "features/settings/platform/maintenance-danger-zone.tsx", label: "Prune everything", requires: "instance" },
  { file: "features/settings/platform/maintenance-danger-zone.tsx", label: "Run every cleanup", requires: "instance" },

  // ── /settings/traefik ─────────────────────────────────────────
  // The three named files and the container's env and ports: requireInstanceAuthority,
  // the ports and env routes by `traefikTargetAuthority`'s host branch (no serverId).
  { file: "features/settings/platform/traefik-config-card.tsx", label: "Save", requires: "instance" },
  { file: "features/settings/platform/traefik-env-block.tsx", label: "Save environment", requires: "instance" },
  { file: "features/settings/platform/traefik-ports-block.tsx", label: "Save ports", requires: "instance" },
  { file: "features/settings/platform/traefik-ports-block.tsx", label: "Add a port", requires: "instance" },
  { file: "features/settings/platform/traefik-ports-block.tsx", label: "Remove", requires: "instance" },
  // The route's decorator. Its host branch (`traefikFileTarget`) also takes
  // instance authority, and the card reads `useInstanceGate` too.
  { file: "features/settings/platform/traefik-files-card.tsx", label: "Save file", requires: { traefikFiles: ["write"] }, route: "POST /settings/traefik/file" },

  // ── shared components, gated by their callers ────────────────────────
  { file: "components/console/resource-list.tsx", label: "{spec.addLabel}", requires: "caller" },
  { file: "components/console/resource-list.tsx", label: "Edit", requires: "caller" },
  { file: "components/console/resource-list.tsx", label: "Remove", requires: "caller" },
  { file: "components/console/variables-card.tsx", label: "Edit", requires: "caller" },
  { file: "components/console/variables-card.tsx", label: "Add variables", requires: "caller" },
  { file: "components/console/settings-card.tsx", label: "Save changes", requires: "caller" },
  // A `rows` field's adder, handed its form's save verdict.
  { file: "components/console/rows-field.tsx", label: "{addLabel}", requires: "caller" },
  // A machine's DNS-01 setup, handed its caller's verdict: the platform
  // host's Traefik screen reads `useInstanceGate()`, a Server's Settings tab
  // reads the setup itself (`readGate`), because the Server branch of
  // `traefikTargetAuthority` is owner-or-admin, which no statement names.
  { file: "components/console/dns-challenge-card.tsx", label: "Save DNS-01 setup", requires: "caller" },
  { file: "components/console/dns-challenge-card.tsx", label: "Remove DNS-01 setup", requires: "caller" },
  { file: "components/console/dns-challenge-credentials.tsx", label: "Add a credential", requires: "caller" },
  // A machine's GPU support, handed its caller's verdict: the platform
  // host's Instance settings read `useInstanceGate()`, a Server's
  // Infrastructure tab reads `usePermission({ server: ['create'] })` — the
  // owner and admin roles, which `maintenanceTargetAuthority`'s Server branch
  // admits; its check is behind the button, so no read can answer for it.
  { file: "components/console/gpu-support-card.tsx", label: "{checkLabel}", requires: "caller" },
  { file: "components/console/gpu-support-card.tsx", label: "Run GPU setup", requires: "caller" },
  // Rebuild from the cloud: the banner is shared, handed its refusal by
  // `cloud-resources-card.tsx` (`service: ['update']`, `POST
  // /applications/:id/state/rebuild`) and `network-resources.tsx`
  // (`environment: ['update']`, `POST /environments/:id/networks/:networkId/state/rebuild`).
  { file: "components/console/cloud-resource-list.tsx", label: "Rebuild from the cloud", requires: "caller" },
];

/**
 * A caller handing `VariablesCard` or `SettingsCard` its `gate`. The census
 * finds every usage of the two, and a gated one whose file is missing here
 * fails it — this list is where its statement is held to the backend.
 */
export type GatedCaller = {
  file: string;
  component: "VariablesCard" | "SettingsCard";
  requires: RequiredPermissions | "instance";
  route?: string;
  checkedIn?: string;
};

export const GATED_CALLERS: GatedCaller[] = [
  { file: "features/application/panels/variables.tsx", component: "VariablesCard", requires: { service: ["update"] }, route: "PATCH /applications/:id/environment", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/vars/build-arguments-card.tsx", component: "VariablesCard", requires: { service: ["update"] }, route: "PATCH /applications/:id/environment", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  // Build server, Resources, Run command, Preview settings, Keep rollback points.
  { file: "features/application/advanced/build-server-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/model/model-settings-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/model/model-hf-token-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/advanced/resources-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/advanced/runtime-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  // Container port, whose save moves the Domains on the old port (ADR-0068).
  { file: "features/application/advanced/port-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  // A Cloud Run Service's copy range, set on Cloud Run by a direct call.
  { file: "features/application/advanced/copy-range-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PUT /applications/:id/copy-range" },
  { file: "features/application/panels/previews-settings-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/panels/rollbacks.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/application/panels/static-rollbacks.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /applications/:id", checkedIn: "ApplicationsService.findOwnedForUpdate" },
  { file: "features/compose/panels/variables.tsx", component: "VariablesCard", requires: { service: ["update"] }, route: "PATCH /compose/:id/environment", checkedIn: "ComposeService: checkServiceAccess 'update'" },
  { file: "features/compose/panels/overview.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /compose/:id", checkedIn: "ComposeService.findOwnedForUpdate" },
  { file: "features/compose/stack-vm/stack-vm-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /compose/:id/stack-vm" },
  // Both cards on the tab, How it is applied and From the repository.
  { file: "features/compose/panels/advanced.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /compose/:id", checkedIn: "ComposeService.findOwnedForUpdate" },
  { file: "features/database/panels/variables.tsx", component: "VariablesCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id/environment", checkedIn: "database service: checkServiceAccess 'update'" },
  { file: "features/database/panels/overview.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id", checkedIn: "BaseDatabaseService.findOwnedForUpdate" },
  { file: "features/database/panels/credentials.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id", checkedIn: "BaseDatabaseService.findOwnedForUpdate" },
  { file: "features/database/panels/advanced-resources-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id", checkedIn: "BaseDatabaseService.findOwnedForUpdate" },
  { file: "features/database/panels/rds-settings-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id/rds-settings" },
  { file: "features/database/existing/existing-database-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id/existing" },
  { file: "features/database/existing/existing-cache-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /redis/:id/existing" },
  { file: "features/database/panels/elasticache-settings-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /redis/:id/elasticache-settings" },
  { file: "features/database/panels/memorystore-settings-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /redis/:id/memorystore-settings" },
  // A cloud database's retention on its Backups tab: one card, a route per engine.
  { file: "features/database/backups/cloud-retention-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id/rds-settings" },
  { file: "features/database/backups/cloud-retention-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /redis/:id/elasticache-settings" },
  { file: "features/database/existing/existing-database-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id/existing" },
  { file: "features/database/panels/advanced-runtime-card.tsx", component: "SettingsCard", requires: { service: ["update"] }, route: "PATCH /postgres/:id", checkedIn: "BaseDatabaseService.findOwnedForUpdate" },
  // A Server's Settings tab: `PATCH /servers/:id` is decorated `server:
  // ['create']` — the vocabulary has no `server: ['update']`.
  { file: "features/server/settings/identity-card.tsx", component: "SettingsCard", requires: { server: ["create"] }, route: "PATCH /servers/:id" },
  { file: "features/server/settings/connection-card.tsx", component: "SettingsCard", requires: { server: ["create"] }, route: "PATCH /servers/:id" },
  { file: "features/server/settings/setup-command-card.tsx", component: "SettingsCard", requires: { server: ["create"] }, route: "PATCH /servers/:id" },
  { file: "features/environment/panels/variables.tsx", component: "VariablesCard", requires: { environment: ["update"] }, route: "PATCH /environments/:id", checkedIn: "EnvironmentsService.update" },
  { file: "features/project/panels/settings.tsx", component: "VariablesCard", requires: { project: ["update"] }, route: "PATCH /projects/:id", checkedIn: "ProjectsService.update" },
  { file: "features/settings/platform/instance-section.tsx", component: "SettingsCard", requires: "instance" },
  { file: "features/settings/platform/console-domain-card.tsx", component: "SettingsCard", requires: "instance" },
  { file: "features/settings/platform/concurrent-builds-card.tsx", component: "SettingsCard", requires: "instance" },
  { file: "features/settings/platform/cloud-run-limits-card.tsx", component: "SettingsCard", requires: "instance" },
  { file: "features/settings/platform/requested-preview-max-ttl-card.tsx", component: "SettingsCard", requires: "instance" },
  { file: "features/enterprise/whitelabeling/branding-cards.tsx", component: "SettingsCard", requires: "instance" },
];

/**
 * Every `ResourceSpec`, and the three routes its writes go to. The statements
 * are in the spec itself (`permissions`, required by the type — which is this
 * surface's census); the test reads them from there and holds them to these
 * routes' decorators.
 */
export type GatedSpec = {
  file: string;
  /** `"same-as-list"` specs name no routes: nothing names their statement. */
  routes: { create: string; update: string; remove: string } | "same-as-list";
};

export const GATED_SPECS: GatedSpec[] = [
  { file: "features/integrations/destinations/destinations-spec.tsx", routes: { create: "POST /destinations", update: "PATCH /destinations/:id", remove: "DELETE /destinations/:id" } },
  { file: "features/integrations/registries/registries-spec.tsx", routes: { create: "POST /registries", update: "PATCH /registries/:id", remove: "DELETE /registries/:id" } },
  { file: "features/certificates/certificates-spec.tsx", routes: { create: "POST /certificates", update: "PATCH /certificates/:id", remove: "DELETE /certificates/:id" } },
  { file: "features/integrations/notifications/channel-spec.tsx", routes: { create: "POST /notifications/slack", update: "PATCH /notifications/slack/:id", remove: "DELETE /notifications/:id" } },
  { file: "features/integrations/git-providers/provider-spec.tsx", routes: { create: "POST /github", update: "PATCH /github/:id", remove: "DELETE /git-providers/:id" } },
  { file: "features/integrations/ai/ai-spec.tsx", routes: "same-as-list" },
  { file: "features/application/advanced/mounts-spec.tsx", routes: { create: "POST /mounts", update: "PATCH /mounts/:id", remove: "DELETE /mounts/:id" } },
  { file: "features/application/advanced/schedules-spec.tsx", routes: { create: "POST /schedules", update: "PATCH /schedules/:id", remove: "DELETE /schedules/:id" } },
  { file: "features/application/advanced/volume-backups-spec.tsx", routes: { create: "POST /volume-backups", update: "PATCH /volume-backups/:id", remove: "DELETE /volume-backups/:id" } },
  { file: "features/application/advanced/patches-spec.tsx", routes: { create: "POST /patches", update: "PATCH /patches/:id", remove: "DELETE /patches/:id" } },
  { file: "features/database/backups/backup-schedule-spec.tsx", routes: { create: "POST /backups", update: "PATCH /backups/:id", remove: "DELETE /backups/:id" } },
  // A Service's Health tab. Turn off / Turn on is the same PATCH, read
  // from the same statement by `uptime-checks-section.tsx`.
  { file: "features/service-health/uptime-check-spec.tsx", routes: { create: "POST /uptime-checks", update: "PATCH /uptime-checks/:uptimeCheckId", remove: "DELETE /uptime-checks/:uptimeCheckId" } },
  // Add and edit are one PUT: the threshold is named by its Service.
  { file: "features/service-health/error-rate-threshold-spec.tsx", routes: { create: "PUT /error-rate-thresholds/:serviceId", update: "PUT /error-rate-thresholds/:serviceId", remove: "DELETE /error-rate-thresholds/:serviceId" } },
];

/**
 * The networking file holds three specs; they are checked in order of
 * appearance — ports, redirects, security.
 */
export const GATED_SPECS_MULTI: { file: string; routes: GatedSpec["routes"][] } = {
  file: "features/application/advanced/networking-specs.tsx",
  routes: [
    { create: "POST /ports", update: "PATCH /ports/:id", remove: "DELETE /ports/:id" },
    { create: "POST /redirects", update: "PATCH /redirects/:id", remove: "DELETE /redirects/:id" },
    { create: "POST /security", update: "PATCH /security/:id", remove: "DELETE /security/:id" },
  ],
};
