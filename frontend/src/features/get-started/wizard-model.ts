import type {
  BoughtServerCatalogue,
  BoughtServerStage,
} from "@/lib/api/endpoints/bought-servers";
import type {
  EnvironmentDeployment,
  EnvironmentDomain,
} from "@/lib/api/endpoints/environments";
import type { AutoApplyView } from "@/lib/api/endpoints/pending-setups";
import type { Plan } from "@/lib/api/endpoints/project-config";
import {
  lastSetup,
  notReadyYet,
  type Server,
} from "@/lib/api/endpoints/servers";
import type { SetupForm } from "@/lib/api/endpoints/templates";

/**
 * The get-started wizard's decisions, as pure functions over what the API
 * answers, so each one is tested without rendering a step.
 */

/**
 * Whether an app can go on this Server now: a deploy Server whose setup
 * finished, or a Bought Server that is Ready (its first setup is part of
 * Ready, ADR-0071). A Bought Server that is Ready but whose setup failed is
 * still offered: the backend refuses the setup if it cannot take it, and
 * the Server's own page says how to run setup again.
 */
export function isReadyServer(server: Server): boolean {
  if (server.serverType !== "deploy") return false;
  if (server.boughtServer) return notReadyYet(server) === null;
  return lastSetup(server)?.ok === true;
}

export function readyServers(servers: readonly Server[]): Server[] {
  return servers.filter(isReadyServer);
}

/**
 * Whether step 2's new-Project setup form is worth asking again: it has
 * no generated host on the Server yet. A Bought Server gets one only once
 * its Server row exists (Setting up), so a form read before then starts
 * its web address empty. A form with no new-Project hosts (the template
 * has no compose Domain) never gets one, so it is not waited for.
 */
export function waitsForGeneratedHost(
  form: SetupForm | undefined,
  serverId: string,
): boolean {
  return (
    form !== undefined &&
    form.newProjectHosts !== null &&
    !(serverId in form.newProjectHosts.servers)
  );
}

/**
 * Whether the app can be set up on this Server now, though it may not be
 * Ready: a Bought Server can be a Deploy target from Setting up on, and
 * Cloudgate applies the setup by itself once it is Ready (ADR-0073), so
 * the person fills in the app's details while the Server is made.
 */
export function canSetUpOn(server: Server): boolean {
  return (
    isReadyServer(server) ||
    (server.serverType === "deploy" &&
      server.boughtServer?.stage === "setting_up" &&
      !server.boughtServer.poweredOff)
  );
}

/** The stages of a Bought Server still being made, which the wizard follows. */
const MAKING: readonly BoughtServerStage[] = [
  "waiting_for_payment",
  "creating",
  "setting_up",
];

/**
 * A Bought Server on its way to Ready, newest first: what the wizard follows
 * after Checkout, whose return address cannot name the Server (the purchase
 * is made by the same request that sends the address).
 */
