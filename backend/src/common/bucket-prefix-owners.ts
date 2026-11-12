import { ForbiddenException } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { serviceScope } from '../deployments/service-scope';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';
import type {
  PermissionCtx,
  PermissionService,
} from '../rbac/permission.service';

// The one resolver and the one rule for "whose objects live under this bucket
// prefix", shared by `backups/`, `volume-backups/` and `destinations/`.
//
// **In `common/`, and the move is about direction rather than
// tidiness.** The rule was first written inside `BackupsService`, then pulled out to
// `backups/bucket-prefix-owners.ts` so `volume-backups/` could share it, which
// worked because `volume-backups/` already imports `backups/` (its module, its
// run recorder, its command builders). The listing rule needs the same rule in
// `destinations/`, and there the edge runs the other way: `BackupsModule`
// imports `DestinationsModule`, `backups/commands/utils.ts` imports
// `destinations/rclone-exec`, and `volume-backups/` imports both. An
// authorization rule reached *upward* out of `destinations/` would sit above the
// module edge every other file in the pair honours, and it would be the only
// import of its kind in the tree. `common/credential-refs.ts` is the precedent
// and its docblock names the same reason — *"the only in-set alternative was one
// of those modules importing the other's list and resolver, which inverts the
// dependency direction the tree keeps"* — and `common/owned-server.ts`'s is what
// says why a *third* copy was never on the table: five copies of an ownership
// lookup drifted apart and the sixth was never written at all, which was an
// earlier security bug (§1.4).
//
// **Nothing here imports a feature module's values, and that is load-bearing
// rather than incidental.** `bucketPrefixCandidates` lives in
// `backups/commands/utils.ts`, so expanding a prefix into its candidates *here*
// would make this file `common/` → `backups/` → `destinations/` → `common/`, a
// cycle at the directory level closed by the very import that was supposed to
// avoid one. So every function below takes candidates its caller has already
// expanded — which is also the shape {@link servicesOwningPrefixes} and
// {@link assertPrefixOwnersEntitled} already had, and the shape that lets both
// backup modules' unit specs drive the decisions without standing up the
// eight-table union.

/**
 * A Service that claims a bucket's top-level prefix as its own — the answer
 * both restore gates authorize a key against.
 */
export interface BucketPrefixOwner {
  serviceId: string;
  /** The `appName` the prefix matched, which is what makes it this Service's. */
  appName: string;
  organizationId: string;
}

/**
 * The Services, anywhere in this instance, whose objects live under one of
 * these top-level bucket prefixes.
 *
 * **This is the one resolver for both modules, and the narrower list is
 * gone.** This query was first written inside `BackupsService` over six tables —
 * the five engines plus `compose`, which are the only Services that can own a
 * *database dump* — and its docblock recorded the cost: *"an `application`'s or
 * a `redis`' prefix reads as unowned here, and a volume-backup tarball parked
 * under one is therefore restorable by anyone the level lets through"*. For
 * `volume-backups` that gap is not an edge, it is the common case: a volume
 * backup can be owned by any of the eight service types — volumes belong to
 * Applications and Compose stacks as much as to databases — and its tarballs
 * land under the owner's `appName` exactly as a dump does. So the resolver had
 * to widen, and widening it in two places was never an option: the two kinds of
 * object share one bucket, so a rule that disagreed with itself between them
 * would just be the same reach with an extra step (§1.4).
 * `BackupsService.servicesOwningPrefixes` is a one-line delegation to this now,
 * so a dump and a tarball are authorized by the same eight-table answer and the
 * same rule in {@link assertPrefixOwnersEntitled}.
 *
 * **Eight tables, and taken from `serviceScope` rather than restated.**
 * `deployments/service-scope.ts` already publishes the eight service tables as
 * one relation carrying `serviceId`, `appName` and `environmentId`, which is
 * exactly this query's shape; `PermissionService.resolveGrantIds` and
 * `ContainerAccessService.ownersNamed` both reach it the same way, joining
 * environment → project for the organization. `SERVICE_TABLES` in
 * `common/service-parent.ts` is the other candidate — exported for exactly
 * this kind of caller — and it loses on *shape*
 * rather than on reachability: that map is a per-type dispatch for looking up
 * one row by id, where this asks one question of all eight tables at once and
 * wants them as a single relation to join. Taking it would mean iterating the
 * map and issuing eight queries to rebuild the union `serviceScope` already is.
 *
 * **Deliberately *not* organization-scoped, unlike every other lookup either
 * caller makes.** A Destination's bucket is an organization-wide resource but
 * nothing stops two organizations pointing Destinations at the *same* bucket,
 * so a prefix owned by another organization's Service has to come back and be
 * refused rather than read as unowned — which is what an org filter here would
 * make it. {@link assertPrefixOwnersEntitled} is where that refusal is.
 */
