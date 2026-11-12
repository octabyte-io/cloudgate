import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { MetricsConfig } from "@/lib/api/endpoints/servers";

import type { ContainerTarget } from "./container-targets";

const useContainerMetrics = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: the HTTP read. The branch
// under test is the card's own, and it is reached from the card's own props.
vi.mock("./use-monitoring", async (original) => ({
  ...(await original<typeof import("./use-monitoring")>()),
  useContainerMetrics,
}));

const { ContainerMetricsCard } = await import("./containers-card");

afterEach(() => {
  cleanup();
  useContainerMetrics.mockReset();
});

/**
 * **What a row says when it has nothing to draw**.
 *
 * Putting one running service in both "Collect container metrics for" and
 * "Never collect for" is a thing the form invites — the two boxes sit one above
 * the other — and the exclusion wins, as the form's own hint says. The row for
 * that name then explained itself with the read's refusal: "Either nothing
 * running here matches that name, or collection has not stored its first sample
 * yet." Driven on a box, both halves were false: the container was `Up 3 days`
 * and offered in the live card's picker on the same screen, and the store held 0
 * rows for it against 21 for the included service beside it. The one true cause
 * — the operator's own exclusion — was the only one not offered, and it is the
 * only one they can act on.
 *
 * The refusal is the *right* answer for a name that is neither running nor
 * excluded, so the case that must not regress is the second one below. Both
 * configs are written out field by field rather than derived from a factory with
 * overrides, on `container-targets.test.ts`' argument.
 */
function config(services: {
  include: string[];
  exclude: string[];
}): MetricsConfig {
  return {
    server: {
      type: "Remote",
      refreshRate: 10,
      port: 4500,
      token: "metrics-token-1",
      urlCallback: "",
      retentionDays: 2,
      cronJob: "0 3 * * *",
      thresholds: { cpu: 0, memory: 0 },
    },
    containers: { refreshRate: 10, services },
  };
}

/**
 * The refusals the read really sends, quoted from
 * `backend/src/monitoring/monitoring.service.ts`' `unresolvedAppNameRefusal`.
 * The console renders a 400's message through `errorMessage`, so what it puts on
 * screen for a name it does not answer for itself is exactly this text — and a
 * fixture that invented its own wording would prove nothing about that.
 */
const REFUSAL = new ApiError(
  400,
  'No container you can read has been sampled under "app-nk3zbo" on this ' +
    "server. Either nothing running here that you can read matches that name, " +
    "or collection has not stored its first sample yet.",
  { path: "/monitoring/metrics/containers" },
);

/** The hedged one, for an entry that suppresses only part of what a name names. */
const PARTIAL_REFUSAL = new ApiError(
  400,
  'No container you can read has been sampled under "app" on this server. ' +
    "This target's " +
    'exclude list holds "app-nk3zbo" (containers.services.exclude, "Never ' +
    'collect for" in the console), which collection checks before the include ' +
    "list and which suppresses some — not necessarily all — of the containers " +
    "this name matches, so it may be the reason. Otherwise nothing running " +
    "here that you can read matches that name, or collection has not stored " +
    "its first sample yet.",
  { path: "/monitoring/metrics/containers" },
);

function row(
  services: { include: string[]; exclude: string[] },
  error: ApiError = REFUSAL,
) {
  useContainerMetrics.mockReturnValue({
    data: undefined,
    error,
    isPending: false,
  });
  const target: ContainerTarget = {
    id: null,
    name: "this host",
    config: config(services),
  };
  render(<ContainerMetricsCard targets={[target]} range="1h" />);
  return document.body.textContent ?? "";
}

describe("ContainerMetricsCard", () => {
  it("explains an excluded name by the exclusion the operator typed", () => {
    // One included name, so the assertions below are about its row alone — the
    // included service beside it on the box renders normally and is not the case.
    const text = row({ include: ["app-nk3zbo"], exclude: ["app-nk3zbo"] });

    expect(text).toContain("Never collect for");
    expect(text).toContain("an exclusion beats the inclusion above it");
    expect(text).toContain("nothing will be until that entry is removed");
    // The two false causes, neither of which may reach the operator here: the
    // container is running, and no first sample is coming.
    expect(text).not.toContain("nothing running here that you can read");
    expect(text).not.toContain("has not stored its first sample yet");
    // "yet" is the claim the chip made too.
    expect(text).not.toContain("nothing sampled under this name yet");
  });

  it("keeps the read's own refusal for a name that is not excluded", () => {
    const text = row({ include: ["app-nk3zbo"], exclude: [] });

    expect(text).toContain("nothing running here that you can read matches that name");
    expect(text).toContain("nothing sampled under this name yet");
    expect(text).not.toContain("Never collect for");
  });

  it("passes the read's hedged refusal through for an entry that only overlaps the name", () => {
    // `app-nk3zbo` excluded while `app` is included catches some containers and
    // not others, and which is which is not in the config — so the console must
    // not write its own confident sentence here. The read hedges instead, and
    // that sentence is what the row shows.
    const text = row({ include: ["app"], exclude: ["app-nk3zbo"] }, PARTIAL_REFUSAL);

    expect(text).toContain("not necessarily all");
    expect(text).toContain("it may be the reason");
    // The console's own certain sentence, which this case does not license.
    expect(text).not.toContain("an exclusion beats the inclusion above it");
    expect(text).not.toContain("nothing will be until that entry is removed");
  });
});