export function serverBeingMade(
  servers: readonly Server[],
): Server | undefined {
  return servers
    .filter(
      (server) =>
        server.boughtServer !== null &&
        MAKING.includes(server.boughtServer.stage),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The four stages a buyer sees, in order. */
export const BUY_STAGES = [
  { stage: "waiting_for_payment", label: "Payment" },
  { stage: "creating", label: "Creating your server" },
  { stage: "setting_up", label: "Setting it up" },
  { stage: "ready", label: "Ready to use" },
] as const;

export type StageState = "done" | "now" | "todo";

/** Each of the four stages as done, now or to do, for a Bought Server at `stage`. */
export function buyStageStates(
  stage: BoughtServerStage,
): { label: string; state: StageState }[] {
  const at = BUY_STAGES.findIndex((entry) => entry.stage === stage);
  return BUY_STAGES.map((entry, index) => ({
    label: entry.label,
    state:
      stage === "ready" || index < at ? "done" : index === at ? "now" : "todo",
  }));
}

/**
 * The lowest monthly price a Server can be bought for anywhere right now,
 * for the "from $N a month" on the buy card; null with nothing for sale.
 */
export function startingPrice(catalogue: BoughtServerCatalogue): number | null {
  let lowest: number | null = null;
  for (const size of catalogue.sizes) {
    for (const offer of size.offers) {
      if (offer.available && (lowest === null || offer.monthly < lowest)) {
        lowest = offer.monthly;
      }
    }
  }
  return lowest;
}

/** How a deploy the wizard started is going. */
export type LaunchPhase =
  /** `waitingFor`: what Cloudgate waits for before it applies, as the backend words it. */
  | { phase: "preparing"; waitingFor?: string }
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "failed"; reason: string };

/**
 * Where the deploy stands, from the Environment's plan, its Deployments and
 * the wizard's Pending setup's Apply (`autoApply`, ADR-0073).
 *
 * - While the plan is open (or not read yet) Cloudgate has not applied it:
 *   it applies the setup's plan by itself once the Server is Ready, and the
 *   Pending setup says what it is waiting for.
 * - **A refused Apply is a failure**, though the plan is still open: the
 *   plan then waits for a person to review it, and without this the wizard
 *   would say "Preparing" for ever.
 * - Once applied, each Service it created has a Deployment queued, and the
 *   app is starting until the newest Deployment of each has ended.
 * - A step that failed, a Deployment that failed or was cancelled, or a plan
 *   that was dismissed, is a failure, with the first reason found.
 */
export function launchPhase(
  plan: Plan | null | undefined,
  deployments: readonly EnvironmentDeployment[] | undefined,
  autoApply?: AutoApplyView | null,
): LaunchPhase {
  if (!plan || plan.status === "open" || plan.status === "superseded") {
    if (autoApply?.status === "refused") {
      return {
        phase: "failed",
        reason: sentence(
          autoApply.message ?? "Cloudgate could not start the app by itself",
        ),
      };
    }
    return autoApply?.status === "waiting" && autoApply.waitingFor
      ? { phase: "preparing", waitingFor: sentence(autoApply.waitingFor) }
      : { phase: "preparing" };
  }
  if (plan.status === "dismissed") {
    return {
      phase: "failed",
      reason: "The setup was cancelled before it ran.",
    };
  }
  const failedStep = (plan.results ?? []).find(
    (result) => result.status === "failed" || result.status === "blocked",
  );
  if (failedStep || plan.status === "partly-applied") {
    return {
      phase: "failed",
      reason:
        failedStep?.message ??
        (failedStep
          ? `${failedStep.configName} could not be created.`
          : "Part of the setup could not be created."),
    };
  }
  if (deployments === undefined) return { phase: "starting" };

  // The newest Deployment of each Service; the feed is newest first.
  const newest = new Map<string, EnvironmentDeployment>();
  for (const row of deployments) {
    if (!newest.has(row.owner.id)) newest.set(row.owner.id, row);
  }
  const latest = [...newest.values()];
  const broken = latest.find(
    (row) => row.status === "error" || row.status === "cancelled",
  );
  if (broken) {
    return {
      phase: "failed",
      reason: `${broken.owner.name} did not start.`,
    };
  }
  const queued = (plan.results ?? []).some(
    (result) => result.deploy?.status === "queued",
  );
  if (
    latest.some((row) => row.status !== "done") ||
    (queued && latest.length === 0)
  ) {
    return { phase: "starting" };
  }
  return { phase: "running" };
}

/** A backend message (no trailing period, ADR-0005's style) as a sentence. */
function sentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The app's address: the first Domain in the Environment, as a URL a
 * browser opens. Null with none (an app the template gives no Domain).
 *
 * With `service`, the first Domain routed into that compose service instead,
 * as a template's `signIn.domain` names one (#140); null when it has none
 * here, rather than another service's address the sign-in is not on.
 */
export function appAddress(
  domains: readonly EnvironmentDomain[] | undefined,
  service?: string,
): string | null {
  const domain =
    service === undefined
      ? domains?.[0]
      : domains?.find((one) => one.serviceName === service);
  if (!domain) return null;
  const path = domain.path && domain.path !== "/" ? domain.path : "";
  return `${domain.https ? "https" : "http"}://${domain.host}${path}`;
}

/**
 * A name for the Project that is not one the Organization already uses:
 * the app's own name, then `Ghost 2`, `Ghost 3`.
 */
export function freeProjectName(
  appName: string,
  taken: readonly string[],
): string {
  return freeName(appName, " ", taken);
}

/**
 * A name for a new Environment the wizard makes in an existing Project:
 * `production`, then `production-2`, `production-3`, since an
 * Environment's name is unique in its Project whatever its case.
 */
export function freeEnvironmentName(taken: readonly string[]): string {
  return freeName("production", "-", taken);
}

function freeName(
  base: string,
  joiner: string,
  taken: readonly string[],
): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let at = 2; ; at += 1) {
    const name = `${base}${joiner}${at}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** How one part of the app is getting on, while it starts. */
export type LaunchPartState = "waiting" | "starting" | "started" | "failed";

export type LaunchPart = {
  /** The part's Config name. */
  name: string;
  state: LaunchPartState;
  /** The Deployment running for it now, whose log says what it is doing. */
  deploymentId: string | null;
};

/**
 * Each part the setup's Apply created, with how its deploy is getting on:
 * waiting its turn, starting (its Deployment running), started, or failed.
 * A queued deploy names its Deployment, so that row is the one read; a
 * database's deploy writes none, so its own `started` is taken as it is.
 * Empty before the plan is applied.
 */
export function launchParts(
  plan: Plan | null | undefined,
  deployments: readonly EnvironmentDeployment[] | undefined,
): LaunchPart[] {
  const byId = new Map(
    (deployments ?? []).map((row) => [row.deploymentId, row] as const),
  );
  return (plan?.results ?? []).flatMap((result): LaunchPart[] => {
    const deploy = result.deploy;
    const name = result.configName;
    if (deploy === null) return [];
    if (deploy.status === "started") {
      return [{ name, state: "started", deploymentId: null }];
    }
    if (deploy.status === "not-deployed") {
      return [{ name, state: "failed", deploymentId: null }];
    }
    const status = byId.get(deploy.deploymentId)?.status;
    const state: LaunchPartState =
      status === "running"
        ? "starting"
        : status === "done"
          ? "started"
          : status === "error" || status === "cancelled"
            ? "failed"
            : "waiting";
    return [
      {
        name,
        state,
        deploymentId: state === "starting" ? deploy.deploymentId : null,
      },
    ];
  });
}
