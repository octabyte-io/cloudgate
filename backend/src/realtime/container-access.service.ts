import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import type { WorkloadServiceType } from '../applications/application.schema';
import { findParentService } from '../common/service-parent';
import type { ServiceParent } from '../common/service-parent';
import { compose } from '../compose/compose.schema';
import type { ComposeType } from '../compose/compose.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { serviceScope } from '../deployments/service-scope';
import { rethrowIfHostUnreachable } from '../docker-ops/host-reachability';
import { environment } from '../environments/environment.schema';
import { previewDeployment } from '../preview-deployments/preview-deployment.schema';
import { project } from '../projects/project.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { stackVmRemoteId } from '../remote/stack-vm-remote';
import { TRACE_STORE_CONTAINER_PREFIX } from '../traces/trace-store-name';

/**
 * The Docker labels that trace a container back to a Service in this instance's
 * database — the definition of a **managed container** (CONTEXT.md).
 *
 * `com.docker.stack.namespace` is the third because a compose row with
 * `composeType: 'stack'` is deployed as a Swarm stack, whose containers carry
 * the stack namespace rather than a compose project, and whose
 * `com.docker.swarm.service.name` is `${appName}_${serviceName}` — matching no
 * Service row exactly. Without it every stack container reads as unmanaged,
 * which would deny its own owner the logs, the exact feature removal the ADR's
 * first consequence exists to prevent. `backups/commands/utils.ts` targets
 * stacks by the same label.
 *
 * Exported because `GET /docker/containers` asks `docker ps` for these three
 * by name so the same definition of "managed" decides which rows a listing may
 * show and which containers a socket may reach. A private copy over there is how
 * the listing and the acting came to disagree in the first place.
 *
 * **The same *authority* decides too, not only the same
 * definition.** An earlier fix gave an unmanaged container on the platform host
 * a second gate on the acting side and left the listing's alone, so for one
 * machine the two halves of that sentence came apart again with the definition
 * still shared — a row was offered and its id then refused. The listing asks
 * {@link ContainerAccessService.hasMachineAuthority}, the acting side's own
 * predicate, and asks *which rows are unmanaged* through {@link
 * ContainerAccessService.unownedAppNames} — the **resolution** of these labels
 * rather than their presence, which is the only reading that makes the two
 * halves of that sentence the same test. ADR-0013 carries the decision.
 */
export const OWNER_LABELS = [
  'com.docker.swarm.service.name',
  'com.docker.compose.project',
  'com.docker.stack.namespace',
] as const;

/**
 * A container this instance runs for itself: `cloudgate-traefik`,
 * `cloudgate-backend`, `cloudgate-console`.
 *
 * These are **unmanaged** — `deploy/install.sh` and `servers/server-setup.ts`
 * create them with `docker run --name` and no labels at all — so
 * {@link ContainerAccessService.authorizeAppNames} hands them to machine
 * `docker:read`, which is what made `cloudgate-traefik` reachable by id from
 * every organization while being in nobody's listing. The stated purpose is
 * that *"the same definition of 'managed' decides which rows a listing may show
 * and which containers a socket may reach"*, and this is the one name where the
 * two disagreed: `docker-ops.service.ts` held a private copy of this test and
 * used it to hide rows, and nothing used it to refuse a route.
 *
 * `cloudgate-monitoring` is excluded because it is a thing the operator sets up
 * and manages from the console, unlike the three above.
 *
 * **A Trace store is one of the platform's own too** (ADR-0028):
 * `cloudgate-trace-store-{kind}-{appName}`, a plain container with no owner
 * labels, holding one Service's traces and read only through the backend's
 * entitlement check. Its prefix is refused by name before the carve-out,
 * because the carve-out is a substring test and an `appName` is the
 * operator's: `cloudgate-trace-store-compose-cloudgate-monitoring` would
 * otherwise be handed to machine `docker:read`.
 *
 * **Matched by name, not by label, deliberately.** A label
 * (`io.cloudgate.platform`) is the better shape and is not what this is, because
 * `deploy/install.sh` skips an existing container by design — its own comment
 * says a re-run does not change one — so a label-based test would protect new
 * installs and silently not protect any that already exists. If the platform's
 * containers are ever relabelled on upgrade, this is the call site that should
 * move to the label.
 *
 * The test is only applied to a target that resolves to **no Service**, so an
 * Application a member legitimately called `my-cloudgate-thing` is unaffected —
 * it carries owner labels and is governed by entitlement like anything else.
 */
export const isPlatformContainerName = (name: string): boolean =>
  name.startsWith(TRACE_STORE_CONTAINER_PREFIX) ||
  (name.includes('cloudgate') && !name.includes('cloudgate-monitoring'));

/**
 * The one thing a refused container-addressed caller is told, on every
 * transport (ADR-0008).
 *
 * Not-entitled, unknown container and an ambiguous resolution were three
 * different 403 messages, so a caller could tell "that id is a real Service
 * belonging to someone else" from "that id belongs to nobody" — the enumeration
 * the ADR's one-close-code bullet forbids, arriving one layer above the socket.
 * The socket half of the same rule is `DENIED_CLOSE_REASON`
 * (`socket-access.ts`); this is its HTTP spelling, and the two are deliberately
 * near-identical prose.
 *
 * **The distinction is not lost, it moves to the journal** — every throw site
 * below writes what actually happened before it throws this, exactly as
 * {@link ContainerAccessService.resolveTarget}'s catch already did.
 * `permission.service.ts`'s `setMemberEntitlements` answers a foreign id and a
 * nonexistent one identically for the same reason; the two refusals had been
 * written to different rules.
 *
 * **The carve-out, so the branch that makes it is not read as a regression and
 * reverted.** This message answers the outcome of a resolution that
 * *ran*. A target on a machine that was never reached is answered **before**
 * the resolution, with a 503 naming the machine — `HOST_UNREACHABLE` and
 * *"This Server could not be reached"*, or `PLATFORM_HOST_UNREACHABLE` and
 * *"The platform host could not be reached"* for a container the platform host
 * runs, which is the arm split out so the console could stop telling an
 * operator to check an SSH key that is not used. See
 * {@link ContainerAccessService.resolveTarget}'s catch, and
 * `UNREACHABLE_CLOSE_CODE` for the socket spelling of the same split — one
 * close code for both arms there, because a socket's reason is the exception's
 * own message. That is
 * not a second vocabulary for a denial: nothing was looked up, so nothing about
 * this container's existence or its owner is disclosed, which is exactly the
 * reasoning ADR-0008 rests on. **On a Server that answers, every
 * refusal below still says this one sentence** — not-entitled, unknown
 * container, ambiguous resolution and the platform's own — and that is the
 * property the e2e pins assert as a pair rather than one at a time
 * (`docker-ops.e2e-spec.ts`). ADR-0008 carries the amendment.
 *
 * Kept as a `403 ForbiddenException` rather than moved to 404: the status is not
 * what carried the distinction, three call sites in `docker-ops.service.ts`
 * document 403 as the container refusal, and `ownedServerId` already answers
 * NotFound for a foreign *server* — reusing 404 here would make two different
 * refusals on the same route indistinguishable from each other, which is a
 * different bug.
 */
