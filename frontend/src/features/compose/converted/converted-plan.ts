import { parse } from "yaml";

import type { Compose } from "@/lib/api/endpoints/compose";
import type { Domain } from "@/lib/api/endpoints/domains";
import type { ChangeKey } from "@/lib/design/status";

/**
 * What deploying this stack will rewrite, from the data the console really holds.
 *
 * **This is not the converted file and has never pretended to be one.** The file
 * itself comes from `GET /compose/:id/converted`
 * and the tab shows
 * it — from the platform's own copy of the rewrite, because generating YAML here
 * would mean a second implementation of `addDomainsToComposeSpec` that could drift
 * from the one the deploy runs, and a diff that is *wrong* is worse than no diff
 * on the one tab whose whole job is to be trusted.
 *
 * What this still does, and is still the only thing that does, is **explain** the
 * rewrite from its inputs — the domains (`GET /compose/:composeId/domains`) and
 * the isolation flag on the stack. A file and an explanation of a file are two
 * different readings, and the three refusals below are why the second one earns
 * its place: each fails a Deployment for a reason the file itself looks fine for,
 * and one of them fails it *silently*.
 *
 * They are the refusals the deploy path makes **before it writes anything**:
 *
 * - a domain with no `serviceName` throws;
 * - a domain naming a service the file does not declare throws;
 * - a domain on a service whose `labels` are written as a **map** rather than a
 *   list throws.
 *
 * All three are `addDomainsToComposeSpec`'s, and reading them off one function is
 * the point: the first two are its `serviceName` guards, the third is the
 * map-form arm it used to do the label splice behind.
 *
 * That third one **used to be a silent skip** — the labels were dropped, the
 * deploy succeeded, and the domain never routed, which made it the worst of the
 * three. It is now a refusal at the conversion path, which every consumer
 * passes through, so the Converted read and the deploy both answer 400 now and
 * this card is describing a refusal rather than a trap.
 *
 * The last two need the file, so they are only checked for a `raw` source. For a
 * git source the file is in the repository and nothing here can read it; the plan
 * says what it will do and stops short of claiming the file supports it.
 *
 * **There is no longer an "unchanged" case, and the field that said there was is
 * gone**. This card used to answer "Nothing." for an isolated stack with no
 * domains, because `writeDomainsToCompose` really did hand that one shape back
 * byte for byte. It no longer does: every deploy now gets a `logging:` block,
 * and a `docker-compose` one a `restart:` policy, written into the converted
 * file for every service that does not declare its own. That was the one shape
 * those two defaults used to miss, so the screen that said "nothing changes"
 * was both the wrongest sentence in the tab and the one describing the case the
 * fix was for.
 */

export type PlanItem = {
  /** The compose service this touches, when it is about one. */
  service: string | null;
  title: string;
  detail: string;
  /**
   * `add` is a change, `info` is a no-op, and `unknown` is **neither known**.
   *
   * The third one is the whole fix. A row whose answer depends on the file — the
   * two platform defaults — has no answer at all for a git source, whose file
   * this console cannot read, and the two marks `plan-row.tsx` had made it pick
   * one anyway. `○ no-op` is a claim that nothing happens, and it was being made
   * about a rewrite that added twelve lines.
   */
  tone: "add" | "unknown" | "info" | "bad" | "warn";
};

export type ConvertedPlan = {
  items: PlanItem[];
  /** Only known for a `raw` source — see the note above. */
  fileChecked: boolean;
};

