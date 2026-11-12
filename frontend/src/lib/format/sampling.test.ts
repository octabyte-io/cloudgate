import { describe, expect, it } from "vitest";

import type { MetricsConfig } from "@/lib/api/endpoints/servers";

import {
  configCollects,
  retentionDeletion,
  retentionSpan,
  samplingState,
} from "./sampling";

/**
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

describe("configCollects", () => {
  it("reads the flag when the route projected the token out", () => {
    expect(configCollects(projected(true))).toBe(true);
    expect(configCollects(projected(false))).toBe(false);
  });

  it("reads the value when the route still sends it", () => {
    expect(configCollects(withValue("metrics-token-1"))).toBe(true);
    // `defaultMetricsConfig` ships `''`, which is what "never set up" means to
    // `registerTarget` and to `authenticatesMetricsAgent`.
    expect(configCollects(withValue(""))).toBe(false);
    expect(configCollects(withValue("   "))).toBe(false);
  });

  it("prefers the flag over the value when both arrive", () => {
    // The flag is the server's own answer about its own row. A response
    // carrying both is either an older backend behind a newer one or a
    // projection that leaked — in neither case is the value the better source.
    expect(configCollects(config({ hasToken: false, token: "leaked" }))).toBe(
      false,
    );
  });

  it("is false for a host that has no config at all", () => {
    expect(configCollects(null)).toBe(false);
  });
});

/**
 * The token is one bit of three states. A stopped host has an empty token
 * and a `cronJob` a setup wrote; a host nobody set up has neither, because both
 * declared defaults ship `cronJob: ''` and both setup routes refuse it empty.
 */
describe("samplingState", () => {
  it("is collecting while a token is set, by flag or by value", () => {
    expect(samplingState(config({ hasToken: true }))).toBe("collecting");
    expect(samplingState(config({ token: "metrics-token-1" }))).toBe(
      "collecting",
    );
  });

  it("is stopped when the token was cleared and the setup it made is kept", () => {
    expect(samplingState(config({ hasToken: false }))).toBe("stopped");
    expect(samplingState(config({ token: "" }))).toBe("stopped");
  });

  it("is never for a config no setup has been saved over, or none at all", () => {
    expect(samplingState(config({ token: "", cronJob: "" }))).toBe("never");
    expect(samplingState(config({ hasToken: false, cronJob: "  " }))).toBe(
      "never",
    );
    expect(samplingState(null)).toBe("never");
  });
});

/**
 * The clause every stopped-state screen says about the samples it still shows.
 * Written out whole, spaces included, because the JSX it replaced shipped
 * "more than 2 daysold" — so these are `toBe`, never a pattern that
 * would tolerate the join.
 */
describe("retentionSpan", () => {
  it("agrees the unit with the count", () => {
    expect(retentionSpan(config({ retentionDays: 1 }))).toBe("1 day");
    expect(retentionSpan(config({ retentionDays: 3 }))).toBe("3 days");
  });

  it("reads the backend's default of 2 for a config that has none", () => {
    expect(retentionSpan(config({ retentionDays: 0 }))).toBe("2 days");
    expect(retentionSpan(null)).toBe("2 days");
  });
});

describe("retentionDeletion", () => {
  it("says when the samples go and what deletes them", () => {
    expect(retentionDeletion(config({ retentionDays: 2 }))).toBe(
      "deleted once it is more than 2 days old, by the retention cleanup that goes on running",
    );
    expect(retentionDeletion(config({ retentionDays: 1 }))).toBe(
      "deleted once it is more than 1 day old, by the retention cleanup that goes on running",
    );
  });
});