export const CONTAINER_DENIAL_MESSAGE = 'Container not found or not permitted';

/**
 * Which gate cleared a container-addressed caller: entitlement to the Service
 * that owns it, or machine-level Docker access because no Service does.
 *
 * Reported rather than kept private because the stats socket has to know: an
 * `appName` that names no Service is a *container's* name, and the container is
 * what must then be authorized instead.
 */
export type AccessBranch = 'service' | 'machine';

/**
 * What the caller asks to do to the Service that owns a **managed** container:
 * the action `checkServiceAccess` is asked for on the entitlement
 * branch.
 *
 * `read` for a log tail, a stats sample, a listing or an inspect; `update` for
 * an interactive shell, which writes inside the workload — and `service:
 * ['read']` means read only. A parameter rather than a raised default, because
 * the log and stats sockets stay where they are, and **required** for {@link
 * ContainerAccessService.authorizeAppNames}' own reason: a lease renewal is the
 * call site nobody remembers, and a default would renew a shell on `read`. The
 * machine branch does not read it: an unmanaged container keeps its
 * machine-level gate (ADR-0008, as amended).
 */
export type ServiceAction = 'read' | 'update';

/** What a Go template renders for a label key the object does not carry. */
const NO_VALUE = '<no value>';

// Both inspect commands are argv rather than command strings. The Go
// template is one word to `docker` — which is all the single quotes around it
// ever did — and the container id or service name is a word rather than
// something a shell parses, on top of the `isValidContainerId` check the
// gateways apply on the way in (§2.10).

/**
 * Reads the container's own name and its owner labels off one container in a
 * single `docker inspect`. The separator is a character no field here can
 * contain — the three labels are all Docker object names, and so is `{{.Name}}`.
 *
 * The name is read because it is what {@link isPlatformContainerName} tests;
 * a container that resolves to no Service is otherwise indistinguishable
 * from the platform's own.
 */
const inspectContainerCommand = (containerId: string): string[] => [
  'docker',
  'inspect',
  '--type',
  'container',
  '--format',
  `{{.Name}}|${OWNER_LABELS.map(
    (label) => `{{index .Config.Labels "${label}"}}`,
  ).join('|')}`,
  containerId,
];

/**
 * The same question asked of a **swarm service** rather than a container.
 *
 * With `runType=swarm` the socket's parameter is a service name, not a
 * container id — `docker service logs` takes one, and the console sends it for
 * every database and for a compose stack's services. A `swarm.Service` object
 * has no `.Config` at all, so inspecting it with the container template does
 * not return empty labels, it *errors*: without this branch every database's
 * logs would close 4003 for the very people who own them.
 *
 * A service names its Service two ways, and either may be the one that matches:
 * an Application's swarm service is called its `appName` outright, while a
 * stack's is `${appName}_${serviceName}` and carries the namespace label
 * instead.
 */
const inspectServiceCommand = (serviceName: string): string[] => [
  'docker',
  'inspect',
  '--type',
  'service',
  '--format',
  '{{.Spec.Name}}|{{index .Spec.Labels "com.docker.stack.namespace"}}',
  serviceName,
];

/**
 * One owner-label match: the name a container claimed, the Service it named and
 * the organization that Service belongs to. The organization is on the row
 * because the resolution is instance-wide and the caller is the one that refuses
 * the mismatch; the name is on it because the listing has to say *which row* was
 * foreign.
 */
type ServiceOwner = {
  appName: string;
  serviceId: string;
  organizationId: string;
  /**
   * The Service's own place: its Server, or `null` for the platform host — or
   * for a Cloud account, which `inCloud` tells apart. A preview's is its parent
   * Application's.
   */
  serverId: string | null;
  inCloud: boolean;
};

/**
 * Does this Service own what its label names **on this machine**?
 *
 * A label is a claim a container makes, and an `appName` is whatever its
 * customer chose, so on the platform host — the one machine every
 * Organization shares — a container carrying a label that names a Service is
 * that Service's only when the Service itself runs there: `serverId` null and
 * no Cloud account. A Service on a Server, or in a Cloud account, has no
 * container on the platform host, so its name there is somebody else's
 * container wearing it and goes to the machine branch, which asks for
 * instance authority.
 *
 * **A named Server is deliberately not held to the same test.** A Service's
 * swarm tasks may run on a worker that is a Server of its own, and that
 * Server is in the caller's Organization already (`ownedServerId`,
 * `findAuthorizedServer`), where the machine branch would hand the container
 * to the Organization's own `docker:read` anyway. The shared machine is where
 * the claim had to be checked.
 */
function ownsHere(owner: ServiceOwner, serverId: string | null | undefined) {
  return Boolean(serverId) || (owner.serverId === null && !owner.inCloud);
}

/**
 * One owner per Service: a container can carry two owner labels naming the
 * same Service, and that is one owner, not an ambiguity.
 */
function distinctByService(rows: ServiceOwner[]): ServiceOwner[] {
  return [...new Map(rows.map((row) => [row.serviceId, row])).values()];
}

/**
 * What a container-addressed socket is pointed at.
 *
 * The three travel together because they are one question — *which object, on
 * which machine, of which kind* — and no one of them answers it alone: `runType`
 * decides whether `containerId` names a container or a swarm service, and
 * `serverId` decides which daemon is asked. Splitting them back into positional
 * arguments is how the gateway came to pass two of the three.
 */
export type ContainerTarget = {
  containerId: string;
  serverId?: string | null;
  /** `swarm` means the parameter names a swarm service, not a container. */
  runType?: string | null;
};