export function convertedPlan(
  compose: Compose,
  domains: Domain[],
): ConvertedPlan {
  const items: PlanItem[] = [];
  const isolated = compose.isolatedDeployment;
  const swarm = compose.composeType === "stack";
  const services =
    compose.sourceType === "raw"
      ? parseServices(compose.composeFile, swarm)
      : null;

  for (const domain of domains) {
    const service = domain.serviceName;

    if (!service) {
      items.push({
        service: null,
        title: `${domain.host} names no service`,
        detail:
          "The deploy stops here: a compose domain has to say which service in the file it routes into. Edit the domain and choose one.",
        tone: "bad",
      });
      continue;
    }

    if (services && !services.has(service)) {
      items.push({
        service,
        title: `${domain.host} routes into a service this file does not have`,
        detail: `Nothing in the file declares ${service}, so the deploy stops before it writes anything. The names it does declare are on the Overview tab.`,
        tone: "bad",
      });
      continue;
    }

    if (swarm) {
      items.push(stackRoutingItem(compose.appName, service, domain));
      continue;
    }

    const entrypoints = domain.customEntrypoint
      ? [domain.customEntrypoint]
      : domain.https
        ? ["web", "websecure"]
        : ["web"];

    items.push({
      service,
      title: `Traefik labels on ${service} for ${domain.host}`,
      detail: [
        `A router per entrypoint (${entrypoints.join(", ")}), named ${compose.appName}-${domain.uniqueConfigKey}-<entrypoint>, forwarding to port ${domain.port ?? 80}`,
        domain.https && !domain.customEntrypoint
          ? "plus the web router redirecting to https"
          : null,
        domain.stripPath && domain.path && domain.path !== "/"
          ? `plus a stripprefix middleware for ${domain.path}`
          : null,
        domain.internalPath && domain.internalPath !== "/"
          ? `plus an addprefix middleware for ${domain.internalPath}`
          : null,
      ]
        .filter(Boolean)
        .join(", ") +
        ". They go under the service's labels, where Traefik reads a docker compose container's.",
      tone: "add",
    });

    // Only a docker-compose file is written into; a stack's labels are left
    // as they are, map or list.
    if (services?.get(service)?.labels === "map") {
      items.push({
        service,
        title: `${service} writes its labels as a map, so this stack is refused`,
        detail:
          "The rewrite only appends to a list-form labels: block, and Cloudgate refuses rather than dropping the routing silently — so the Converted read and the next deploy both fail until it is fixed. Write this service's labels as a list of KEY=value strings instead.",
        tone: "bad",
      });
    }
  }

  if (isolated && domains.length === 0) {
    items.push({
      service: null,
      title: "No network is added to the file",
      detail: `Isolation is on and nothing is routed, so the file's own networks are left as they are. The deploy still creates an attachable${swarm ? " overlay" : ""} network named ${compose.appName} and connects the Traefik container to it, but no service is joined to it and nothing at the file's root changes.`,
      tone: "info",
    });
  } else if (isolated) {
    items.push({
      service: null,
      title: `Every routed service joins ${compose.appName}`,
      detail: `Isolation is on, so the shared network is this stack's own: the deploy creates an attachable${swarm ? " overlay" : ""} network named ${compose.appName} and connects the Traefik container to it. Each service a domain points at is joined to that network, it is declared external: true at the file's root${swarm ? "" : ", and each of those services gets a traefik.docker.network label naming it"}. Services keep the default network too, so they can still reach each other.`,
      tone: "add",
    });
  } else if (domains.length === 0) {
    // This row said "Every routed service joins cloudgate-network" and
    // marked it `+ create` on a stack with no domains, where the set of routed
    // services is empty and `docker inspect` showed both containers on the
    // project's own default network and nothing else. What the rewrite really
    // does with no domains is the root line and only the root line —
    // `addDomainsToComposeSpec` runs its per-domain loop zero times, and
    // `if (!isolatedDeployment || domains.length > 0)` still declares the
    // network. So the row stays a change, and says which change.
    items.push({
      service: null,
      title: "cloudgate-network is declared at the file's root, and nothing joins it",
      detail: `No domain is attached, so no service is joined to the shared network${swarm ? "" : " and none gets a traefik.docker.network label"}. The network is still declared external: true at the root, which is the whole of what this adds. Attach a domain and the service it names joins it.`,
      tone: "add",
    });
  } else {
    items.push({
      service: null,
      title: "Every routed service joins cloudgate-network",
      // No backticks in any of these strings: a `detail` is rendered as text, and
      // markdown is not a thing in JSX — F10 and F11 each paid for that once.
      detail: `The shared network is added to each service a domain points at, declared external: true at the file's root${swarm ? ", and that is the network Traefik reaches them over" : ", and each of those services gets a traefik.docker.network label so Traefik knows which address to use"}.`,
      tone: "add",
    });
  }

  // The two platform defaults, last because they are the least interesting
  // thing on the list and the only ones that are true of every stack. Both
  // are written into the converted file, never into the file you
  // maintain, and both step aside for a service that declares the key itself —
  // presence is your statement, absence is the platform's default.
  //
  // **Which is exactly why the mark cannot be fixed**. Both rows carried
  // `tone: "info"` unconditionally, so `plan-row.tsx` drew `○ no-op` beside them
  // while the Changes tab on the same card listed the twelve lines they added —
  // and `docker inspect` on the containers that came out confirmed the rewrite,
  // not the marker. `applyComposeDefaults`' rule is a `??=` per service, so the
  // honest question is whether any service in *this* file is missing the key,
  // and that is the question `reach` asks.
  const logging = reach(services, (facts) => facts.logging);
  items.push({
    service: null,
    title:
      logging === false
        ? "Every service already caps its own logs"
        : logging === true
          ? "Every service gets a log cap"
          : "A log cap, for every service that does not declare one",
    // The numbers are deliberately not stated here. The backend writes
    // `containerLogOptions(env)`, which reads CONTAINER_LOG_MAX_SIZE and
    // CONTAINER_LOG_MAX_FILE off the instance's own environment, and the
    // console cannot see those — so naming 10m × 3 would be a confident lie on
    // every install that retunes them, which `docs/deploy.md` §6 documents as
    // supported.
    detail:
      logging === false
        ? "Every service in this file writes its own logging block, so the deploy adds none. Presence is your statement: a service that declares logging keeps it exactly as written, an uncapped one included."
        : `A logging block with the json-file driver and this instance's configured size and file limits, on each service that does not already declare logging of its own. Without it a service that logs in a loop can fill the deploy target's disk and take every other service on it down. A service that writes its own logging block keeps it exactly as written, an uncapped one included.`,
    tone: toneFor(logging),
  });

  if (!swarm) {
    const restart = reach(services, (facts) => facts.restart);
    items.push({
      service: null,
      title:
        restart === false
          ? "Every service already declares its own restart policy"
          : restart === true
            ? "Every service gets restart: unless-stopped"
            : "restart: unless-stopped, for every service that does not declare one",
      detail:
        restart === false
          ? "Every service in this file declares restart, so the deploy adds none. A service that declares its own keeps it, including restart: no."
          : "So the stack comes back by itself after the Docker daemon restarts or the deploy target reboots, which is what a Swarm stack already does on its own. Not always: a stack you Stop stays stopped. A service that declares its own restart keeps it, including restart: no.",
      tone: toneFor(restart),
    });
  }

  return { items, fileChecked: services !== null };
}

