import { describe, expect, it } from "vitest";

import type { MetricsConfig } from "@/lib/api/endpoints/servers";

import {
  exclusionsFor,
  stopCollecting,
  toMetricsConfig,
  valuesFor,
} from "./metrics-config-spec";

/**
 * `toMetricsConfig` reads the metrics agent token, and has one thing it now has
 * to get right (`configCollects`, the other reader, is `lib/format/sampling.ts`
 * and pinned beside it): `GET /settings/web-server` projects that
 * token out of the response — it is the whole of `POST /notifications/receive`'s
 * authentication and the copy on the settings singleton fans a forged alert out
 * to *every* organization, on a route open to any authenticated member — and
 * sends `server.hasToken` in its place.
 *
 * That is a projection with a *write* path hanging off it, which is the only
 * reason a bare presence flag was not free. `toMetricsConfig` used to re-submit
 * `stored.token` unchanged so that saving a threshold tweak would not rotate a
 * value someone may have configured an external agent with. It cannot read that
 * value any more, so it omits the field and the route keeps what is stored — and
 * an omitted token, an empty one and a fresh one now mean three different
 * things. That distinction has no type to protect it (`token?: string` admits
 * all three), so it is asserted here.
 *
 * Configs are written out field by field rather than built by a factory that
 * mirrors `MetricsConfig`, on `container-targets.test.ts`' argument: a wrong
 * expectation must not be able to agree with the code.
 */
function config(server: Partial<MetricsConfig["server"]>): MetricsConfig {
  return {
    server: {
      type: "Cloudgate",
      refreshRate: 30,
      port: 4500,
      urlCallback: "http://cloudgate.example.com/api/notifications/receive",
      retentionDays: 3,
      cronJob: "0 3 * * *",
      thresholds: { cpu: 80, memory: 85 },
      ...server,
    },
    containers: {
      refreshRate: 45,
      services: { include: ["web"], exclude: [] },
    },
  };
}

/** The web server's shape: the credential projected out, its presence reported. */
const projected = (hasToken: boolean) => config({ hasToken });

/** A `server` row's shape: the route still sends the value. */
const withValue = (token: string) => config({ token });

describe("toMetricsConfig", () => {
  const values = valuesFor(projected(true));

  it("omits the token when the host has one the console cannot see", () => {
    const body = toMetricsConfig(projected(true), values);

    // Omitted, not empty: `''` is "stop collecting" and would tear the
    // intervals down on a save that only changed a threshold.
    expect(body.server.token).toBeUndefined();
    expect("token" in body.server).toBe(true);
    expect(JSON.stringify(body)).not.toContain('"token"');
  });

  it("generates one when the host has none", () => {
    const body = toMetricsConfig(projected(false), values);

    expect(body.server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends a `server` row's own token back unchanged", () => {
    // The per-Server dialog shares this function and its route still carries
    // the value, so the original carry-through has to keep working: a save
    // there must not rotate the token either.
    const body = toMetricsConfig(withValue("metrics-token-1"), values);

    expect(body.server.token).toBe("metrics-token-1");
  });

  it("generates one for a `server` row whose token is empty", () => {
    const body = toMetricsConfig(withValue(""), values);

    expect(body.server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("carries the fields the form does not show through untouched", () => {
    // The reason the projection could not simply drop `token` and be done:
    // `port` and `urlCallback` are carried the same way, and a host configured
    // for a real external agent must not have either quietly replaced.
    const body = toMetricsConfig(projected(true), values);

    expect(body.server.port).toBe(4500);
    expect(body.server.urlCallback).toBe(
      "http://cloudgate.example.com/api/notifications/receive",
    );
  });
});

describe("stopCollecting", () => {
  it("sends an empty token, which is the only thing that clears the switch", () => {
    // Explicitly `''` and never omitted — omitted is the opposite instruction
    // now, and this is the one caller entitled to send an empty one.
    expect(stopCollecting(projected(true)).server.token).toBe("");
    expect(stopCollecting(withValue("metrics-token-1")).server.token).toBe("");
  });
});

/**
 * The question the console was sending to the backend and could answer itself
 * is this name
 * one the operator excluded?
 *
 * Collection checks the exclusions first and an exclusion beats an inclusion, so
 * a name in both boxes is never sampled — and the read, which resolves names
 * against stored rows, cannot tell that name from one nobody has ever heard of.
 * It refused both with "nothing running here matches that name, or collection
 * has not stored its first sample yet", which on this path is two false causes
 * and not the true one.
 *
 * The line the cases below draw is what may be *claimed*: both lists match as
 * substrings of the container's name, so an entry inside the queried name
 * catches everything that name can reach, and an entry the queried name sits
 * inside does not.
 */
describe("exclusionsFor", () => {
  const services = (exclude: string[]): MetricsConfig => ({
    ...config({ hasToken: true }),
    containers: {
      refreshRate: 10,
      services: { include: ["app-nk3zbo"], exclude },
    },
  });

  it("names the entry that excludes a name typed into both boxes", () => {
    expect(exclusionsFor(services(["app-nk3zbo"]), "app-nk3zbo")).toEqual([
      "app-nk3zbo",
    ]);
  });

  it("catches a shorter entry, because both lists match as substrings", () => {
    expect(exclusionsFor(services(["nk3zbo"]), "app-nk3zbo")).toEqual([
      "nk3zbo",
    ]);
  });

  it("claims nothing for an entry that only overlaps the name", () => {
    // `app` included, `app-nk3zbo` excluded: some containers under `app` are
    // caught and some are not, and the config does not say which.
    expect(exclusionsFor(services(["app-nk3zbo"]), "app")).toEqual([]);
  });

  it("does not let a blank entry exclude the world", () => {
    // A textarea line of spaces survives `toList`'s trim only as far as the
    // stored config; `"anything".includes("")` is true, so it has to be dropped.
    expect(exclusionsFor(services(["", "   "]), "app-nk3zbo")).toEqual([]);
  });

  it("excludes nothing when there is no config to read", () => {
    expect(exclusionsFor(null, "app-nk3zbo")).toEqual([]);
  });
});