/**
 * A Service named by its kind and its own id — the Shell tab's
 * listing asks {@link ContainerAccessService.authorizeService} about one. A
 * kind with a workload of its own: a Bucket has no container.
 */
export type ServiceAddress = {
  serviceType: WorkloadServiceType;
  serviceId: string;
};

/**
 * A Service addressed by its own id, once {@link
 * ContainerAccessService.authorizeService} has cleared it: where it
 * runs and how its containers are labelled.
 */
export type AddressedService = {
  appName: string;
  /** Its Server, or `null` for the platform host — or for a Cloud account. */
  serverId: string | null;
  /** A Compose stack's kind, `null` for every other Service. */
  composeType: ComposeType | null;
  /** It runs in a Cloud account, so there is no container of it to list. */
  inCloud: boolean;
};

/**
 * Who may reach a container-addressed socket (ADR-0008).
 *
 * Entitlement is enforced everywhere a Service is addressed by its own id, and
 * containers were the one address that reached a Service without it.
 *
 * So a container is resolved to the Service that owns it and gated on
 * `checkServiceAccess`. A container that resolves to no Service is *unmanaged*
 * — anything an operator started by hand — and is reached through machine-level
 * `docker:read` instead, because there is no Service to ask about, **plus
 * instance authority when the machine is the platform host** (see
 * {@link ContainerAccessService.authorizeAppNames}). The one exclusion is a
 * container **this instance runs for itself**
 * ({@link isPlatformContainerName}): those are refused outright on every
 * container-addressed route, because they have a purpose-built and more strictly
 * gated surface of their own in `/settings/traefik/*` and the runtime probes.
 *
 * Every denial says {@link CONTAINER_DENIAL_MESSAGE} and nothing else.
 * Not-entitled, unknown container, ambiguous resolution and the platform's own
 * were four distinguishable answers, which is the enumeration oracle ADR-0008's
 * one-close-code bullet forbids arriving one layer above the socket; the cause
 * goes to the journal instead.
 *
 * `docker:read` is deliberately *not* also required for a managed container.
 * `memberRole` grants `docker: []` in both products, and container logs exist
 * on no other transport, so requiring both would deny every base member the
 * logs of their own services — a feature removal delivered inside a security
 * fix.
 *
 * {@link authorizeContainer} answers the whole question and hands the
 * resolution back, because a socket needs the two halves apart afterwards: its
 * authorization lease re-runs {@link authorizeAppNames} every 30 seconds and
 * must never re-run the resolution — a `docker inspect` over SSH on a clock,
 * for an answer that cannot change (ADR-0012).
 */
