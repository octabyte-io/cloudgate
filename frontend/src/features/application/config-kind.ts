import type { ApplicationConfigKind } from "@/lib/api/endpoints/applications";

/**
 * What an Application's recorded kind rules out, in the console's words.
 * The backend refuses the same writes (`config-kind-locks.ts`);
 * the console does not offer them, and says why where the control would be,
 * so the reason is on the screen rather than in a refusal after a click.
 */
export interface KindRefusals {
  readonly domain: string;
  /** Absent for a kind with no port to publish, a worker's. */
  readonly port?: string;
  readonly previews: string;
}

const WEB_PRIVATE: KindRefusals = {
  domain:
    "A Private web service takes no Domain: only other Services reach it, at its internal address. To serve it outside, change its kind to web in the Project config.",
  port: "A Private web service publishes no port: only other Services reach it, at its internal address. To serve it outside, change its kind to web in the Project config.",
  previews:
    "A Private web service has no previews: a preview is reached at its own Domain, and a Private web service takes none. To preview it, change its kind to web in the Project config.",
};

/**
 * A worker serves no HTTP, so nothing may route a host to it. Kept a
 * tab with the reason, not hidden as an AI model's are, because "why
 * can I not add a Domain to this?" is asked by visiting it.
 */
const WORKER: KindRefusals = {
  domain:
    "A worker takes no Domain: it serves no HTTP. To serve HTTP, change its kind to web in the Project config.",
  previews:
    "A worker has no previews: a preview is reached at its own Domain, and a worker serves no HTTP. To serve HTTP, change its kind to web in the Project config.",
};

/**
 * A Cron service has no Swarm service: each run is a one-off
 * job that publishes nothing and exits, so nothing can reach it.
 */
const CRON: KindRefusals = {
  domain:
    "A Cron service takes no Domain: each run is a fresh container that serves nothing and exits. To serve HTTP, change its kind to web in the Project config.",
  port: "A Cron service publishes no port: each run is a fresh container that serves nothing and exits. To serve on a port, change its kind to web in the Project config.",
  previews:
    "A Cron service has no previews: a preview is reached at its own Domain, and a Cron service serves nothing. To preview it, change its kind to web in the Project config.",
};

const REFUSALS: Partial<Record<ApplicationConfigKind, KindRefusals>> = {
  "web-private": WEB_PRIVATE,
  worker: WORKER,
  cron: CRON,
};

/** The refusals of `kind`, or `null` for a kind that takes all three. */
export function kindRefusals(
  kind: ApplicationConfigKind | undefined,
): KindRefusals | null {
  return (kind && REFUSALS[kind]) ?? null;
}
