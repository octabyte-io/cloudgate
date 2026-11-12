import { ContainerAccessService } from '../../src/realtime/container-access.service';

/**
 * Which authority every method on `ContainerAccessService` takes, enumerated
 * (ADR-0013).
 *
 * **This is deliberately an enumeration**, on `gateway-leases.e2e-spec.ts`'s
 * and `clean-repos-authority.spec.ts`'s reasoning, and it is the per-module
 * guard ADR-0013's closing sentence asks for in place of the tree-wide one
 * measured as unachievable. A type cannot express "and this one asks who
 * administers the instance", so nothing in the compiler notices a method here
 * that reaches the machine branch without asking. That was the defect: the
 * branch was reached from three HTTP routes and three sockets and asked two
 * organization-level questions about a machine belonging to no organization.
 *
 * The keys are asserted against `ContainerAccessService.prototype`, so a new
 * method fails here by name until whoever adds it writes down the boundary it
 * takes. The behaviour behind each sentence is asserted in
 * `container-access.e2e-spec.ts` — a real second Organization with a real
 * owner row is the only thing that can tell these boundaries apart, and that
 * needs a database.
 */
const BOUNDARIES: Readonly<Record<string, string>> = {
  // The container-addressed entry point. Resolves the target on the machine
  // being addressed, then delegates the whole question to authorizeAppNames —
  // so its own boundary is that one, plus the refusal of a container this
  // instance runs for itself.
  authorizeContainer:
    "authorizeAppNames on the target's serverId, plus isPlatformContainerName",

  // A container of a stack on its own Stack VM (ADR-0070), for the logs and
  // terminal sockets: the place is the stack's, never a URL serverId.
  authorizeStackVmContainer:
    'checkServiceAccess on the stack named, then every owner its labels name on its Stack VM must be that stack',

  // The gate itself, and the one a socket's lease re-runs (ADR-0012). Three
  // boundaries in one method, selected by the resolution: entitlement to the
  // owning Service; machine `docker:read` for an unmanaged container on a named
  // Server; and `docker:read` plus checkInstanceAuthority for an unmanaged
  // container on the platform host.
  authorizeAppNames:
    "checkServiceAccess when a Service owns it (on the platform host, only a Service placed there); docker:['read'] on a named Server; docker:['read'] plus checkInstanceAuthority on the platform host",

  // The HTTP reads keyed on one appName: `containers/search`,
  // `by-label`, `stack` and `service`. The singular spelling once removed for
  // having no caller is back with four, and it is not a copy: it delegates the
  // whole question to authorizeAppNames and adds the platform-name refusal
  // on the machine branch, as authorizeContainer does.
  authorizeAppName:
    'authorizeAppNames on the one name, plus isPlatformContainerName on the machine branch',

  // The metrics read's filter: authorizeAppNames as a predicate over
  // many series at once, so a series the caller may not read is skipped rather
  // than refused, and the resolution is paid once per owner set, not per series.
  firstReadable:
    'authorizeOwners per distinct owner set, as a predicate: a refusal skips the set, anything else rethrown',

  // authorizeAppNames past its resolution: the whole verdict, given the owners.
  authorizeOwners:
    'private: entitledTo when a Service owns it, machineAccess when none does or, on the platform host, when it runs elsewhere, refused when two do',

  // The entitlement branch on its own: the Service in the caller's
  // organization, and checkServiceAccess for the action the caller names —
  // `read` for logs, stats and listings, `update` for a shell. Both refusals
  // through `deny`.
  entitledTo:
    'private: same organization, then checkServiceAccess for the action asked, translated to CONTAINER_DENIAL_MESSAGE',

  // The Shell tab's listing, addressed by a Service's own id: the row
  // read instance-wide, then entitledTo. No machine branch — an id that names
  // nothing is a refusal, in the one sentence.
  authorizeService:
    'entitledTo on the Service the id names, for the action asked; an id naming nothing refused',

  // The listing's half of the same question: which of these names belong to
  // another organization. No authority of its own — `getContainers` asks for
  // `docker:['read']` before it calls this, and this only filters rows.
  foreignAppNames: 'no authority of its own: a filter over an authorized read',

  // Beside it, and no authority of its own either: which of these
  // names name no Service at all. It is what makes the listing's word
  // "unmanaged" the same test as `authorizeAppNames`' — the resolution rather
  // than the presence of an owner label.
  unownedAppNames:
    'no authority of its own: a resolution the caller turns into a filter',

  // The machine branch's whole gate, private because every caller reaches it
  // through authorizeAppNames. Both halves refuse through `deny`,
  // so neither puts its own sentence on the wire.
  machineAccess:
    "private: docker:['read'] plus hasMachineAuthority, both translated to CONTAINER_DENIAL_MESSAGE",

  // The platform-host boundary asked as a predicate. **Public**: the
  // listing needs the answer rather than the exception, because
  // `getContainers` hides the platform host's unmanaged rows from whoever the
  // acting path would refuse (ADR-0013).
  hasMachineAuthority:
    'checkInstanceAuthority when there is no serverId; true outright for a named Server',

  // Not a boundary of its own — the two below are how a boundary refuses and
  // how a refusal is told from a failure. Enumerated because this file asserts
  // the whole prototype, and a helper with no entry is indistinguishable from a
  // gate somebody forgot to write down.
  deny: 'not a boundary: the one refusal, one sentence and one journal line',
  refuses:
    'not a boundary: ForbiddenException read as a refusal, anything else rethrown',

  // Resolution rather than authorization: a `docker inspect` on the machine
  // being addressed, run before the gate and captured for a socket's lifetime.
  // Its own guard is the caller's — the gateways validate the id (§2.10) and
  // clear the Server first.
  resolveTarget:
    'no authority of its own: the resolution its callers then authorize',

  // Private lookups, instance-wide by design (CONTEXT.md): scoping them to the
  // caller's organization would make another organization's container resolve
  // to nothing, which is the unmanaged branch.
  servicesNamed:
    'private: the instance-wide resolution, deduplicated by Service',
  ownersNamed: 'private: the instance-wide resolution, one row per name',

  constructor: 'not a method',
};

describe('ContainerAccessService', () => {
  it('gives every method a named authority boundary', () => {
    expect(
      Object.getOwnPropertyNames(ContainerAccessService.prototype).sort(),
    ).toEqual(Object.keys(BOUNDARIES).sort());
  });
});
