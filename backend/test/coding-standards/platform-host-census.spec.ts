import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { SERVICE_TABLES } from '../../src/common/service-parent';
import type { PlatformHostWork } from '../../src/instance-mode/platform-host-refusal';

/**
 * **Census (b): every way onto the platform host is classified** (ADR-0053).
 *
 * On a Self-hosted instance an absent `serverId` means the platform host, and
 * `checkServerAccess(null)` admits it on purpose (ADR-0008). On the Hosted
 * instance that box is shared, so every place that can put a customer's
 * Service or command there must refuse it — and the places that manage the
 * box must not. Nothing in the type system tells the two apart: both call
 * `checkServerAccess` with an id that may be missing. So this file lists
 * **every caller of `checkServerAccess`, every caller of the registry login
 * probe (`probeLogin`, which takes the host to run on and runs on the platform
 * host when handed none) and every insert of a Service row** in `src/`, each
 * with its verdict. A new one fails here until its author
 * picks; one that went away fails until its entry does.
 *
 * The verdicts:
 *
 * - **host management (instance authority)** — the absent-id branch is the
 *   Instance organization managing the box (Traefik, settings, Docker
 *   cleanup, host certificates and monitoring, swarm, unmanaged containers),
 *   or the id is required and the host has its own gated route. It keeps
 *   working on the Hosted instance.
 * - **refuses the platform host in hosted mode** — the site creates a
 *   Service or runs a check, so on the Hosted instance it calls
 *   `InstanceMode.refusePlatformHost` with `work`'s sentence. The test holds
 *   that the enclosing function says `refusePlatformHost(`. An entry with
 *   `until` names the ticket that wires it; that ticket removes
 *   `until`, and this file then asks for the call.
 * - **follows its Service's place** — ADR-0053's own carve-out: work on a
 *   Service that already exists (its build Server, its GPUs, its Domain, its
 *   preserved images) runs where that Service is. With no Service created on
 *   the host, it has nowhere to land, so it needs no refusal of its own.
 *   Except for a Service in a Cloud account, whose `serverId: null` reads
 *   as the host: `cloud-service-exec-census.spec.ts` holds every exec site
 *   to that.
 *
 * Sites are named `file#function`, the function being the method or
 * top-level function the call is written in, so moving a call within a
 * function is not a change here, and a second call in a function already
 * classified is covered by its entry.
 */

const HOST_MANAGEMENT = 'host management (instance authority)';
const REFUSES = 'refuses the platform host in hosted mode';
const FOLLOWS = "follows its Service's place";

/**
 * The tickets that wire a seam this file already lists. None
 * left since the last was wired; a ticket that lists a seam before wiring
 * it names itself here.
 */
type Ticket = never;

type Verdict =
  | { readonly verdict: typeof HOST_MANAGEMENT; readonly why: string }
  | {
      readonly verdict: typeof REFUSES;
      readonly work: PlatformHostWork;
      readonly until?: Ticket;
      readonly why: string;
    }
  | { readonly verdict: typeof FOLLOWS; readonly why: string };

