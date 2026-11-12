import type { DiffRow } from "@/components/console/diff-view";
import type { LogLine } from "@/components/console/log-well";
import type { StatusKey } from "@/lib/design/status";

/**
 * The gallery's content. Realistic on purpose: the values a component has to
 * survive are the ones this product actually holds — a 71-character image
 * reference, a Swarm service name with four segments in it, a commit subject
 * written by someone in a hurry, 54 Deployments, 500 lines of build output.
 *
 * Deterministic on purpose too. A seeded generator, never `Math.random`, so the
 * server's HTML and the client's first render agree and the numbers in a
 * screenshot are the numbers in the next screenshot.
 */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const pick = <T,>(random: () => number, options: T[]) =>
  options[Math.floor(random() * options.length)];

/* ------------------------------------------------------------------ *
 * Deployments — the wide table
 * ------------------------------------------------------------------ */

export type DeploymentRow = {
  id: string;
  commit: string;
  subject: string;
  application: string;
  environment: string;
  status: StatusKey;
  image: string;
  seconds: number;
  started: string;
};

const APPLICATIONS = [
  "storefront",
  "checkout-api",
  "media-transcoder",
  "search-indexer",
  "webhooks-gateway",
  "reporting-worker",
];

const ENVIRONMENTS = ["production", "staging", "preview-1284"];

const SUBJECTS = [
  "Cache the product query for 60s",
  "Drop the unused webhook column",
  "Bump node to 22.11 and rebuild the base image",
  "Fix the redirect loop on /checkout when the cart is empty",
  "Move the transcoder onto its own Server",
  "Retry the S3 upload three times before failing the Deployment",
  "Add an index on deployment.created_at",
  "Stop logging the whole request body",
];

const DEPLOYMENT_STATUSES: StatusKey[] = [
  "done",
  "done",
  "done",
  "done",
  "running",
  "pending",
  "error",
  "cancelled",
];

export const DEPLOYMENTS: DeploymentRow[] = Array.from(
  { length: 54 },
  (_, index) => {
    const random = seeded(index + 7);
    const application = pick(random, APPLICATIONS);
    const digest = Math.floor(random() * 0xfffffff)
      .toString(16)
      .padStart(7, "0");
    const status = DEPLOYMENT_STATUSES[index % DEPLOYMENT_STATUSES.length];
    const hour = String(23 - (index % 24)).padStart(2, "0");
    return {
      id: `dep_${String(index + 1).padStart(4, "0")}`,
      commit: digest,
      subject: pick(random, SUBJECTS),
      application,
      environment: pick(random, ENVIRONMENTS),
      status,
      image: `registry.octabyte.io/acme/${application}@sha256:${digest}${digest}${digest}${digest}`,
      seconds:
        status === "pending" ? 0 : 38 + Math.floor(random() * heap(index)),
      started: `2026-08-0${(index % 3) + 1} ${hour}:${String((index * 7) % 60).padStart(2, "0")}`,
    };
  },
);

/** Long builds are long: a transcoder image is not a static site. */
function heap(index: number) {
  return index % 9 === 0 ? 900 : 240;
}

/* ------------------------------------------------------------------ *
 * Telemetry
 * ------------------------------------------------------------------ */

/** 48 half-hourly readings, which is what a day of the stats gateway looks like. */
function series(seed: number, base: number, swing: number, drift = 0) {
  const random = seeded(seed);
  let value = base;
  return Array.from({ length: 48 }, (_, index) => {
    value += (random() - 0.5) * swing + drift;
    value = Math.max(1, Math.min(99, value));
    // Two afternoon peaks, because real load has a shape.
    const peak = index === 30 || index === 38 ? 12 : 0;
    return Math.round(Math.min(99, value + peak));
  });
}

export const CPU_SERIES = series(11, 34, 9);
export const MEMORY_SERIES = series(29, 61, 4);
export const HOT_SERIES = series(41, 78, 7, 0.3);
export const FLAT_SERIES = Array.from({ length: 48 }, () => 6);

/**
 * Half-hourly, from 8 PM. `Plot` samples its own tick labels out of this at
 * evenly-spaced indices, so the ruler always agrees with the line — see the
 * note on `tickCount`. The reference's hand-written 4-hourly labels are what
 * that prop exists to make impossible.
 */