@Injectable()
export class ContainerAccessService {
  private readonly logger = new Logger(ContainerAccessService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /**
   * Authorize a socket addressed by container id, answering **which Service
   * owns it**. Throws on every denial — unknown container, not entitled,
   * ambiguous resolution — and the gateway turns all of them into one close
   * frame.
   *
   * The appNames come back rather than staying inside because the caller has to
   * keep them: a socket renews its authorization by re-running
   * {@link authorizeAppNames} against this resolution for as long as it is open
   * (ADR-0012).
   */
  async authorizeContainer(
    ctx: PermissionCtx,
    target: ContainerTarget,
    action: ServiceAction,
  ): Promise<string[]> {
    const { name, appNames } = await this.resolveTarget(target);
    const branch = await this.authorizeAppNames(
      ctx,
      appNames,
      target.serverId,
      action,
    );
    // After the gate rather than before it, so the journal separates "this
    // caller would have been allowed and the object is ours" from "not
    // permitted anyway" — the wire frame is the same either way (ADR-0008).
    // `branch === 'machine'` is what confines this to a target no Service owns:
    // an Application a member happens to have named `my-cloudgate-thing`
    // resolves to its Service and never reaches here.
    if (branch === 'machine' && isPlatformContainerName(name)) {
      this.deny(
        `${name} is one of this instance's own — managed through /settings/traefik and the runtime probes, not through the container routes`,
      );
    }
    return appNames;
  }

  /**
   * The gate itself: entitlement for a managed container, machine access for an
   * unmanaged one, a denial when the resolution is ambiguous or lands in
   * another organization.
   *
   * **Every denial says the same thing** — {@link CONTAINER_DENIAL_MESSAGE} —
   * and the cause is journalled instead. The three messages that used to
   * be here told a caller "that name is a real Service belonging to someone
   * else" apart from "that name belongs to nobody", and one of them
   * interpolated the container's own owner labels onto the wire, which is the
   * thing being protected.
   *
   * **That sentence was not true at first, and the exception was the check in
   * front of the machine branch rather than any branch in it.** The
   * `docker: ['read']` this gate asks for refused in better-auth's own words —
   * *unauthorized to access resource "docker"*, which names the resource — while
   * every branch behind it answered {@link CONTAINER_DENIAL_MESSAGE}. So one
   * caller got two answers and could tell an unmanaged container from a
   * container somebody else's Service owns.
   *
   * **Reachable over HTTP, and the route that reaches it is not the one the
   * class of caller suggests.** The sockets cannot carry it — every close frame
   * is normalized (`socket-access.ts`) — and a base member holding `docker: []`
   * cannot either, because all three routes on `DockerOpsService` ask for a
   * `docker` statement of their own first and refuse them identically for every
   * id. What reaches it is a caller who passes the *route's* statement and fails
   * *this* one, and those are two different statements:
   * `containerOp`'s five verbs and `uploadFileToContainer` ask for
   * `docker: ['write']`, this branch asks for `docker: ['read']`, and
   * `validatePermissions` accepts `docker: ['write']` on its own. A licensed
   * custom role granted exactly that got the two sentences apart from
   * `POST /docker/containers/:id/stop` on any machine — pinned in
   * `docker-ops.e2e-spec.ts`, not inferred. Every judgement now goes through
   * {@link deny}; see {@link machineAccess} for why `PermissionService`'s
   * message was left alone.
   *
   * **And it was not true after that fix either, because the branch *beside*
   * the machine one had the same shape.** The fix wrapped the check in front of
   * the machine branch and left `checkServiceAccess` — the entitlement question
   * a **managed** container takes — throwing its own two sentences out of this
   * method verbatim: better-auth's *"You are not allowed to access resource:
   * service"* for a role holding no `service` action, and *"You don't have
   * access to this service"* for a member row that does not name the Service.
   * So ADR-0008's *not-entitled*, the first of the three refusals the
   * one-close-code bullet says are byte-identical, was the one that never was.
   * Same population as that fix's, one statement over: a licensed custom role
   * granted `docker: ['read', 'write']` and no `service` statement clears every
   * route on `DockerOpsService` and fails this branch, and could then partition
   * every container id on a shared machine into *my organization's* and *not*.
   * Pinned over the wire in `docker-ops.e2e-spec.ts` and at this seam in
   * `container-access.e2e-spec.ts`'s *"every refusal says the same thing"*,
   * which had only ever exercised the machine branch's two.
   *
   * **The audit found no second site**, and that is recorded
   * rather than left implied: every other id-bearing route reaches its statement
   * check *before* it resolves anything — either through the route's own
   * `@RequirePermission`, which is uniform across ids by construction, or on a
   * branch chosen by a caller-supplied `serverId` rather than by a resolved row
   * (`ClusterService`/`SwarmService.instanceOrServerScoped`,
   * `CertificatesService`, `ForwardAuthService.assertTargetAuthority`,
   * `PatchRepoService.cleanRepos`, `MonitoringService.findReadableTarget`,
   * `SchedulesService.checkAccess`). ADR-0008 carries the enumeration.
   *
   * Answers **which gate cleared the caller**, because that is not a detail the
   * callers can infer: the stats socket has to resolve an `appName` that named
   * no Service to the container it actually names, and authorize *that*.
   *
   * Public because it is what a lease renews (ADR-0012): every input it reads is
   * a mutable, row-level thing — a member row, a role, an `accessedServices`
   * array, a custom role's grants, the Service's own organization — and all of
   * them are indexed reads.
   *
   * **`serverId` is here rather than only on {@link authorizeContainer}, and
   * that placement is the whole of the fix.** The machine branch below now
   * asks a second question when the machine is the platform host, and that
   * question's inputs are member rows — exactly the mutable kind a lease
   * exists to re-read. A socket renews by re-running *this* method against the
   * resolution it captured (`container-logs.gateway.ts`,
   * `container-terminal.gateway.ts`, `docker-stats.gateway.ts`), so a check
   * placed in `authorizeContainer` instead would have been run once at connect
   * and never again: the caller keeps streaming for as long as they hold the
   * socket, which is the stream-after-revoke defect reintroduced one gate down.
   * It is a **required** parameter rather than an optional one for the same
   * reason — the compiler is what makes the next call site say which machine it
   * means, since a default would silently pick one and a renewal is the call
   * site nobody remembers.
   *
   * The parameter is the *target's* `serverId` and not a boolean, because
   * "which machine" is the question `checkServerAccess` already answers and
   * absence is its answer for the platform host (ADR-0008's second
   * consequence). Callers pass what they were given: `DockerOpsService` the id
   * `ownedServerId` resolved, the two container gateways the URL parameter
   * `findAuthorizedServer` cleared, and the stats gateway a documented
   * `PLATFORM_HOST` since it has no such parameter at all.
   */
  async authorizeAppNames(
    ctx: PermissionCtx,
    appNames: string[],
    serverId: string | null | undefined,
    action: ServiceAction,
  ): Promise<AccessBranch> {
    return this.authorizeOwners(
      ctx,
      appNames,
      await this.servicesNamed(appNames),
      serverId,
      action,
    );
  }

  /**
   * {@link authorizeAppNames} once the names are resolved: the verdict turns on
   * `owners` alone (and the caller and machine), which is what lets
   * {@link firstReadable} ask it once per distinct owner set. `appNames` is
   * read only by the journal line of an ambiguous resolution.
   */
  private async authorizeOwners(
    ctx: PermissionCtx,
    appNames: string[],
    owners: ServiceOwner[],
    serverId: string | null | undefined,
    action: ServiceAction,
  ): Promise<AccessBranch> {
    if (owners.length === 0) {
      await this.machineAccess(ctx, serverId);
      return 'machine';
    }

    // `appName` is `.unique()` per service table but not across them, so more
    // than one match fails closed rather than picking a first-match winner:
    // authorizing against either one would be authorizing against a Service
    // the caller may not be addressing.
    if (owners.length > 1) {
      this.deny(
        `labels ${appNames.join(', ')} resolve to ${owners.length} services`,
      );
    }

    // A Service placed anywhere but the platform host owns nothing on it, so
    // its label there is an unmanaged container's ({@link ownsHere}).
    if (!ownsHere(owners[0], serverId)) {
      await this.machineAccess(ctx, serverId);
      return 'machine';
    }

    await this.entitledTo(ctx, owners[0], action);
    return 'service';
  }

  /**
   * The entitlement branch on its own: **this caller may `action` this
   * Service**, or the one refusal. {@link authorizeOwners} asks it of the
   * Service a container's labels resolved to, and {@link authorizeService} of
   * the Service a caller addressed by id.
   *
   * A Service in another organization is refused here rather than handed to
   * `checkServiceAccess`, which would *pass*: its row-level check is skipped
   * for owners and admins, so an owner of one organization would be cleared
   * to reach another's container on a shared host. That is the original
   * complaint — reachable "regardless of which organization owns it" —
   * surviving inside its fix.
   *
   * **Translated, not passed through** — the same correction made
   * to the machine branch, on the branch beside it. `checkServiceAccess`
   * answers with one of two sentences of its own — better-auth's
   * *"You are not allowed to access resource: service"* when the role holds no
   * such `service` action, and *"You don't have access to this service"* when
   * the member row does not name the Service — and both used to travel out of
   * this class verbatim, so ADR-0008's *not-entitled* was the one refusal here
   * that did not say {@link CONTAINER_DENIAL_MESSAGE}. A licensed custom role
   * granted `docker: ['read', 'write']` and no `service` statement clears
   * every container-addressed route's own gate and fails this one, and could
   * then tell a container its own organization owns from one somebody else's
   * Service owns — the fifth answer of the class of which four were closed. The
   * same holds for a role holding `service: ['read']` and asked for
   * `update`: a shell is refused it in the one sentence.
   *
   * A `catch` rather than {@link refuses} because the cause is worth writing
   * down: which of the two branches refused is exactly what an operator needs
   * and exactly what the wire may not carry. Only a `ForbiddenException` is
   * read as a refusal; anything else is a failed read and travels
   * (ADR-0012, {@link refuses}' own distinction). `TemplatesService`'s
   * `assertEnvironmentTarget` is the same shape one resource over.
   */
  private async entitledTo(
    ctx: PermissionCtx,
    owner: Pick<ServiceOwner, 'appName' | 'serviceId' | 'organizationId'>,
    action: ServiceAction,
  ): Promise<void> {
    if (owner.organizationId !== ctx.session.activeOrganizationId) {
      this.deny(
        `${owner.appName} belongs to service ${owner.serviceId} in organization ${owner.organizationId}, not ${ctx.session.activeOrganizationId}`,
      );
    }
    try {
      await this.permissions.checkServiceAccess(ctx, owner.serviceId, action);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      this.deny(
        `${owner.appName} belongs to service ${owner.serviceId}, which user ${ctx.user.id} is not entitled to ${action} (${error.message})`,
      );
    }
  }

  /**
   * A container of a stack on its own Stack VM (ADR-0070), for the logs and
   * terminal sockets: the place comes from the stack the caller named, never
   * from a `serverId` in the URL, since a Stack VM is no Server. The caller
   * must be entitled to the stack (`action`), the container is inspected on
   * the Stack VM through its tunnel, and every owner its labels name must be
   * that stack: nothing else runs there, so anything else is refused.
   *
   * Answers the id the run target reaches the Stack VM by and the owner
   * names, which a lease renews with {@link authorizeAppNames} at that id.
   */
  async authorizeStackVmContainer(
    ctx: PermissionCtx,
    composeId: string,
    containerId: string,
    action: ServiceAction,
  ): Promise<{ remoteId: string; appNames: string[] }> {
    const [stack] = await this.db
      .select({
        appName: compose.appName,
        cloudAccountId: compose.cloudAccountId,
        organizationId: project.organizationId,
      })
      .from(compose)
      .innerJoin(
        environment,
        eq(compose.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(compose.composeId, composeId))
      .limit(1);
    if (!stack) this.deny(`stack ${composeId} does not exist`);
    await this.entitledTo(
      ctx,
      {
        appName: stack.appName,
        serviceId: composeId,
        organizationId: stack.organizationId,
      },
      action,
    );
    if (!stack.cloudAccountId) {
      this.deny(`stack ${composeId} has no Stack VM`);
    }
    const remoteId = stackVmRemoteId(composeId);
    const { appNames } = await this.resolveTarget({
      containerId,
      serverId: remoteId,
    });
    if (
      appNames.length === 0 ||
      appNames.some((appName) => appName !== stack.appName)
    ) {
      this.deny(
        `${containerId} on the Stack VM of ${composeId} is not that stack's (${appNames.join(', ') || 'no owner'})`,
      );
    }
    return { remoteId, appNames };
  }

  /**
   * Authorize an HTTP read **keyed on a Service's `appName`** rather than on a
   * container id: `GET /docker/containers/search`, `/by-label`,
   * `/stack` and `/service`.
   *
   * The same gate as {@link authorizeContainer}, one step shorter: there is no
   * container to inspect, because the caller has already said which name they
   * mean. So the name is resolved against the Service relation exactly
   * ({@link authorizeAppNames}), and a name that resolves to no Service is an
   * **unmanaged** container's and takes machine-level Docker access. On that
   * branch the platform's own names are refused as well, as
   * {@link authorizeContainer} refuses them: the listing routes would
   * otherwise hand `cloudgate-traefik`'s id to anyone holding `docker:read`.
   *
   * Every refusal is {@link CONTAINER_DENIAL_MESSAGE}, whether the Service is
   * foreign, not entitled, ambiguous, unmanaged without machine access or one
   * of the platform's own.
   */
  async authorizeAppName(
    ctx: PermissionCtx,
    appName: string,
    serverId: string | null | undefined,
  ): Promise<void> {
    const branch = await this.authorizeAppNames(
      ctx,
      [appName],
      serverId,
      'read',
    );
    if (branch === 'machine' && isPlatformContainerName(appName)) {
      this.deny(
        `${appName} is one of this instance's own — managed through /settings/traefik and the runtime probes, not through the container routes`,
      );
    }
  }

  /**
   * Authorize a read **addressed by a Service's own id** rather than by a
   * container or a name: the Shell tab's `GET
   * /docker/services/:serviceType/:serviceId/containers`, which finds the
   * Service's running containers for a caller who may hold no `docker` action at
   * all.
   *
   * The entitlement branch alone ({@link entitledTo}), asked for `action` —
   * the listing asks for `update`, the action the terminal socket asks for,
   * because whatever the listing offers the socket must accept. There
   * is no machine branch: an id names a Service or nothing, and nothing is a
   * refusal.
   *
   * The row is read **instance-wide** — `findParentService` with no
   * organization, the one "which Service is this" lookup (§1.4) — then
   * refused when it is in another organization, so a foreign id, an id that
   * names nothing and a Service the caller is not entitled to are one
   * sentence, {@link CONTAINER_DENIAL_MESSAGE},
   * and the cause goes to the journal (ADR-0008's one-close-code bullet).
   *
   * Answers where the Service runs and how its containers are labelled, which
   * is what the listing needs and nothing a caller could not already read off
   * the Service.
   */
  async authorizeService(
    ctx: PermissionCtx,
    target: ServiceAddress,
    action: ServiceAction,
  ): Promise<AddressedService> {
    // `findParentService` with no organization is the instance-wide read; its
    // NotFound becomes the one denial sentence like every other refusal here.
    let found: ServiceParent;
    try {
      found = await findParentService(
        this.db,
        null,
        target.serviceId,
        target.serviceType,
      );
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      this.deny(
        `${target.serviceType} ${target.serviceId} names no Service in this instance`,
      );
    }
    await this.entitledTo(ctx, found, action);
    return {
      appName: found.appName,
      serverId: found.serverId,
      composeType: found.composeType,
      inCloud: found.cloudAccountId !== null,
    };
  }

  /**
   * {@link authorizeAppNames} as a predicate over several candidate sets:
   * **the first one whose container this caller may read**, or -1.
   *
   * For a read that *filters* rather than refuses — `GET
   * /monitoring/metrics/containers` picks among stored series, each with the
   * names it could have been deployed under, and a series the caller may not
   * read has to be indistinguishable from one that is not there. A refusal
   * skips the set; any other failure still throws, because a database that
   * will not answer is not "you are not entitled" ({@link refuses},
   * ADR-0012).
   *
   * **Batched, because the caller chooses how many sets there are.** A short
   * substring matches every series on the host, so asking set by set cost a
   * caller who may read none of them one resolution per series. Every name is
   * resolved in one {@link ownersNamed} read, and the verdict — which turns on
   * the owner set alone ({@link authorizeOwners}) — is asked once per distinct
   * owner set, lazily and in order: the common case, the best set being the
   * caller's own, still costs one check. A foreign owner is refused without a
   * query, so the cost is bounded by the caller's own Services plus one
   * machine-branch check.
   *
   * **The platform's own series are not refused here, on purpose.** Unlike
   * {@link authorizeAppName} this does not add `isPlatformContainerName`: a
   * `cloudgate-*` series resolves to no Service and takes the machine branch,
   * which on the platform host already asks for instance authority (ADR-0013).
   * This leaves those series to that authority.
   */
  async firstReadable(
    ctx: PermissionCtx,
    candidateSets: string[][],
    serverId: string | null | undefined,
  ): Promise<number> {
    const rows = await this.ownersNamed([...new Set(candidateSets.flat())]);
    const verdicts = new Map<string, Promise<boolean>>();
    for (const [index, appNames] of candidateSets.entries()) {
      const names = new Set(appNames);
      const owners = distinctByService(
        rows.filter((row) => names.has(row.appName)),
      );
      const key = owners
        .map((owner) => owner.serviceId)
        .sort()
        .join(' ');
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = this.refuses(() =>
          this.authorizeOwners(ctx, appNames, owners, serverId, 'read').then(
            () => undefined,
          ),
        ).then((refused) => !refused);
        verdicts.set(key, verdict);
      }
      if (await verdict) return index;
    }
    return -1;
  }

  /**
   * Refuse a container-addressed caller: **one sentence on the wire and the
   * cause in the journal**, in one place (ADR-0008).
   *
   * A `logger.warn` and a `throw` written out at each site is what this
   * replaced, and the fifth site looked like this: the `docker`
   * statement check that stood in front of {@link authorizeAppNames}' machine
   * branch let better-auth's own *"unauthorized to access resource
   * \"docker\""* onto the wire, while every branch behind it answered
   * {@link CONTAINER_DENIAL_MESSAGE}. So a caller who cleared the route's own
   * statement and failed this one — a licensed custom role granted
   * `docker: ['write']` alone, on the five verbs and the upload — could tell an
   * unmanaged container from a container somebody else's Service owns, which is
   * a fifth answer of the class of which four were closed, and the one this
   * gate's own docblock claimed did not exist. Nothing in the compiler notices a
   * refusal that throws its own message; what stops a sixth is that there is now
   * one place to throw from.
   *
   * **The sixth arrived anyway, and it is why "one place to throw from" is not
   * the whole guarantee.** {@link authorizeAppNames}' service branch did
   * not throw a message of its own — it `await`ed `checkServiceAccess` and let
   * *that* method's two sentences travel out unchanged, which no amount of
   * funnelling this method's own throws could have caught. Every call out of
   * this class that can refuse now comes back through here: the statement check
   * ({@link machineAccess}), the instance-authority check
   * ({@link hasMachineAuthority}) and the entitlement check. A delegated refusal
   * is the shape to look for, not a second `throw`.
   *
   * **Judgements only.** `Refused container:` stays the prefix because it is
   * what `grep` finds and one journal fact coming back in
   * three shapes costs. {@link resolveTarget}'s catch deliberately does *not*
   * come through here: its `Could not inspect` line records a target the daemon
   * would not answer about rather than a decision this gate took, and
   * `container-sockets.e2e-spec.ts` reads the two prefixes apart on purpose.
   */
  private deny(detail: string): never {
    this.logger.warn(`Refused container: ${detail}`);
    throw new ForbiddenException(CONTAINER_DENIAL_MESSAGE);
  }

  /**
   * Machine-level access to an unmanaged container: the `docker` statement,
   * **and** instance authority when the machine is the platform host.
   *
   * The order is ADR-0008's followed by ADR-0013's, and it is unchanged from
   * when the two were written out inline — what changed is that the
   * statement's refusal is translated like everything else here instead of
   * carrying `PermissionService`'s own sentence out to the caller. Only the
   * *sentence* moves: `checkPermission` is untouched, deliberately, because
   * `docker: ['read']` is an organization capability whose refusal is the right
   * answer on `GET /docker/containers` and the swarm routes, where there is no
   * container id to leak. Making it quieter for everybody to close a leak in
   * one branch is the fix this rejected.
   */
  private async machineAccess(
    ctx: PermissionCtx,
    serverId: string | null | undefined,
  ): Promise<void> {
    const refused = await this.refuses(() =>
      this.permissions.checkPermission(ctx, { docker: ['read'] }),
    );
    if (refused) {
      this.deny(
        `machine-level docker:read is what an unmanaged container takes, and user ${ctx.user.id} does not hold it`,
      );
    }
    if (!(await this.hasMachineAuthority(ctx, serverId))) {
      this.deny(
        `an unmanaged container on the platform host takes instance authority, which user ${ctx.user.id} does not hold`,
      );
    }
  }

  /**
   * Did this check **refuse**, as opposed to fail?
   *
   * The one place the distinction is drawn on this surface, and it is ADR-0012's
   * own — `armAuthorizationLease` ends a lease for a `ForbiddenException` and
   * lets the lease stand for anything else, because a failed read is not a
   * refusal. A database that will not answer must not read as *"you are not
   * entitled"*: that is how a pool exhaustion would come out as a container
   * refusal on six surfaces at once.
   */
  private async refuses(check: () => Promise<void>): Promise<boolean> {
    try {
      await check();
      return false;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      return true;
    }
  }

  /**
   * The machine branch's second question, asked as a predicate: **do you
   * administer this instance** (ADR-0013).
   *
   * ADR-0008 sent an unmanaged container to machine-level Docker access and was
   * right about the question it was answering — *who governs a container no
   * Service owns* — but the machine it sent one to may be the platform host,
   * which belongs to no organization and hosts every organization's services.
   * There, the two things in front of this were both organization-level: the
   * `docker` statement is a capability owner, admin and any licensed custom role
   * can hold, and `checkServerAccess` returns for an absent `serverId` by
   * design. So an owner or admin of **any** organization could `stop`, `kill`,
   * `restart`, `rm -f` or `docker cp` into an operator's own sidecar on the
   * shared machine, read its logs, and open an interactive `docker exec` shell
   * in it — and `cloudgate-monitoring`, which
   * {@link isPlatformContainerName} deliberately excludes, was in that set by
   * construction. ADR-0013 post-dates ADR-0008 and answers the other question,
   * *who governs a resource every organization shares*; this is the two
   * reconciled on this surface, and it is the same split used for
   * `PatchRepoService.cleanRepos` and `CertificatesService.create`.
   *
   * **A named Server keeps organization authority and nothing about it moves.**
   * `serverId` there names a row in the caller's own organization, an
   * organization's owner administers its own fleet, and ADR-0013's second
   * consequence is explicit that this is the right question for that branch.
   * `!serverId` is the *contract* for "the platform host" rather than a guess
   * about which machine is which: a `server` row that happens to point
   * at the same box is still an organization's own Server, reached over SSH
   * through its row, and nothing in this codebase tries to recognise the
   * platform host by address.
   *
   * **The refusal is translated rather than passed through, and that is not
   * cosmetic.** `checkInstanceAuthority`'s own sentence names the platform host,
   * so letting it out here would tell a caller *"that id resolved to no
   * Service"* apart from `CONTAINER_DENIAL_MESSAGE`'s *"that id belongs to a
   * Service you may not reach"* — the enumeration oracle once closed and
   * ADR-0008's one-close-code bullet forbids, reopened by the fix. So the cause
   * goes to the journal like every other cause here and the wire says the one
   * sentence, through {@link deny}. Only a `ForbiddenException` is read as a
   * refusal; anything else propagates, because a failed read is not a refusal
   * ({@link refuses}, ADR-0012's own distinction and `armAuthorizationLease`'s).
   *
   * **A predicate rather than a throwing check, and public.** The
   * *listing* asks the same question — `DockerOpsService.getContainers` hides
   * the platform host's unmanaged rows from whoever this refuses, so that the
   * rows it offers are the containers the routes will act on (the stated
   * purpose, ADR-0013). A listing has no one row to refuse, so what it needs is
   * the answer and not the exception; {@link machineAccess} is where the answer
   * becomes a refusal. Asked **once for a whole response** rather than per row,
   * because `serverId` is resolved once by `ownedServerId` and instance
   * authority cannot differ between rows of one listing — which is why this is
   * not shaped like {@link foreignAppNames}, whose question genuinely is
   * per-name.
   */
  async hasMachineAuthority(
    ctx: PermissionCtx,
    serverId: string | null | undefined,
  ): Promise<boolean> {
    if (serverId) return true;
    return !(await this.refuses(() =>
      this.permissions.checkInstanceAuthority(ctx),
    ));
  }

  /**
   * Which of these appNames name **no Service at all**, anywhere in this
   * instance's database — the listing's spelling of *unmanaged*.
   *
   * **A label is not a Service, and that gap is what this closes.** The listing
   * reads owner labels off `docker ps` and the acting path resolves them against
   * the Service relation, so the two words "unmanaged" are not the same test: a
   * container an operator started with `docker compose -p my-monitoring up`
   * carries `com.docker.compose.project`, which is a label the parse counts and a
   * name {@link servicesNamed} finds nothing for. Filtering on *no owner label*
   * would drop every `docker run --name` sidecar — the platform's own,
   * `cloudgate-monitoring`, an operator's bare container — and leave that row
   * listed while every route refused its id, which is the listing's own defect
   * surviving inside its fix for the rows hardest to notice.
   *
   * Answers by **appName** rather than by Service for {@link foreignAppNames}'
   * reason: the listing decides row by row and needs the name that told it which
   * row. The two are asked one after the other over the same set, so this costs a
   * second {@link ownersNamed} — paid **only** by a caller the narrowing applies
   * to, since `DockerOpsService.getContainers` asks it only when
   * {@link hasMachineAuthority} said no. An instance admin and every named-Server
   * listing pay nothing.
   *
   * **Asked of a machine**, because the acting side is: on the platform
   * host a name whose Service runs somewhere else is unmanaged there
   * ({@link ownsHere}), so it is counted unowned here too and the row is not
   * offered to a caller the routes would refuse.
   */
  async unownedAppNames(
    appNames: string[],
    serverId: string | null | undefined,
  ): Promise<Set<string>> {
    const owned = new Set(
      (await this.ownersNamed(appNames))
        .filter((owner) => ownsHere(owner, serverId))
        .map((owner) => owner.appName),
    );
    return new Set(appNames.filter((name) => !owned.has(name)));
  }

  /**
   * Which of these appNames name a Service in **another** organization.
   *
   * The listing's half of the same question the sockets ask. A row in
   * `GET /docker/containers` carries its owner labels; the ones naming a Service
   * outside the caller's organization are the managed containers that are not
   * the caller's to see, and the rest — a label naming nothing, or naming a
   * Service of the caller's own — stay. So this answers by **appName**, not by
   * Service: the listing has to decide row by row, and
   * {@link authorizeAppNames}'s deduplication by service id would throw away the
   * name that told it which row.
   *
   * A name that resolves into two organizations at once comes back as foreign,
   * matching {@link authorizeAppNames}'s fail-closed answer to an ambiguous
   * resolution — a row the acting half would refuse has no business being listed
   * as reachable.
   */
  async foreignAppNames(
    ctx: PermissionCtx,
    appNames: string[],
  ): Promise<Set<string>> {
    const owners = await this.ownersNamed(appNames);
    return new Set(
      owners
        .filter(
          (owner) => owner.organizationId !== ctx.session.activeOrganizationId,
        )
        .map((owner) => owner.appName),
    );
  }

  /**
   * The Services these appNames name, **anywhere in this instance's database**.
   *
   * Instance-wide, not organization-scoped, because that is what makes a
   * container *managed* (CONTEXT.md). Filtering by the caller's organization
   * would make another organization's container resolve to nothing, and
   * "resolves to nothing" is the unmanaged branch — which hands it to anyone
   * holding `docker:read`. The organization comes back on the row so the caller
   * can refuse the mismatch outright.
   */
  private async servicesNamed(appNames: string[]): Promise<ServiceOwner[]> {
    return distinctByService(await this.ownersNamed(appNames));
  }

  /**
   * The raw name → owner rows behind {@link servicesNamed} and
   * {@link foreignAppNames}, one row per matching `(appName, service)` pair.
   *
   * Undeduplicated on purpose: the socket gate wants one row per Service (two
   * labels naming the same Service are one owner), the listing wants one row per
   * name. Splitting the query out rather than copying it into docker-ops is
   * §1.4's "did this need to be new?" — the answer was no.
   *
   * Two lookups, because a preview deployment's `appName` is unique and lives
   * in its own table rather than among the eight. Entitlement for a preview is
   * its parent Application's — without that the service gate would silently
   * break every preview's logs and terminal. Two constant queries whatever the
   * name count: never one per container, which is the N+1 the feeds exist to
   * avoid.
   */
  private async ownersNamed(appNames: string[]): Promise<ServiceOwner[]> {
    if (appNames.length === 0) return [];

    const service = serviceScope(this.db);
    const services = await this.db
      // Through `sql` for its type: a union subquery's columns arrive untyped,
      // the same reason `environment-feeds.ts` re-projects them.
      .select({
        appName: sql<string>`${service.appName}`,
        serviceId: sql<string>`${service.serviceId}`,
        organizationId: project.organizationId,
        serverId: sql<string | null>`${service.serverId}`,
        cloudAccountId: sql<string | null>`${service.cloudAccountId}`,
      })
      .from(service)
      .innerJoin(
        environment,
        eq(service.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(inArray(service.appName, appNames));

    const previews = await this.db
      .select({
        appName: previewDeployment.appName,
        serviceId: previewDeployment.applicationId,
        organizationId: project.organizationId,
        serverId: application.serverId,
        cloudAccountId: application.cloudAccountId,
      })
      .from(previewDeployment)
      .innerJoin(
        application,
        eq(previewDeployment.applicationId, application.applicationId),
      )
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(inArray(previewDeployment.appName, appNames));

    return [...services, ...previews].map(({ cloudAccountId, ...owner }) => ({
      ...owner,
      inCloud: cloudAccountId !== null,
    }));
  }

  /**
   * The appNames this target claims **and the name of the object itself**, read
   * **on the machine being addressed**. A remote target's come back over the
   * remote-execution layer; reading them locally would authorize one machine's
   * socket against another machine's containers.
   *
   * The name is on the answer because the appNames alone cannot tell the
   * platform's own containers from an operator's hand-started one — both resolve
   * to no Service — and {@link isPlatformContainerName} is what separates them.
   * ADR-0008's "labels are read on the machine being addressed" now
   * covers a name too, for the same reason and by the same command.
   *
   * A target that cannot be inspected **on a machine that answered** — it does
   * not exist, or docker refused — is a denial rather than an empty resolution:
   * falling through to the unmanaged branch would hand out a container that may
   * well be managed on a machine this process cannot see.
   *
   * **A machine that did not answer at all is not a denial, and the narrowing
   * of the sentence above to the reachable arm is deliberate.** Before, this
   * catch answered {@link CONTAINER_DENIAL_MESSAGE} for every failure, so an
   * unreachable Server's containers were refused *"not found or not permitted"*
   * — an authorization claim about a machine nothing spoke to, on the config
   * route, the five lifecycle verbs, the upload and the three container sockets.
   * That does not weaken the one-sentence rule: its guarantee is about the
   * outcome of a resolution that **ran**, and a transport failure happens before
   * any resolution — no id was looked up, no label was read, no owner row was
   * queried — so answering *not reached* discloses nothing about whether this
   * container exists or who owns it. On a Server that answers, not-entitled,
   * unknown-id and ambiguous-resolution stay byte-identical, and the enumeration
   * oracle stays closed. `ExecError.exitCode` is what tells the two apart and it
   * is a real signal rather than a convenient one; see `isTransportFailure`,
   * which reads a rejection that is not an `ExecError` as "not a transport
   * failure" on purpose, so `docker inspect` having run and said *no such
   * container* still refuses.
   *
   * **This is the one step a socket captures at connect instead of re-running**
   * (ADR-0012). It is the only expensive one — a `docker inspect`, over the
   * remote-execution layer for a remote Server — and the only one that cannot
   * go stale: a container's labels are fixed for its life and Docker does not
   * reuse container ids, so re-inspecting could only ever return what it
   * returned the first time. The exception is a **swarm-addressed** target,
   * whose parameter is a service name rather than an id: `docker service rm foo`
   * followed by another Organization creating its own `foo` would leave a
   * captured resolution pointing at the wrong Service. Removing the service
   * does **not** end `docker service logs --follow` (it was measured still
   * running after `docker stack rm`), so the log socket asks whether the
   * service is still listed every `SERVICE_PRESENCE_INTERVAL_MS` and closes
   * when it is not. That bounds the window to one interval rather than closing
   * it, and is the one place this decision trades correctness for cost.
   */
  async resolveTarget(
    target: ContainerTarget,
  ): Promise<{ name: string; appNames: string[] }> {
    const command =
      target.runType === 'swarm'
        ? inspectServiceCommand(target.containerId)
        : inspectContainerCommand(target.containerId);

    let stdout: string;
    try {
      ({ stdout } = await execOnServer(
        this.remoteExec,
        target.serverId,
        command,
      ));
    } catch (error) {
      // The transport arm first, and it throws its own 503. It writes
      // the host's own words to the journal itself, so the local `warn` below
      // stands for the reachable arm alone and no failure is logged twice.
      rethrowIfHostUnreachable(this.logger, target.serverId, error);
      this.logger.warn(
        `Could not inspect ${target.containerId}: ${(error as Error).message}`,
      );
      throw new ForbiddenException(CONTAINER_DENIAL_MESSAGE);
    }

    const fields = stdout
      .trim()
      .split('|')
      .map((value) => value.trim());

    // A container's `{{.Name}}` comes back with a leading slash; a swarm
    // service's `{{.Spec.Name}}` does not, and is also its own first owner
    // name — which is why the swarm template is unchanged and the container
    // template gains a field rather than the two being made symmetrical.
    const [name, ...rest] = fields;
    const owned = (target.runType === 'swarm' ? fields : rest).filter(
      (value) => value !== '' && value !== NO_VALUE,
    );

    return {
      name: (name ?? '').replace(/^\//, ''),
      appNames: owned,
    };
  }
}