const CENSUS: Readonly<Record<string, Verdict>> = {
  // --- Seams 1 and 2 --------------------------------------------
  'environments/deploy-target.ts#resolveOnHost': {
    verdict: REFUSES,
    work: 'services',
    why: 'The Deploy target: no default to the platform host, and no choosing it (seam 1).',
  },

  // --- Service creates (seam 3) ----------------------------------
  'applications/applications.service.ts#insertApplication': {
    verdict: REFUSES,
    work: 'services',
    why: "An Application or AI model create, and its row's insert: a console create with no Server is refused by `runServerFor` (seam 2), a body's own `null` and a plan's create with neither a Server nor a Cloud account here (seam 3).",
  },
  'compose/compose.service.ts#insertCompose': {
    verdict: REFUSES,
    work: 'services',
    why: 'POST /compose and its row: an absent serverId goes straight to the host.',
  },
  'compose/compose-stack-vms.ts#insertRow': {
    verdict: FOLLOWS,
    why: "A stack's row on its own Stack VM, never the platform host: a plan's create in the Cloud account and region it names (ADR-0070), or a console create in the Deploy target's, which refuses a body naming a Server or the platform host first (#1372).",
  },
  'databases/common/database-service.ts#insertDatabase': {
    verdict: REFUSES,
    work: 'services',
    why: "All six database engines, and their row; a plan's cloud create names its Cloud account.",
  },
  'buckets/buckets.service.ts#create': {
    verdict: REFUSES,
    work: 'services',
    why: "A plan's Bucket (a Garage container), and its row. The Apply onto a platform-host Environment is refused already.",
  },
  'settings/settings.controller.ts#gpuCounts': {
    verdict: REFUSES,
    work: 'services',
    why: "A create form's GPU count, read live on the host for anyone who may create a Service there; with no Service created on the host there is nothing to count it for.",
  },

  // --- Templates and AI deploy (seam 4) --------------------------
  'compose/compose.service.ts#insertByTemplate': {
    verdict: REFUSES,
    work: 'services',
    why: '`createByTemplate`, which AI deploy reaches without `checkServerAccess`.',
  },

  // --- Checks (seam 3) -------------------------------------------
  'destinations/destinations.service.ts#testConnection': {
    verdict: REFUSES,
    work: 'checks',
    why: "`rclone ls` with the caller's credentials.",
  },
  'destinations/destinations.service.ts#testSavedConnection': {
    verdict: REFUSES,
    work: 'checks',
    why: "`rclone ls` with a saved destination's credentials.",
  },
  'destinations/destinations.service.ts#listObjects': {
    verdict: REFUSES,
    work: 'checks',
    why: '`rclone lsjson --recursive` on a saved destination.',
  },
  'backups/backups.service.ts#listBackupFiles': {
    verdict: REFUSES,
    work: 'checks',
    why: "The restore picker's `rclone lsjson`.",
  },
  'registries/registries.service.ts#testConnection': {
    verdict: REFUSES,
    work: 'checks',
    why: 'The `docker login` probe, with the password in the process env.',
  },
  'registries/registries.service.ts#testSavedConnection': {
    verdict: REFUSES,
    work: 'checks',
    why: "The `docker login` probe with a saved registry's password.",
  },
  'applications/applications.service.ts#testRegistryLogin': {
    verdict: REFUSES,
    work: 'checks',
    why: "An Application source's `docker login` test, run on its build host. A cloud web Application has none, so without the refusal the customer's password would log in from the shared box.",
  },

  // --- Host management ----------------------------------------------------
  'certificates/certificates.service.ts#create': {
    verdict: HOST_MANAGEMENT,
    why: 'A host certificate: no serverId asks `checkInstanceAuthority` first.',
  },
  'docker-ops/cluster.service.ts#instanceOrServerScoped': {
    verdict: HOST_MANAGEMENT,
    why: "The host's swarm cluster: no serverId asks `checkInstanceAuthority`.",
  },
  'docker-ops/swarm.service.ts#instanceOrServerScoped': {
    verdict: HOST_MANAGEMENT,
    why: "The host's swarm: no serverId asks `checkInstanceAuthority`.",
  },
  'docker-ops/docker-ops.service.ts#ownedServerId': {
    verdict: HOST_MANAGEMENT,
    why: "The host's containers: an unmanaged one is instance authority's, a managed one is reached through its Service (ADR-0008).",
  },
  'monitoring/monitoring.service.ts#setupMonitoring': {
    verdict: HOST_MANAGEMENT,
    why: "A Server's metrics setup: its id is required; the host's own is instance authority.",
  },
  'monitoring/monitoring.service.ts#findReadableTarget': {
    verdict: HOST_MANAGEMENT,
    why: "Host metrics: no serverId asks `checkInstanceAuthority` first; container series are decided per series instead, a managed one by its Service's entitlement (ADR-0067).",
  },
  'scheduling/schedules/schedules.service.ts#checkAccess': {
    verdict: HOST_MANAGEMENT,
    why: 'A `server` schedule needs its id; a `cloudgate-server` one is instance authority.',
  },
  'settings/settings.controller.ts#traefikTargetAuthority': {
    verdict: HOST_MANAGEMENT,
    why: "The host's Traefik: no serverId asks `requireInstanceAuthority`.",
  },
  'settings/settings.controller.ts#traefikFileTarget': {
    verdict: HOST_MANAGEMENT,
    why: "The host's Traefik files: no serverId asks `requireInstanceAuthority`.",
  },
  'settings/settings.controller.ts#maintenanceTargetAuthority': {
    verdict: HOST_MANAGEMENT,
    why: 'Docker cleanup, GPU setup and the rest of host maintenance: no serverId asks `requireInstanceAuthority`.',
  },
  'settings/settings.controller.ts#haveActivateRequests': {
    verdict: HOST_MANAGEMENT,
    why: "Whether the host's Traefik access log is on: a read of the box's own configuration that runs nothing for the caller.",
  },

  // --- Follows its Service's place ----------------------------------------
  'applications/applications.service.ts#updateRow': {
    verdict: FOLLOWS,
    why: "An existing Application's build Server, or its GPUs on its own run Server.",
  },
  'domains/domains.service.ts#generatedHostAddress': {
    verdict: FOLLOWS,
    why: 'Reads the address a generated Domain names, for the place its create already chose; runs nothing.',
  },
  'rollbacks/rollbacks.service.ts#dropPreservedImage': {
    verdict: FOLLOWS,
    why: "A rollback image kept on its Service's run Server.",
  },
  'rollbacks/preserved-images.ts#reclaimPreservedImages': {
    verdict: FOLLOWS,
    why: "Rollback images kept on their Service's run Server.",
  },
};