export function halfHourly(index: number) {
  const minutes = (20 * 60 + index * 30) % (24 * 60);
  const hour24 = Math.floor(minutes / 60);
  const suffix = hour24 < 12 ? "AM" : "PM";
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour}:${String(minutes % 60).padStart(2, "0")} ${suffix}`;
}

/* ------------------------------------------------------------------ *
 * The log — 500 lines of a real-shaped build
 * ------------------------------------------------------------------ */

const STEPS = [
  "resolve image config for docker.io/library/node:22.11-alpine",
  "load build definition from Dockerfile",
  "load .dockerignore",
  "COPY package.json pnpm-lock.yaml ./",
  "RUN --mount=type=cache,target=/root/.pnpm pnpm install --frozen-lockfile",
  "COPY . .",
  "RUN pnpm build",
  "RUN pnpm prune --prod",
  "exporting layers",
];

const NOISE = [
  "packages: +1284",
  "Progress: resolved 1284, reused 1201, downloaded 83, added 1284",
  "> storefront@0.4.11 build /app",
  "> next build",
  "  Creating an optimized production build ...",
  "  Compiled successfully in 41.2s",
  "  Collecting page data ...",
  "  Generating static pages (0/38)",
  "  Generating static pages (38/38)",
  "  Finalizing page optimization ...",
];

/**
 * 500 lines, with the tones spread the way a real build spreads them: mostly
 * plain, a highlight per step, a couple of warnings, one thing that failed and
 * was retried, and a summary at the end.
 */
export const BUILD_LOG: LogLine[] = Array.from({ length: 500 }, (_, index) => {
  const random = seeded(index + 3);
  // 14:22:00 plus three seconds a line: a 25-minute build, and timestamps that
  // only ever go forwards. A log whose clock jumps around is a log nobody
  // reading the gallery can trust to be shaped like the real thing.
  const at = 14 * 3600 + 22 * 60 + index * 3;
  const ts = [Math.floor(at / 3600), Math.floor(at / 60) % 60, at % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

  if (index === 0) {
    return { ts, text: "#0 building with docker driver builder-swarm-1", tone: "hl" };
  }
  if (index % 55 === 0) {
    const step = STEPS[(index / 55) % STEPS.length];
    return { ts, text: `#${index / 55 + 1} [${index / 55 + 1}/9] ${step}`, tone: "hl" };
  }
  if (index === 137) {
    return {
      ts,
      text: " WARN  deprecated subdependency: har-validator@5.1.5 — no longer maintained",
      tone: "warn",
    };
  }
  if (index === 291) {
    return {
      ts,
      text: " WARN  the lockfile is out of date with package.json for @acme/design@1.2.0",
      tone: "warn",
    };
  }
  if (index === 342) {
    return {
      ts,
      text: "ECONNRESET while fetching https://registry.npmjs.org/@acme%2fdesign — retrying (1/3)",
      tone: "bad",
    };
  }
  if (index === 343) {
    return { ts, text: "retry succeeded for @acme/design@1.2.0", tone: "ok" };
  }
  if (index === 499) {
    return {
      ts,
      text: "#9 pushed registry.octabyte.io/acme/storefront:2026.08.03-1 in 12.4s — done",
      tone: "ok",
    };
  }
  if (index % 17 === 0) {
    return { ts, text: `  ${NOISE[index % NOISE.length]}`, tone: "dim" };
  }
  return {
    ts,
    text: `  ${pick(random, NOISE)} ${Math.floor(random() * 900) + 100}ms`,
  };
});

/* ------------------------------------------------------------------ *
 * The diff
 * ------------------------------------------------------------------ */

export const COMPOSE_DIFF: DiffRow[] = [
  { kind: "ctx", text: "services:" },
  { kind: "ctx", text: "  storefront:" },
  { kind: "del", text: "    image: registry.octabyte.io/acme/storefront:2026.07.28-4" },
  { kind: "add", text: "    image: registry.octabyte.io/acme/storefront:2026.08.03-1" },
  { kind: "ctx", text: "    deploy:" },
  { kind: "del", text: "      replicas: 2" },
  { kind: "add", text: "      replicas: 4" },
  { kind: "add", text: "      update_config:" },
  { kind: "add", text: "        order: start-first" },
  { kind: "add", text: "        failure_action: rollback" },
  { kind: "ctx", text: "    environment:" },
  { kind: "ctx", text: "      NODE_ENV: production" },
  {
    kind: "add",
    text: "      DATABASE_URL: postgres://storefront:${STOREFRONT_DB_PASSWORD}@postgres-primary.acme-production.internal:5432/storefront?sslmode=verify-full&application_name=storefront-web",
  },
  { kind: "del", text: "      LEGACY_SEARCH_URL: http://search-indexer:7700" },
  { kind: "ctx", text: "    healthcheck:" },
  { kind: "del", text: '      test: ["CMD", "curl", "-f", "http://localhost:3000/"]' },
  { kind: "add", text: '      test: ["CMD", "curl", "-fsS", "http://localhost:3000/api/health"]' },
  { kind: "add", text: "      start_period: 20s" },
  { kind: "ctx", text: "    networks:" },
  { kind: "ctx", text: "      - acme-production" },
];