export async function servicesOwningPrefixes(
  db: DrizzleDB,
  names: string[],
): Promise<BucketPrefixOwner[]> {
  if (names.length === 0) return [];
  const service = serviceScope(db);
  return (
    db
      // Through `sql` for its type: a union subquery's columns arrive untyped,
      // the same reason `environment-feeds.ts` re-projects them.
      .select({
        serviceId: sql<string>`${service.serviceId}`,
        appName: sql<string>`${service.appName}`,
        organizationId: project.organizationId,
      })
      .from(service)
      .innerJoin(
        environment,
        eq(service.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(inArray(service.appName, names))
  );
}

/**
 * Refuses unless the caller is entitled to **every** Service that claims the
 * prefix an object key sits under — the rule both restore gates share.
 *
 * **The fact it rests on.** Every object either module writes lands at
 * `{bucket}/{appName}/{prefix}/{name}`: `BackupsService.buildRunScript` builds
 * that path for a dump and `VolumeBackupsService.run` builds it for a tarball,
 * and both pick the leading segment out of their own `s3AppName` — the owning
 * Service's `appName`, or `{appName}_{serviceName}` for one stack service of a
 * compose backup. So a key *names the Service that wrote it*, and this asks that
 * Service's own entitlement question. A caller entitled to Service A can no
 * longer name Service B's object and load B's data into A.
 *
 * **Every candidate that resolves must be entitled, not merely one of them, and
 * the reason is an attack.** `appName` is unique per *table*, so the same name is
 * free in another table: a caller who may create Services could mint a compose
 * stack whose `appName` is an existing engine's, and a rule satisfied by any one
 * entitled owner would then let their own row vouch for the victim's prefix.
 * `bucketPrefixCandidates`' `_`-trimming widens the same ambiguity honestly. The
 * false refusal this buys is narrow and explainable: a compose stack `a` with
 * stack service `b` is refused its own objects at `a_b/` if some *other* Service
 * is genuinely named `a_b`.
 *
 * **A prefix no Service claims is allowed, and that is the decision rather than
 * a gap.** The alternative — an allow-list of the caller's own Services' prefixes
 * and nothing else — is a *stricter* rule that refuses the two cases the feature
 * exists for. A Service destroyed and recreated gets a fresh `appName`, so its
 * predecessor's objects sit under a prefix that now belongs to nobody, and
 * refusing those is refusing disaster recovery at the moment it is needed —
 * the volume-backup fix's "hardest case to explain". An object uploaded to the bucket by hand, or
 * produced before this platform managed the Service, is the same shape. Neither
 * is a way back to a *live* Service's data, because a live Service's prefix
 * always resolves to it.
 *
 * **Why a *positive* prefix rule, where the volume-backup fix rejected a negative one.**
 * It asked the same question of `volumeName` and refused to bind it, because the
 * binding available there was negative — refuse a name some *other* Service's
 * mount row claims — and its false refusals landed on the case hardest to
 * explain, with a refusal that could not say why without becoming an oracle for
 * another Service's mounts (§2.2, ADR-0008). The key has a stronger fact to
 * stand on: the platform itself *writes* it, under the owner's own `appName`.
 * So the rule is about where a Service's own objects live rather than about
 * where anybody else's do, and it names nothing the caller is not entitled to.
 *
 * **Cross-organization is refused rather than filtered**, because
 * {@link servicesOwningPrefixes} deliberately does not scope by organization —
 * see its docblock for why a shared bucket makes that the only safe answer.
 *
 * **Level `'read'` on the owning Service, not `'update'`.** What the caller is
 * doing to the *source* is reading its object; the write lands on the target,
 * which both `restore` routes have already claimed `'update'` on.
 *
 * Taking the resolved owners rather than resolving them is what lets both
 * modules' unit specs drive this decision without standing up the eight-table
 * union — the resolution is a Postgres join and the decision is what is in
 * question.
 */
export async function assertPrefixOwnersEntitled(
  permissions: PermissionService,
  ctx: PermissionCtx,
  owners: BucketPrefixOwner[],
): Promise<void> {
  for (const owner of owners) {
    if (owner.organizationId !== ctx.session.activeOrganizationId) {
      throw new ForbiddenException("You don't have access to this backup file");
    }
    await permissions.checkServiceAccess(ctx, owner.serviceId, 'read');
  }
}

/**
 * One top-level bucket prefix a listing wants to offer, with the `appName`s it
 * could be — `bucketPrefixCandidates(prefix)`, expanded by the caller for the
 * reason this file's header gives.
 */
export interface BucketPrefixClaim {
  /** The listing's own leading key segment, which is what a refusal drops. */
  prefix: string;
  /** Every `appName` that segment could be naming. */
  candidates: string[];
}

/**
 * {@link assertPrefixOwnersEntitled}' rule applied to a **listing**: which of
 * these prefixes hold objects that are not this caller's to see.
 *
 * **A filter, not a gate, and the asymmetry is deliberate.** A refusal here
 * would turn a browse box into an oracle for which prefixes exist, and each of
 * the three callers is one request over a whole bucket rather than one decision
 * about one object. So the entries drop out and the answer stays a listing —
 * which is also what keeps the console honest: `BackupFilesCard` and
 * `TarballPicker` both offer a restore per row, and every row they offer is now
 * one the matching `restore` will accept. That is the managed-listing property for
 * containers, one resource over: *the same definition decides which rows a
 * listing may show and which objects an action may reach.*
 *
 * **Decided from `findMember` rather than by calling
 * `PermissionService.checkServiceAccess` per prefix**, on `ProjectsService.list`'s
 * precedent and the invitation in `findMember`'s own docblock: a listing can
 * carry hundreds of entries and a per-row gate would be a per-row pair of
 * queries. The consequence, stated rather than discovered: this consults the
 * row-level half only, so a role holding the listing's own read action and no
 * `service` action still sees its own Services' objects, where a
 * `checkServiceAccess` call would have hidden everything from it. Widening a
 * *read* refusal is not what any of these rules are about.
 *
 * **A prefix no Service claims stays listed**, for the reason
 * {@link assertPrefixOwnersEntitled} argues at length and both restores
 * landed on: a Service destroyed and recreated gets a fresh `appName`, so its
 * predecessor's objects sit under a prefix that belongs to nobody, and a tarball
 * uploaded by hand belongs to nobody either. Dropping those rows would take
 * disaster recovery out of the picker at the moment it is needed, which is the
 * line between a bound and a feature removal. It is not a way back to a live
 * Service's objects, because a live Service's prefix always resolves.
 *
 * **Another Organization's prefix is refused here rather than passed through**,
 * matching the gate: two Organizations can point Destinations at one bucket, so
 * an owner that comes back from a different `organizationId` is refused for
 * everybody including this Organization's own owner — which is why the
 * privileged short-circuit is inside the predicate rather than in front of it.
 *
 * Returns the prefixes to *drop* rather than the rows to keep, because the three
 * callers' rows are three different shapes — `RcloneFile.Path`,
 * `DestinationObject.key` — and each already knows how to read its own leading
 * segment. Sharing the decision and not the row type is what stopped this
 * becoming a fourth spelling of the rule (§1.4).
 */
export async function refusedBucketPrefixes(
  db: DrizzleDB,
  permissions: PermissionService,
  ctx: PermissionCtx,
  claims: BucketPrefixClaim[],
): Promise<Set<string>> {
  const owners = await servicesOwningPrefixes(
    db,
    claims.flatMap((claim) => claim.candidates),
  );
  // Before `findMember`, so a bucket holding nothing this instance claims costs
  // the listing no second query.
  if (owners.length === 0) return new Set();

  const memberRecord = await permissions.findMember(ctx);
  const privileged =
    memberRecord.role === 'owner' || memberRecord.role === 'admin';
  return new Set(
    claims
      .filter(({ candidates }) => {
        const claimed = new Set(candidates);
        return owners.some(
          (owner) =>
            claimed.has(owner.appName) &&
            (owner.organizationId !== ctx.session.activeOrganizationId ||
              !(
                privileged ||
                memberRecord.accessedServices.includes(owner.serviceId)
              )),
        );
      })
      .map(({ prefix }) => prefix),
  );
}
