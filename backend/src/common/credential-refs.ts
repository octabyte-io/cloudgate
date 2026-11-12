/**
 * The one loop that resolves a request's credential-bearing parent ids inside
 * the caller's organization before any of them is written.
 *
 * **What broke first.** The rule arrived one module at a time. The first fix answered it
 * for a single id — `sshKeyId` on a Server, delegated to
 * `SshKeysService.findOne`. The second answered it for eight more, across
 * `ApplicationsService` and `ComposeService`, and had to state it **twice**:
 * the only in-set alternative was one of those modules importing the other's
 * list and resolver, which inverts the dependency direction the tree keeps. Two
 * statements of one rule is the shape `common/owned-server.ts`'s docblock is
 * about — five copies of an ownership lookup that drifted, plus a sixth that
 * was never written at all, which was an earlier security bug. This module is the same
 * argument made before the drift rather than after it.
 *
 * **What the extraction is, precisely.** The *mechanism* moves here; the
 * *column list* stays each module's own. A module hands this function three
 * things — its list, a resolver bundle keyed on that list, and the body — and
 * gets back the ids that were authorized. The two properties the second fix built by hand
 * are kept rather than replaced, because they are the argument for a single
 * home and not a substitute for one:
 *
 * - {@link CredentialRefResolvers} is a total `Record` over the list, so a name
 *   added to a list with no lookup beside it **does not compile**.
 * - The other direction — an `*Id` added to a DTO and forgotten in the list —
 *   is not expressible in the type system and is held by a spec per module
 *   (`test/applications/application-credential-refs.spec.ts`,
 *   `test/compose/compose-credential-refs.spec.ts`). Those are unchanged by the
 *   move: they assert about their module's list and their module's DTO.
 *
 * **No `PermissionCtx` parameter, and that is the load-bearing decision.** The
 * obvious signature takes a ctx and passes it to each lookup, and it would have
 * closed the door on the one shape a caller in `backups/` needs: `destinationId`
 * on a Backup reaches `DestinationsService.findOneWithCredentials(ctx, …)` from
 * four call sites, but `runScheduled` deliberately reaches
 * `findForScheduledRun(row.destinationId)` with no ctx and no organization
 * filter, because the row was organization-checked when it was written and a
 * scheduled run has no session to check it against. A ctx-bearing helper cannot
 * express that without a nullable ctx threaded through every lookup — which is
 * the shape `findParentService` already regrets, its `organizationId: string |
 * null` existing only so a system run can pass `null`. A bundle of closures
 * says it once, at the seam that knows: a request-scoped caller closes over its
 * `ctx`, a system run closes over nothing. `backups/` is not wired to this yet —
 * that module was held by another agent when this landed — but nothing here has
 * to change when it is.
 *
 * **Sequential, not `Promise.all`.** A body naming two foreign ids gets one
 * deterministic refusal — the first in *list* order, not V8's key ordering and
 * not whichever rejection settled first — and the second lookup is never
 * reached. A neighbouring fix was about a write that had to say which of
 * two ids it authorized.
 *
 * **A foreign id is refused byte-identically to an id that exists nowhere**,
 * and that is a property of the resolvers rather than of this loop: each one is
 * the owning service's own `findOne`, whose `where` is `id = ? AND
 * organization_id = ?`, so both misses take the same branch and raise the same
 * `NotFoundException`. That equality is the §2.2 / ADR-0008 requirement — a 404
 * saying *"Registry not found"* beside a 404 saying *"that registry is in
 * another organization"* would pass a status check and be an enumeration oracle
 * for every credential on the instance. This function therefore does not catch,
 * wrap or reword anything: the refusal the owning module wrote is the refusal
 * the caller gets.
 *
 * A plain exported function rather than an `@Injectable()`, on
 * `common/service-parent.ts`'s and `common/owned-server.ts`'s precedent: a
 * provider holding no state would need wiring in every module that asks one
 * question.
 */

/**
 * One lookup per credential-bearing parent id, each answering with the id it
 * authorized.
 *
 * A total `Record` over the module's list on purpose — this is the type that
 * makes the list load-bearing, because a name added to the list with no lookup
 * here fails to compile. That is the direction the second fix established and the one
 * worth keeping: it is why an eighth credential id cannot arrive unresolved.
 *
 * Each lookup returns the id rather than the row, so nothing a resolution
 * touches can leak into the write. The lookups in the tree are all `findOne`
 * rather than `findOneWithCredentials`/`findOneWithPrivateKey`: resolving an id
 * has no business decrypting a secret (the first fix's decision, one id over).
 */
export type CredentialRefResolvers<Ref extends string> = Record<
  Ref,
  (id: string) => Promise<string>
>;

/**
 * A request body as far as {@link resolveCredentialRefs} is concerned.
 *
 * `null` and `undefined` are both admitted and both mean "no row to resolve",
 * for reasons that are not the same. The update schemas are `.partial()`, so
 * `undefined` is *"this PATCH does not mention the column"* and `null` is
 * *"detach"* — resolving either would refuse both a PATCH that only renames the
 * Service and the only way to remove a registry from one.
 */
export type CredentialRefBody<Ref extends string> = Partial<
  Record<Ref, string | null | undefined>
>;

/**
 * Resolve each credential-bearing parent id `data` carries through the resolver
 * that owns its row, and hand back the ids that were authorized.
 *
 * The return value is what the caller must write from — `.set({ ...data,
 * ...authorized })` — so the row is written from the authorization result
 * rather than from the request. Equal by construction today, each lookup
 * filtering on the very id it was given; it is here because it is what stops
 * `.set(data)` being the thing that decides, which is the same sentence one table
 * over: *"the row is written from the id that was authorized"*.
 *
 * See this file's own docblock for why there is no `ctx` parameter, why the loop
 * is sequential, and why nothing here catches a resolver's refusal.
 */