/**
 * What routes one Domain of a Swarm stack: not labels — Swarm keeps
 * `deploy.labels` on the service, where Traefik's docker provider never reads
 * them — but the Traefik config file the backend writes on the stack's Server
 * (`createComposeStackTraefikConfig`), with the router names an Application
 * Domain's file uses.
 */
function stackRoutingItem(
  appName: string,
  service: string,
  domain: Domain,
): PlanItem {
  const key = domain.uniqueConfigKey;
  return {
    service,
    title: `Traefik routing for ${domain.host} into ${service}`,
    detail:
      [
        `A router named ${appName}-router-${key} on web${domain.https ? `, and ${appName}-router-websecure-${key} on websecure` : ""}, in the Traefik config file Cloudgate writes on the stack's Server, forwarding to the Swarm service ${appName}_${service} on port ${domain.port ?? 80}`,
        domain.https ? "with the web router redirecting to https" : null,
        domain.stripPath && domain.path && domain.path !== "/"
          ? `plus a stripprefix middleware for ${domain.path}`
          : null,
        domain.internalPath && domain.internalPath !== "/"
          ? `plus an addprefix middleware for ${domain.internalPath}`
          : null,
      ]
        .filter(Boolean)
        .join(", ") +
      ". Nothing is added to the file's labels, and routing labels an earlier deploy put under deploy.labels are taken out.",
    tone: "add",
  };
}

