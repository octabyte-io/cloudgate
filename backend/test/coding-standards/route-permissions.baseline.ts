/**
 * `route-permissions.spec.ts`'s `BASELINE`, in a module of its own so a second
 * census can read it: `tool-permissions.spec.ts` requires an MCP tool's
 * undecorated *mutating* twin to be written down here (ADR-0023).
 * Importing it from the spec itself would register that spec's tests a second
 * time inside the importer.
 */

/**
 * Every undecorated mutating handler, with the gate that protects it instead.
 *
 * A `NONE:` value is a handler with no authorization beyond `AuthGuard` — see
 * the count assertion at the bottom. The one that is left is a `@Post` that
 * writes nothing; that is the reason it was left rather than an excuse for it
 * — and `POST /templates/preview` is why "writes nothing" was never the whole
 * question, because the row its gating
 * removed *rendered* an Environment's Project name and a Server's ip address
 * to a caller entitled to neither.
 *
 * The only correct edit to this map is a deletion — a handler that gains a
 * `@RequirePermission` leaves the list. Adding a row means writing down the
 * gate you are relying on, which is the point.
 */
export const BASELINE: Readonly<Record<string, string>> = {
  // Instance authority: the platform host is not an Organization's to configure.
  'src/admin/admin.controller.ts :: POST setupMonitoring':
    'SettingsService.requireInstanceAuthority',
  'src/monitoring/monitoring.controller.ts :: POST readStatsLogs':
    'PermissionService.checkInstanceAuthority',
  'src/monitoring/monitoring.controller.ts :: POST readStats':
    'PermissionService.checkInstanceAuthority',
  // The Operator's writes on a customer Organization (ADR-0050).
  'src/operator/operator.controller.ts :: POST suspend':
    'OperatorService.assertOperator',
  'src/operator/operator.controller.ts :: DELETE lift':
    'OperatorService.assertOperator',
  'src/operator/operator.controller.ts :: PUT setEnterprise':
    'OperatorService.assertOperator',
  // The Operator's Server markup and margin floor, instance settings (#1399).
  'src/operator/operator.controller.ts :: PUT setBoughtServerSettings':
    'OperatorService.assertOperator',
  // The Operator's Delete of a machine nothing owns (#1402).
  'src/operator/operator.controller.ts :: DELETE deleteOrphanMachine':
    'OperatorService.assertOperator',
  // The Operator's abuse actions on a customer Organization (#1401).
  'src/operator/operator-abuse.controller.ts :: POST forwardAbuseReport':
    'OperatorService.assertOperator',
  'src/operator/operator-abuse.controller.ts :: POST closeAbuseReport':
    'OperatorService.assertOperator',
  'src/operator/operator-abuse.controller.ts :: POST powerOffBoughtServer':
    'OperatorService.assertOperator',
  'src/operator/operator-abuse.controller.ts :: POST powerOnBoughtServer':
    'OperatorService.assertOperator',
  // The Operator's reprice of Bought Servers already sold (#1400).
  'src/operator/operator.controller.ts :: POST previewReprice':
    'OperatorService.assertOperator',
  'src/operator/operator.controller.ts :: POST applyReprice':
    'OperatorService.assertOperator',

  // AI provider configuration is owner/admin. The two probes used to be the
  // exception — "a write-nothing probe of the caller-supplied apiUrl", which
  // was true and was an SSRF: writing nothing is not the
  // same as reaching nothing, and what they reached was the platform host's own
  // network. Both now carry the module's role gate *and* a check on the
  // destination.
  'src/ai/ai.controller.ts :: POST create': 'AiService.ensureOwnerOrAdmin',
  'src/ai/ai.controller.ts :: POST getModels':
    'AiService.ensureOwnerOrAdmin, plus assertDestinationAllowed on the caller-supplied apiUrl',
  'src/ai/ai.controller.ts :: POST suggest':
    'AiService.findOneWithCredentials, organization-scoped by aiId',
  'src/ai/ai.controller.ts :: POST analyzeLogs':
    'AiService.findOneWithCredentials, organization-scoped by aiId',
  'src/ai/ai.controller.ts :: POST testConnection':
    'AiService.ensureOwnerOrAdmin, plus assertDestinationAllowed before probeProvider',
  'src/ai/ai.controller.ts :: POST testSavedConnection':
    'AiService.ensureOwnerOrAdmin',
  'src/ai/ai.controller.ts :: POST deploy':
    "PermissionService.checkServiceAccess(projectId, 'create')",
  'src/ai/ai.controller.ts :: PATCH update': 'AiService.ensureOwnerOrAdmin',
  'src/ai/ai.controller.ts :: DELETE remove': 'AiService.ensureOwnerOrAdmin',

  // The eighteen routes the `service: ['update']` change was about. Each runs one
  // `checkServiceAccess(…, 'update')` through its module's findOwnedForUpdate.
  'src/applications/applications.controller.ts :: PATCH update':
    'ApplicationsService.findOwnedForUpdate',
  'src/applications/applications.controller.ts :: PATCH saveEnvironment':
    'ApplicationsService.findOwnedForUpdate',
  'src/applications/applications.controller.ts :: POST uploadDrop':
    'ApplicationsService.findOwnedForUpdate',
  'src/applications/applications.controller.ts :: POST refreshToken':
    'ApplicationsService.findOwnedForUpdate',
  // Not one of the eighteen: the registry-login test for a Docker-image source,
  // gated exactly as the `PATCH` that would save the same form is. A
  // `@RequirePermission('registry', …)` would refuse the Member who may edit
  // this source, whose static role holds `registry: []`.
  'src/applications/applications.controller.ts :: POST testRegistryLogin':
    'ApplicationsService.findOwnedForUpdate',
  'src/compose/compose.controller.ts :: PATCH update':
    'ComposeService.findOwnedForUpdate',
  'src/compose/compose.controller.ts :: PATCH saveEnvironment':
    'ComposeService.findOwnedForUpdate',
  'src/databases/libsql/libsql.controller.ts :: PATCH update':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/libsql/libsql.controller.ts :: PATCH saveEnvironment':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/mariadb/mariadb.controller.ts :: PATCH update':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/mariadb/mariadb.controller.ts :: PATCH saveEnvironment':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/mongo/mongo.controller.ts :: PATCH update':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/mongo/mongo.controller.ts :: PATCH saveEnvironment':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/mysql/mysql.controller.ts :: PATCH update':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/mysql/mysql.controller.ts :: PATCH saveEnvironment':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/postgres/postgres.controller.ts :: PATCH update':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/postgres/postgres.controller.ts :: PATCH saveEnvironment':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/redis/redis.controller.ts :: PATCH update':
    'BaseDatabaseService.findOwnedForUpdate',
  'src/databases/redis/redis.controller.ts :: PATCH saveEnvironment':
    'BaseDatabaseService.findOwnedForUpdate',

  // The project and environment `update` action, and these four rows are why it
  // exists: they said `'read'` and were recorded as **found, not endorsed** so
  // no later reviewer could cite them as approval. Each now runs one
  // `check*Access(…, 'update')`, claimed before the ownership lookup, through
  // its module's write-path entry.
  'src/environments/environments.controller.ts :: PATCH update':
    'EnvironmentsService.findOwnedForUpdate',
  'src/projects/projects.controller.ts :: PATCH update':
    'ProjectsService.findOneForUpdate',
  'src/tags/tags.controller.ts :: POST assignToProject':
    'TagsService.checkProjectForUpdate',
  'src/tags/tags.controller.ts :: DELETE removeFromProject':
    'TagsService.checkProjectForUpdate',

  'src/patch/patch.controller.ts :: POST cleanRepos':
    "PatchRepoService.cleanRepos' own owner-or-admin check, plus " +
    'PermissionService.checkInstanceAuthority on the platform-host branch',
  // `POST /templates/preview` was here, recorded as "found, not endorsed" — the
  // one row in this list that named no gate because there was none to name. It
  // left the list the way the docblock above says a row is allowed to: the
  // handler was given `@RequirePermission('service', 'create')` and
  // `TemplatesService.assertEnvironmentTarget`, so it is no longer undecorated and
  // an entry for it would now fail the third assertion below.

  // Enterprise: owner/admin plus a live license, or owner alone.
  'src/enterprise/custom-roles/custom-role.controller.ts :: POST create':
    'CustomRolesService.ensureEnterprise',
  'src/enterprise/custom-roles/custom-role.controller.ts :: PATCH update':
    'CustomRolesService.ensureEnterprise',
  'src/enterprise/custom-roles/custom-role.controller.ts :: DELETE remove':
    'CustomRolesService.ensureEnterprise',
  'src/enterprise/forward-auth/forward-auth.controller.ts :: PUT setAuthDomain':
    'ForwardAuthService.assertTargetAuthority',
  'src/enterprise/forward-auth/forward-auth.controller.ts :: DELETE removeAuthDomain':
    'ForwardAuthService.assertTargetAuthority',
  'src/enterprise/forward-auth/forward-auth.controller.ts :: POST deployOnServer':
    'ForwardAuthService.assertTargetAuthority',
  'src/enterprise/forward-auth/forward-auth.controller.ts :: DELETE removeOnServer':
    'ForwardAuthService.assertTargetAuthority',
  'src/enterprise/forward-auth/forward-auth.controller.ts :: POST enableOnDomain':
    'ForwardAuthService.assertDomainAccess',
  'src/enterprise/forward-auth/forward-auth.controller.ts :: POST disableOnDomain':
    'ForwardAuthService.assertDomainAccess',
  'src/enterprise/license/license.controller.ts :: PATCH updateEnterpriseSettings':
    'LicenseService.assertOwner',
  'src/enterprise/license/license.controller.ts :: POST activate':
    'LicenseService.assertOwner',
  'src/enterprise/license/license.controller.ts :: POST validate':
    'LicenseService.assertOwner',
  'src/enterprise/license/license.controller.ts :: POST deactivate':
    'LicenseService.assertOwner',
  'src/enterprise/license/license.controller.ts :: POST checkNow':
    'LicenseService.assertOwner',
  'src/enterprise/scim/scim.controller.ts :: POST generateToken':
    'ScimService.ensureEnterprise',
  'src/enterprise/scim/scim.controller.ts :: DELETE deleteProvider':
    'ScimService.ensureManager',
  // `enforceSSO` is one boolean on the `web_server_settings` singleton and the
  // sign-in screen renders no password form while it is on, so this is the
  // instance's login path rather than one Organization's setting. It
  // pinned `SettingsService.requireOwnerOrAdmin` — the organization-level gate
  // — as correct until then, which is the way a baseline rots that the four
  // assertions below do not catch: every word of it was true.
  'src/enterprise/sso/sso.controller.ts :: PATCH setEnforce':
    'SettingsService.requireInstanceAuthority, through SettingsService.updateEnforceSso',
  'src/enterprise/sso/sso.controller.ts :: POST addTrustedOrigin':
    'SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: PUT updateTrustedOrigin':
    'SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: DELETE removeTrustedOrigin':
    'SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: POST register':
    'SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: PUT update':
    'SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: DELETE remove':
    'SsoService.ensureEnterprise',
  // Proven domains: Hosted only, then SSO's own gate.
  'src/enterprise/sso/sso.controller.ts :: POST addProvenDomain':
    'ProvenDomainsService.ensureHostedEnterprise, then SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: POST checkProvenDomain':
    'ProvenDomainsService.ensureHostedEnterprise, then SsoService.ensureEnterprise',
  'src/enterprise/sso/sso.controller.ts :: DELETE removeProvenDomain':
    'ProvenDomainsService.ensureHostedEnterprise, then SsoService.ensureEnterprise',

  // Billing: owner/admin, and one unauthenticated route carrying a signature.
  'src/cloud/billing/billing-webhook.controller.ts :: POST handle':
    'StripeApi.constructEvent over the raw body and the stripe-signature header',
  'src/cloud/billing/billing.controller.ts :: POST createCheckoutSession':
    'BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: POST createCustomerPortalSession':
    'BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: POST setAddOns':
    'BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: POST upgrade':
    'BillingService.assertCloud plus BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: POST downgrade':
    'BillingService.assertCloud plus BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: DELETE keepBusiness':
    'BillingService.assertCloud plus BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: POST cancelTrial':
    'BillingService.assertCloud plus BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: DELETE keepTrial':
    'BillingService.assertCloud plus BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: PATCH updateInvoiceNotifications':
    'BillingService.assertCloud plus BillingService.assertAdmin',
  'src/cloud/billing/billing.controller.ts :: POST stopPaying':
    "StopPaying.stopPaying: the Paying Organization's owner or admin",

  // Unauthenticated by design, authenticated by a secret rather than a session.
  'src/git-providers/strategies/github/github.controller.ts :: POST webhook':
    'verifyGithubWebhookSignature over the raw body, keyed by installation',
  'src/notifications/notifications.controller.ts :: POST receive':
    "NotificationsService.receiveServerThreshold's stored metrics token",

  // Organizations: better-auth's own hasPermission, or a hand-rolled role check.
  'src/organizations/organizations.controller.ts :: POST create':
    "OrganizationsService.create's own owner-or-admin check",
  'src/organizations/organizations.controller.ts :: POST invite':
    "better-auth createInvitation's hasPermission({ invitation: ['create'] })",
  'src/organizations/organizations.controller.ts :: PATCH updateMemberRole':
    'OrganizationsService.assertMemberRole',
  'src/organizations/organizations.controller.ts :: DELETE removeMember':
    "better-auth removeMember's hasPermission({ member: ['delete'] })",
  'src/organizations/organizations.controller.ts :: POST createTeam':
    "better-auth createTeam's hasPermission({ team: ['create'] })",
  'src/organizations/organizations.controller.ts :: PATCH updateTeam':
    "better-auth updateTeam's hasPermission({ team: ['update'] })",
  'src/organizations/organizations.controller.ts :: DELETE removeTeam':
    "better-auth removeTeam's hasPermission({ team: ['delete'] })",
  'src/organizations/organizations.controller.ts :: POST addTeamMember':
    "better-auth addTeamMember's hasPermission({ member: ['update'] })",
  'src/organizations/organizations.controller.ts :: DELETE removeTeamMember':
    "better-auth removeTeamMember's hasPermission({ member: ['delete'] })",
  'src/organizations/organizations.controller.ts :: POST acceptInvitation':
    "AuthGuard plus better-auth's check that the invitation names the caller",
  'src/organizations/organizations.controller.ts :: DELETE removeInvitation':
    'OrganizationsService.assertMemberRole',
  'src/organizations/organizations.controller.ts :: POST setDefault':
    "OrganizationsService.setDefault's own membership check",
  'src/organizations/organizations.controller.ts :: PATCH update':
    'OrganizationsService.assertOwner',
  'src/organizations/organizations.controller.ts :: DELETE delete':
    'OrganizationsService.assertOwner',

  // Settings: the platform host, unconditionally.
  'src/settings/settings.controller.ts :: POST updateServerIp':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateBuildsConcurrency':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateRequestedPreviewMaxTtl':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateCloudRunsConcurrency':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateCloudRunTimeLimit':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateTraefikConfig':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateWebServerTraefikConfig':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateMiddlewareTraefikConfig':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateServer':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST assignDomain':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST updateLogCleanup':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST cleanAllDeploymentQueue':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST cleanMonitoring':
    'SettingsService.requireInstanceAuthority',
  'src/settings/settings.controller.ts :: POST reloadServer':
    'SettingsService.requireInstanceAuthority',
  // Two gates, in that order: the branding blob is one column on the same
  // singleton, so the authority is the instance's and the licence question is
  // asked of the instance organization rather than of whichever Organization
  // the caller is acting in (ADR-0013). This row said
  // `SettingsService.ensureEnterprise` and that method asked both halves of the
  // caller's own Organization, so the pin froze the defect as correct.
  'src/settings/settings.controller.ts :: PATCH updateWhitelabelingConfig':
    'SettingsService.requireInstanceAuthority, then SettingsService.requireInstanceLicense',
  // Settings: the platform host or one Server, forked on `serverId`. GPU setup
  // runs on any Server: that Server's organization owners and
  // admins, instance authority for the platform host, never an Agent.
  'src/settings/settings.controller.ts :: POST setupGpu':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST cleanUnusedImages':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST cleanUnusedVolumes':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST cleanStoppedContainers':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST cleanDockerBuilder':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST cleanDockerPrune':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST cleanAll':
    'SettingsController.maintenanceTargetAuthority',
  'src/settings/settings.controller.ts :: POST reloadTraefik':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: POST enableRequestMetrics':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: POST writeTraefikEnv':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: POST toggleDashboard':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: POST updateTraefikPorts':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: PUT updateDnsChallenge':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: DELETE removeDnsChallenge':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: POST toggleRequests':
    'SettingsController.traefikTargetAuthority',
  'src/settings/settings.controller.ts :: POST updateDockerCleanup':
    'DockerCleanupService.updateDockerCleanup',
  'src/settings/settings.controller.ts :: POST getUpdateData':
    'NONE: a POST-shaped read of this instance version against Docker Hub',

  // Users: every one resolves its target from the session, never from the body.
  'src/users/users.controller.ts :: PATCH updateProfile':
    "AuthGuard, and the write is keyed on the session's own user id",
  'src/users/users.controller.ts :: POST enableTwoFactor':
    "AuthGuard plus better-auth's re-verification of the caller's password",
  'src/users/users.controller.ts :: POST verifyTwoFactor':
    "AuthGuard, against the session's own pending factor",
  'src/users/users.controller.ts :: POST disableTwoFactor':
    "AuthGuard plus better-auth's re-verification of the caller's password",
  'src/users/users.controller.ts :: POST createApiKey':
    'AuthGuard, and better-auth refuses a body naming another userId',
  'src/users/users.controller.ts :: DELETE deleteApiKey':
    "AuthGuard, and another user's key reads as absent",
  'src/users/users.controller.ts :: POST revokeSession':
    "UsersService.revokeSession, scoped to the caller's own sessions",
  // The MCP endpoint is `@Public()` and authenticates an Agent key itself;
  // every tool call then runs the one check against the tool's declaration,
  // and a tool without one refuses to register (ADR-0023).
  'src/mcp/mcp.controller.ts :: POST handle':
    "McpDispatcher's PermissionService.checkPermission on each tool call, fail closed by ToolRegistry",
  // The two `@All` handlers that were always there and that the census began
  // reading later. Neither is new: both are `@Public()` catch-alls.
  // The Gateway is `@Public()` and authenticates an Agent key itself, then
  // runs the one check for `service: ['call']` on the AI model (ADR-0023's
  // fourth entry point).
  'src/gateway/gateway.controller.ts :: ALL handle':
    "gated in GatewayService: McpAuthenticator, then PermissionService.checkServiceAccess(ctx, applicationId, 'call')",
  // The Trace store proxy for a frame (ADR-0075): `@Public()` because the
  // sandboxed frame's requests carry no session. Its frame token names the
  // Member and credential it was minted for, and the service re-runs the one
  // check as them before anything is forwarded.
  'src/traces/traces.controller.ts :: ALL proxy':
    "TracesService.proxy: verifyTraceStoreFrameToken, AuthService.assertCredentialAlive, then PermissionService.checkServiceAccess(ctx, serviceId, 'read')",
  'src/mcp/mcp.controller.ts :: ALL refuse':
    'McpDispatcher, which answers every verb but POST with a 405 before any tool runs',
  'src/auth/auth.controller.ts :: ALL handle':
    "better-auth's own handler, which AuthController mounts: each of its endpoints authenticates its own caller",
};