export async function resolveCredentialRefs<Ref extends string>(
  refs: readonly Ref[],
  resolvers: CredentialRefResolvers<Ref>,
  data: CredentialRefBody<Ref>,
): Promise<Partial<Record<Ref, string>>> {
  const authorized: Record<string, string> = {};
  for (const ref of refs) {
    const id = data[ref];
    // See CredentialRefBody: `undefined` skips, `null` detaches, and neither
    // names a row to resolve.
    if (typeof id !== 'string') continue;
    authorized[ref] = await resolvers[ref](id);
  }
  return authorized as Partial<Record<Ref, string>>;
}

/**
 * Every parent id `updateApplicationSchema` accepts that names a
 * **credential-bearing** row, in the order they are resolved (moved here).
 *
 * Each of these columns is a foreign key into an organization-owned table —
 * `ssh_key`, `registry` and the four git-provider detail tables — and the
 * constraint requires only that the row *exist*. `findOwnedForUpdate` scopes
 * the Application; nothing scoped what was being attached to it, and
 * `ApplicationsService.findDeployable` then loads all seven as relations "with
 * credentials intact" and the engine authenticates with them. So an owner of
 * organization A could `PATCH` their own Application with organization B's
 * `registryId` or `customGitSSHKeyId` or `githubId` and get a build that pushed
 * to B's private registry, or cloned B's private repository as B — the
 * `customGitSSHKeyId` arm through `SourceCloneService`'s `sshKey:
 * application.customGitSSHKey`, which puts the victim's decrypted private key
 * into the clone command. What the caller got was never the plaintext but the
 * **use** of it, which is the first fix's consequence reached through a Service rather
 * than through a Server.
 *
 * **The list is the resolver bundle's key set, not a parallel copy of it.**
 * `ApplicationsService.credentialRefResolvers` is typed
 * `CredentialRefResolvers<ApplicationCredentialRef>`, so a name added here
 * without a lookup does not compile, and
 * `test/applications/application-credential-refs.spec.ts` asserts the other
 * direction — that no `*Id` in `updateApplicationSchema` is missing from this
 * list. An eighth credential id can therefore not arrive unresolved.
 *
 * **It lives here rather than on `ApplicationsService` for a second reason
 * beyond the shared home**, and it is the one that made an earlier fix spell seven
 * strings out by hand: `RollbackContext` in `rollbacks/rollback.schema.ts` must
 * omit exactly these seven keys, and importing them from a *service* would
 * point a table definition at one — a real cycle, `db/schema`'s barrel already
 * reaching `rollback.schema.ts`. This file imports nothing, so that
 * `Omit<…, ApplicationCredentialRef>` is now legal. `ApplicationsService`
 * re-exports the name so `RollbacksService.EXCLUDED_FROM_CONTEXT`, which
 * spreads it, keeps compiling from where it already imports it.
 *
 * **Order matters and is this list's, not V8's key ordering.** A body naming two
 * foreign ids is refused for the first of them, deterministically.
 *
 * `buildServerId` is deliberately absent: it is the eighth parent id in the same
 * body and it is `checkServerAccess`' job, which answers about `server`
 * rather than about a credential and has an `undefined`-means-platform-host
 * contract this loop must not imitate. `gitlabProjectId` is absent because it is
 * GitLab's own numeric project id, not a row on this instance.
 */
export const APPLICATION_CREDENTIAL_REFS = [
  'githubId',
  'gitlabId',
  'giteaId',
  'bitbucketId',
  'customGitSSHKeyId',
  'registryId',
  'buildRegistryId',
] as const;

/** One of {@link APPLICATION_CREDENTIAL_REFS}. */
export type ApplicationCredentialRef =
  (typeof APPLICATION_CREDENTIAL_REFS)[number];

/**
 * Every parent id `updateComposeSchema` accepts that names a
 * **credential-bearing** row, in the order they are resolved (moved here).
 *
 * The exposure is {@link APPLICATION_CREDENTIAL_REFS}' reached one table over: a
 * Compose stack's `customGitSSHKeyId` and four git-provider ids are loaded back
 * by the deployment engine and authenticated with, so a stack pointed at another
 * organization's provider clones their private repository as them.
 *
 * **Five rather than the Application's seven**, and the difference is real: a
 * Compose stack has no `registryId`/`buildRegistryId` (a stack's images name
 * their own registries inside the file) and no `buildServerId`. The five that
 * are here are the same five names, resolved through the same owning services,
 * for the same reason — which is a fact about today and **not** an invariant
 * this file asserts. A Compose-only credential id is a normal thing to add, so
 * nothing here says the list is a subset; what holds it is
 * `test/compose/compose-credential-refs.spec.ts`, which asserts against
 * `updateComposeSchema` rather than against the Application's list.
 *
 * The two lists are separate exports of one home rather than one export shared
 * by two modules for that reason: they answer about two different DTOs, and
 * the second fix's alternative — `compose/` importing `applications/` — is what a shared
 * export would reintroduce with an extra step.
 *
 * `gitlabProjectId` is deliberately absent: it is GitLab's own numeric project
 * id, not a row on this instance.
 */
export const COMPOSE_CREDENTIAL_REFS = [
  'githubId',
  'gitlabId',
  'giteaId',
  'bitbucketId',
  'customGitSSHKeyId',
] as const;

/** One of {@link COMPOSE_CREDENTIAL_REFS}. */
export type ComposeCredentialRef = (typeof COMPOSE_CREDENTIAL_REFS)[number];