const SRC = resolve(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Comment lines blanked, line numbers kept: a docblock quoting a call is not one. */
function codeLines(text: string): string[] {
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
      ? ''
      : line;
  });
}

/** A class method at class-body indent (Prettier's two spaces), or a top-level function. */
const METHOD =
  /^ {2}(?:public |private |protected )?(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
const FUNCTION = /^(?:export )?(?:async )?function\s+([A-Za-z_$][\w$]*)/;
const NOT_FUNCTIONS = new Set([
  'catch',
  'constructor',
  'for',
  'if',
  'return',
  'switch',
  'while',
]);

/** The function the line at `index` is written in, with its body. */
function enclosing(
  lines: readonly string[],
  index: number,
): { name: string; body: string } | null {
  for (let at = index; at >= 0; at -= 1) {
    const method = METHOD.exec(lines[at]);
    const fn = method ? null : FUNCTION.exec(lines[at]);
    const name = (method ?? fn)?.[1];
    if (!name || NOT_FUNCTIONS.has(name)) continue;
    const close = method ? /^ {2}\}/ : /^\}/;
    let end = at;
    while (end < lines.length && !close.test(lines[end])) end += 1;
    return { name, body: lines.slice(at, end + 1).join('\n') };
  }
  return null;
}

/** `BaseDatabaseService` inserts through its engine's table, `this.table`. */
const SERVICE_INSERT = new RegExp(
  String.raw`\.insert\((?:${[...Object.keys(SERVICE_TABLES), 'this\\.table'].join('|')})\)`,
);
const SERVER_ACCESS_CALL = /\bcheckServerAccess\(/;
/** The registry login probe, which runs on the platform host when given no Server. */
const PROBE_CALL = /\.probeLogin\(/;
/** The definition itself, which is not a caller. */
const DEFINITION = /export async function checkServerAccess\(/;

interface Site {
  readonly key: string;
  readonly body: string;
}

function sites(): Site[] {
  const found = new Map<string, Site>();
  for (const file of sourceFiles(SRC)) {
    const lines = codeLines(readFileSync(file, 'utf8'));
    lines.forEach((line, index) => {
      if (DEFINITION.test(line)) return;
      if (
        !SERVER_ACCESS_CALL.test(line) &&
        !SERVICE_INSERT.test(line) &&
        !PROBE_CALL.test(line)
      ) {
        return;
      }
      const fn = enclosing(lines, index);
      const key = `${relative(SRC, file)}#${fn?.name ?? '(top level)'}`;
      found.set(key, { key, body: fn?.body ?? '' });
    });
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

describe('platformHostRefused, as the gate every Service placement is classified against (ADR-0053)', () => {
  const found = sites();

  it('classifies every checkServerAccess caller, login-probe caller and Service-row insert', () => {
    const unclassified = found
      .map((site) => site.key)
      .filter((key) => !(key in CENSUS));
    // A failure here is a new way onto the platform host: add it to CENSUS
    // with its verdict and why.
    expect(unclassified).toEqual([]);
  });

  it('lists no site that is gone', () => {
    const keys = new Set(found.map((site) => site.key));
    expect(Object.keys(CENSUS).filter((key) => !keys.has(key))).toEqual([]);
  });

  it('finds the Service inserts it walks for, so a rename cannot empty it', () => {
    const inserts = found.filter((site) => SERVICE_INSERT.test(site.body));
    expect(inserts.map((site) => site.key)).toEqual([
      'applications/applications.service.ts#insertApplication',
      'buckets/buckets.service.ts#create',
      'compose/compose-stack-vms.ts#insertRow',
      'compose/compose.service.ts#insertByTemplate',
      'compose/compose.service.ts#insertCompose',
      'databases/common/database-service.ts#insertDatabase',
    ]);
  });

  it('finds the login-probe callers it walks for, so a rename cannot empty it', () => {
    const probes = found.filter((site) => PROBE_CALL.test(site.body));
    expect(probes.map((site) => site.key)).toEqual([
      'applications/applications.service.ts#testRegistryLogin',
      'registries/registries.service.ts#testConnection',
      'registries/registries.service.ts#testSavedConnection',
    ]);
  });

  it('has every wired refusal call the refusal function', () => {
    const missing = found.filter((site) => {
      const entry = CENSUS[site.key];
      return (
        entry?.verdict === REFUSES &&
        entry.until === undefined &&
        !site.body.includes('refusePlatformHost(')
      );
    });
    expect(missing.map((site) => site.key)).toEqual([]);
  });
});

/**
 * **Census (c): every Service insert asks the one cloud seam**.
 *
 * In an Environment whose Deploy target is a Cloud account, a console create
 * whose body leaves `serverId` out used to land on the platform host without
 * asking: `runServerFor` gave `null` for an Application, and the Compose,
 * template, AI deploy and database creates never read the Deploy target at
 * all. Each now asks `refuseUnchosenInCloud` (`environments/deploy-target.ts`),
 * an Application through `runServerFor`. The walk is census (b)'s own list of
 * Service-row inserts, so a new insert fails here until it asks the seam or
 * says why it is no console create; an exemption whose site is gone, or that
 * asks the seam after all, fails too.
 */
const CLOUD_SEAM = /\b(?:refuseUnchosenInCloud|runServerFor)\(/;

const NOT_A_CONSOLE_CREATE: Readonly<Record<string, string>> = {
  'buckets/buckets.service.ts#create':
    "Only a plan, or 'Use an existing bucket', creates a Bucket, and each names its own place: no console route leaves the Server out.",
  'compose/compose-stack-vms.ts#insertRow':
    "Reached only in an Environment whose Deploy target is a Cloud account: from a plan's create of a compose entry, which names its Cloud account and region (ADR-0070), or a console create, which refuses a named Server first (#1372). Nothing is left to choose.",
};

describe('refuseUnchosenInCloud, as the one seam a console create in a cloud Environment asks', () => {
  const inserts = sites().filter((site) => SERVICE_INSERT.test(site.body));

  it('has every Service insert ask it, or say why it is no console create', () => {
    const unasked = inserts.filter(
      (site) =>
        !(site.key in NOT_A_CONSOLE_CREATE) && !CLOUD_SEAM.test(site.body),
    );
    expect(unasked.map((site) => site.key)).toEqual([]);
  });

  it('lists no exemption that is gone, or that asks the seam anyway', () => {
    const byKey = new Map(inserts.map((site) => [site.key, site]));
    const stale = Object.keys(NOT_A_CONSOLE_CREATE).filter((key) => {
      const site = byKey.get(key);
      return !site || CLOUD_SEAM.test(site.body);
    });
    expect(stale).toEqual([]);
  });

  it('has runServerFor ask it, so an Application is held to the same rule', () => {
    const lines = codeLines(
      readFileSync(join(SRC, 'environments/deploy-target.ts'), 'utf8'),
    );
    const at = lines.findIndex((line) =>
      /^export function runServerFor\(/.test(line),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(enclosing(lines, at)?.body).toMatch(/\brefuseUnchosenInCloud\(/);
  });
});