/**
 * Does the platform default reach anything in this file — `null` for a file this
 * console is not holding.
 *
 * `applyComposeDefaults` writes each key with `??=`, per service, so one service
 * missing it is a change to the file and every service declaring it is not.
 * `null` is the git source, whose file lives in the repository: not a no-op, not
 * a change, *unknown*, and saying so is the point of the third mark.
 *
 * A file whose `services:` block is empty answers `false`, and truthfully — a
 * default written into no service changes nothing. (The deploy refuses that file
 * outright; this row is not where an operator should learn it, and
 * the Services strip above the editor already says so.)
 */
function reach(
  services: Map<string, ServiceFacts> | null,
  declares: (facts: ServiceFacts) => boolean,
): boolean | null {
  if (services === null) return null;
  return [...services.values()].some((facts) => !declares(facts));
}

function toneFor(reached: boolean | null): PlanItem["tone"] {
  return reached === null ? "unknown" : reached ? "add" : "info";
}

/** What one service in the file declares, of the three things the rewrite asks. */
type ServiceFacts = {
  /** How its labels are written — the map form is refused. */
  labels: "list" | "map" | "none";
  /** Whether it declares `logging:` of its own, which the default steps aside for. */
  logging: boolean;
  /** Same question for `restart:`. */
  restart: boolean;
};

/**
 * What each service in a compose file declares.
 *
 * Only ever called with a file this console is holding — the `composeFile` column
 * of a `raw` source. Anything unparsable answers `null`, because a file the parser
 * cannot read is one this has nothing to say about; the editor above already says
 * so in its own words.
 *
 * **The two default keys are read with the same test the backend writes them
 * with**: `applyComposeDefaults` uses `??=`, which writes only where the
 * key is `undefined` or `null`, so `logging: {}` and `restart: false` both count
 * as declared here exactly as they survive there. A truthiness check would call
 * both of them absent and put a `+ create` beside a row the deploy leaves alone —
 * the same class of wrong answer in the other direction.
 */
function parseServices(
  content: string,
  swarm: boolean,
): Map<string, ServiceFacts> | null {
  if (content.trim() === "") return null;
  let document: unknown;
  try {
    document = parse(content, { maxAliasCount: 10_000 });
  } catch {
    return null;
  }
  const services = (document as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null) return null;

  const found = new Map<string, ServiceFacts>();
  for (const [name, definition] of Object.entries(
    services as Record<string, unknown>,
  )) {
    // A Swarm stack's labels are the ones under `deploy`, which is where
    // `addDomainsToComposeSpec` puts them — checking the wrong key would warn
    // about a file that is fine and stay silent about one that is not.
    const service = definition as {
      labels?: unknown;
      logging?: unknown;
      restart?: unknown;
      deploy?: { labels?: unknown } | null;
    } | null;
    const labels = swarm ? service?.deploy?.labels : service?.labels;
    found.set(name, {
      labels: Array.isArray(labels) ? "list" : labels ? "map" : "none",
      logging: service?.logging != null,
      restart: service?.restart != null,
    });
  }
  return found;
}

