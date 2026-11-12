/**
 * **What a nested relation on a service read is entitled to include**.
 *
 * The rule, stated once:
 *
 * > A relation included on a service read carries the related row **minus its
 * > secrets**, withheld at the finest granularity that removes the secret and
 * > nothing else — the whole column where the column *is* the credential, the
 * > field where the column is mostly configuration. Which columns those are is
 * > not decided at the call site: it is derived from the schema by
 * > `test/coding-standards/service-read-relations.spec.ts`, so a new
 * > `encryptedText` column on any of these tables goes red by name.
 *
 * **Why this is a different question from ADR 0019, which was left open.**
 * ADR 0019 governs the route that *owns* a secret: `GET /settings/web-server`
 * answers for the `web_server_settings` row, so it replaces each secret with
 * its presence and a screen reads the flag. A nested relation is not that
 * route. `GET /applications/:id` answers for an Application; the `server`,
 * `registry`, `github` and `customGitSSHKey` rows hanging off it are context,
 * reached by a caller who was authorized for the *Service* —
 * `checkServiceAccess(ctx, id, 'read')`, which the base `memberRole` satisfies
 * with one id in `accessedServices`, while that same role holds
 * `sshKeys: []`, `registry: []`, `gitProviders: []` and `server: []`. So
 * entitlement to a Service is not entitlement to facts about the credentials it
 * references, and a nested relation is not the place a secret's presence gets
 * reported: `GET /registries/:id` and `GET /ssh-keys` are. Presence flags are
 * ADR 0019's answer *at the owning route* and would be a second disclosure
 * here.
 *
 * The one nested relation that does carry a presence flag is `server`, and it
 * earns it the way ADR 0019 says: `metricsConfig` is returned because the blob
 * is the host's sampling configuration and only `server.token` authenticates
 * anything, so the *field* is what is withheld — and a field withheld inside a
 * returned column has a depth for its flag to stand at, which is exactly the
 * condition ADR 0019 attaches ("positioned at the depth the field was, not
 * lifted to the top of the row"). A whole withheld column has no such depth
 * left, and lifting `hasPrivateKey` onto an Application's nested SSH key would
 * be the lift the ADR forbids. `servers/nested-server.ts` holds that half.
 *
 * **Why one declaration and not a projection per call site.** There are nine
 * reads — `GET /applications/:id`, `GET /compose/:id` and six database engines
 * through `BaseDatabaseService.findOne` — and the hand-written per-site
 * denylists they shipped with were wrong in **four** places at once. They
 * stripped `github.clientSecret` and `github.privateKey` and not
 * `github.webhookSecret`, which `GithubService.sanitize` strips with the
 * sentence *"handing it out would let any reader forge one"*; `gitlab`'s two
 * tokens and not `gitlab.secret`, the OAuth application secret its own
 * `SanitizedGitlab` withholds; the `server` row whole; and
 * `customGitSSHKey` was `true` — the entire `ssh_key` row, `privateKey`
 * included, the very secret that never leaves the server. Four
 * misses across nine sites is the `stripSshPrivateKey` finding again at a
 * different scale: the list was *named for the columns somebody happened to
 * think of*, and there was nowhere for the next one to be declared. This file
 * is that place, and the spec next to it is what checks the place is full.
 *
 * Keyed by **table** rather than by relation name on purpose: two relations
 * resolve to `registry` (pull and push credentials) and two to `server`
 * (`server` and `buildServer`), and a per-relation list would let those pairs
 * drift apart.
 *
 * `as const` is load-bearing. Drizzle narrows the relation's result type from
 * the literal `false`s, so a column withheld here is *absent from the inferred
 * row* — a controller cannot answer with it and a reader cannot reach it —
 * and renaming or dropping any column below breaks the build. What the types
 * still cannot say is that the list is complete; that is the spec's job, for
 * the reason ADR 0019 gives about `Omit`.
 *
 * ------------------------------------------------------------------
 *
 * **`server` is deliberately not in this object, and the guardrail for it is
 * weaker than the one above. Stated rather than left to be discovered.**
 *
 * Every entry here withholds a whole *column*, which is a thing a drizzle
 * `columns` list can say and the inferred row can therefore lack. `server`'s
 * secret is one field inside a column that has to be returned — see
 * `servers/nested-server.ts` — so there is nothing for a `columns` list to
 * withhold, and the projection happens *after* the query, at the call site.
 * That leaves the eight `server: true` / `buildServer: true` includes protected
 * two different ways:
 *
 * - **Structurally, for the six database engines.**
 *   `BaseDatabaseService.findOne` declares `Promise<SanitizedDatabaseRead<T>>`
 *   once, on the base class the six engines share and do not override, so
 *   dropping the `nestedServer(...)` wrap there is a build failure. One
 *   annotation covers six reads because there is one method.
 * - **By hand, for `ApplicationsService.findOne` and `ComposeService.findOne`.**
 *   Their return types are inferred from a drizzle relational query, so a
 *   forgotten wrap **compiles**, and `test/coding-standards/service-read-relations.spec.ts`
 *   is what catches it.
 *
 * **Making the second case structural was considered and rejected on cost.**
 * Annotating those two the way the base class is annotated means naming the
 * inferred row — `BuildQueryResult<typeof schema, typeof application, …>` over
 * a hoisted `as const` relation config, restated whenever the `with` tree
 * changes — which puts a paragraph of drizzle generics in front of the two
 * reads this rule exists to keep legible, and buys a compile error the spec
 * already produces by name. The cheaper-looking alternative, a generic wrapper
 * whose type refuses an answer carrying a raw `Server`, was rejected for a
 * better reason than cost: a new call site can forget to call the wrapper
 * exactly as easily as it can forget `nestedServer`, so it relocates the
 * hand-written step instead of removing it. What actually has to hold is that
 * **a read cannot be added without something going red**, and that is a
 * property of the spec rather than of a type — so the spec is where it was
 * closed. It scans `src` for any `with:` block naming one of these relations
 * and reds on one it does not know, *and* reds on a read declared as answering
 * a caller that its own assertions never drive, which is the escape hatch the
 * two halves used to leave between them.
 *
 * **`realtime/server-access.ts` is not this seam, and that is measured rather
 * than assumed.** `findAuthorizedServer` hands the raw row from
 * `ServersService.findOne` to four gateways, and all four read exactly one
 * field off it — `sshKeyId` in the container-logs, container-terminal and
 * server-terminal gateways, `organizationId` in the setup gateway — to open an
 * SSH connection or to build a permission context. None frames the row, and a
 * socket that did would be answering with `server:read`'s own row on a
 * transport that never asked for `server:read`, which is a new decision rather
 * than a leak of this one. Recorded here because the *shape* is the same and a
 * future gateway that streams a row is where it would stop being true.
 */
export const withoutSecrets = {
  /** `customGitSSHKey`. The secret: the private half of a deploy keypair. */
  sshKey: { columns: { privateKey: false } },
  /** `registry` and `buildRegistry` — the pull and the push credentials. */
  registry: { columns: { password: false } },
  /**
   * `webhookSecret` is what makes an inbound GitHub delivery provable, so a
   * reader of it can forge a push and trigger a deploy of anything the
   * connection reaches — `GithubService.sanitize` has withheld all three since
   * that function existed.
   */
  github: {
    columns: { clientSecret: false, privateKey: false, webhookSecret: false },
  },
  /** `secret` is the OAuth application secret, beside the two tokens. */
  gitlab: {
    columns: { secret: false, accessToken: false, refreshToken: false },
  },
  gitea: {
    columns: { clientSecret: false, accessToken: false, refreshToken: false },
  },
  bitbucket: { columns: { appPassword: false, apiToken: false } },
} as const;