/**
 * The same account of the rewrite, for the toggle that causes it — Advanced →
 * Network isolation.
 *
 * That card listed its effects from two fixed arrays that never looked at the
 * stack. So a stack with a domain, switched to isolated, was told
 * `○ no-op · leave the file's own networks alone — nothing is added to the
 * services and nothing to the root` and `○ no-op · with no domains configured,
 * change nothing but the two defaults` — and the deploy that followed put
 * `networks: [<appName>, default]` on the routed service, declared the network
 * external at the root, labelled it, and connected Traefik to it. Both no-ops
 * were changes, and the Converted tab three tabs over described it correctly the
 * whole time.
 *
 * It lives here rather than in that card because the inputs are the ones
 * {@link convertedPlan} already reads — the isolation flag and how many domains
 * are attached — and two functions reading them is how the two screens came to
 * disagree. `domains` is what `addDomainsToComposeSpec` loops over; nothing else
 * decides any of this.
 *
 * `domainCount: null` is the domains query still in flight, and it is not
 * rounded to zero: zero is the answer that changes every line below, so
 * guessing it would put the bug back for as long as the request takes.
 *
 * `wasIsolated` is the saved flag, for the one line that depends on the
 * switch rather than the setting
 * a deploy
 * with isolation off detaches Traefik from, and removes, the network an
 * earlier isolated deploy created — a bridge, that is; a Swarm stack's overlay
 * waits for the delete. It is said only when switching off — a
 * stack that was never isolated has no such network, and the release is a
 * no-op for it.
 */
export function isolationPreview({
  appName,
  swarm,
  isolated,
  wasIsolated = false,
  domainCount,
}: {
  appName: string;
  swarm: boolean;
  isolated: boolean;
  wasIsolated?: boolean;
  domainCount: number | null;
}): { change: ChangeKey; text: string }[] {
  if (!isolated && wasIsolated) {
    return [
      // A Swarm overlay is left to the delete: its old tasks may be on other
      // nodes, which this node's view of the network cannot see.
      swarm
        ? {
            change: "noop",
            text: `leave the overlay network ${appName}, and the Traefik container on it, until the stack is deleted`,
          }
        : {
            change: "destroy",
            text: `detach the Traefik container from ${appName} and remove that network, once nothing else is on it`,
          },
      ...isolationPreview({ appName, swarm, isolated, domainCount }),
    ];
  }
  const overlay = swarm ? " overlay" : "";
  // A stack's routed services get no label: Traefik reaches them through
  // the config file the deploy writes, over whichever network they share.
  const labelled = swarm ? "" : " and give those services a traefik.docker.network label";
  const rest = {
    change: "noop" as const,
    text: "leave the rest of the file as written, apart from the two defaults Cloudgate adds",
  };

  if (isolated) {
    // The network and the Traefik connection happen whatever the domains are —
    // `getBuildComposeCommand` creates them before `up`. Everything the *file*
    // gets is per-domain, and with none the deploy takes the arm of
    // `writeDomainsToCompose` that parses and re-serializes without touching a
    // network at all.
    const create = {
      change: "create" as const,
      text: `create an attachable${overlay} network named ${appName}, and connect the Traefik container to it`,
    };
    if (domainCount === 0) {
      return [
        create,
        {
          change: "noop",
          text: "leave the file's own networks alone — with no domain attached, nothing is added to the services and nothing to the root",
        },
        rest,
      ];
    }
    return [
      create,
      {
        change: domainCount === null ? "change" : "create",
        text:
          domainCount === null
            ? `join each service a domain points at to ${appName}, declare it external at the file's root${labelled} — or, with no domain attached, leave the file's networks alone`
            : `join each service a domain points at to ${appName}, declare it external at the file's root${labelled}${swarm ? "" : " naming it"}`,
      },
      rest,
    ];
  }

  // Off: the root declaration is unconditional — `addDomainsToComposeSpec` ends
  // on `if (!isolatedDeployment || domains.length > 0)` — and the per-service
  // half is not.
  if (domainCount === 0) {
    return [
      {
        change: "create",
        text: "declare cloudgate-network external at the file's root, and nothing else — with no domain attached no service joins it and none is labelled",
      },
      rest,
    ];
  }
  const joined = {
    change: "create" as const,
    text: "add cloudgate-network to every service a domain points at, and declare it external at the file's root",
  };
  if (swarm) return [joined, rest];
  return [
    joined,
    {
      change: "create",
      text: "add a traefik.docker.network label to those services, so Traefik uses the shared network's address",
    },
    rest,
  ];
}
