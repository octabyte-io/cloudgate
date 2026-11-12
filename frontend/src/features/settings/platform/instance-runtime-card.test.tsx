import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Probe, RuntimeInfo } from "@/lib/api/endpoints/settings";
import type { RuntimeInfoQuery } from "@/lib/api/use-runtime-info";

const useRuntimeInfo = vi.hoisted(() => vi.fn());

// Only the read is replaced. `isRefusal` comes from the same module and is the
// branch under test in half of these, so mocking the module wholesale would
// stub out the thing being checked.
vi.mock("@/lib/api/use-runtime-info", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-runtime-info")>()),
  useRuntimeInfo,
}));

const { RuntimeCard } = await import("./instance-runtime-card");

afterEach(() => {
  cleanup();
  useRuntimeInfo.mockReset();
});

function probe<T>(observed: T | null, over: Partial<Probe<T>> = {}): Probe<T> {
  return { declared: null, observed, scope: "host", drift: false, ...over };
}

/** A stock healthy platform host: everything answered, nothing disagreeing. */
function payload(over: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    serverId: null,
    observedAt: "2026-08-26T10:00:00.000Z",
    cloudgate: {
      scope: "process",
      version: "1.4.0",
      releaseTag: "v1.4.0",
      node: "v22.14.0",
      uptimeSeconds: 7_200,
    },
    postgres: probe("17.2", { scope: "process" }),
    traefik: probe("3.6.7", { declared: "3.6.7" }),
    docker: probe("29.7.2", { declared: "28.5.0", drift: true }),
    swarm: probe("active"),
    operatingSystem: probe("Ubuntu 24.04.2 LTS"),
    kernel: probe("Linux 6.8.0-45-generic"),
    uptimeSeconds: probe(3_564_000),
    cloudgateNetwork: probe(true),
    directory: { path: "/etc/cloudgate", freeBytes: 10, totalBytes: 20 },
    ...over,
  };
}

function answered(over: Partial<RuntimeInfo> = {}): RuntimeInfoQuery {
  return {
    data: payload(over),
    error: null,
    isPending: false,
  } as unknown as RuntimeInfoQuery;
}

function threw(status: number, code?: string): RuntimeInfoQuery {
  return {
    data: undefined,
    error: new ApiError(
      status,
      "Only owners and admins can manage web server settings",
      code ? { code } : undefined,
    ),
    isPending: false,
  } as unknown as RuntimeInfoQuery;
}

function said(query: RuntimeInfoQuery) {
  useRuntimeInfo.mockReturnValue(query);
  render(<RuntimeCard />);
  return document.body.textContent ?? "";
}

/** What one group of rows says, addressed by the scope the payload gave it. */
function group(scope: "host" | "process") {
  return document.querySelector(`dl[data-scope="${scope}"]`)?.textContent ?? "";
}

/**
 * The platform host's own observed runtime — the screen a `Server`-less
 * instance had none of.
 *
 * The two things worth breaking here are the two the issue is about: that a
 * fact about the machine and a fact about the backend process are told apart
 * rather than flattened, and that the platform host's meaningless
 * `docker.drift` is not rendered as a warning nobody can act on.
 */
describe("RuntimeCard", () => {
  it("tells a reading off the machine apart from one about the process", () => {
    said(answered());

    // The same label, one group apart, and two true answers: a backend two
    // hours old on a machine up six weeks. Flattening these into one list is
    // the original defect, drawn on a screen.
    expect(group("host")).toContain("41d 6h");
    expect(group("host")).not.toContain("2h 00m");
    expect(group("process")).toContain("2h 00m");
    expect(group("process")).not.toContain("41d 6h");

    // Postgres is the reading that pointed at the wrong machine: it is
    // the process's database connection, never a database on this host.
    expect(group("process")).toContain("17.2");
    expect(group("host")).toContain("Ubuntu 24.04.2 LTS");
    expect(group("host")).not.toContain("17.2");
  });

  it("groups a reading where the payload puts it rather than where the card assumes", () => {
    // The whole promise is that no consumer carries a list of which keys are
    // the exceptions. Move Postgres to the host and the row moves with it — if
    // the grouping were a hardcoded key list this is the assertion that fails.
    said(answered({ postgres: probe("17.2", { scope: "host" }) }));

    expect(group("host")).toContain("17.2");
    expect(group("process")).not.toContain("17.2");
  });

  it("keeps every row for a plain member instead of becoming an error card", () => {
    const text = said(threw(403));

    expect(text).toContain("Docker");
    expect(text).toContain("Ingress");
    expect(text).toContain("Operating system");
    expect(text).toContain("Kernel");
    expect(text).toContain("Postgres");
    expect(text).toContain("Only an owner or an admin can take these readings");
    // Every value is absent and says which kind of absence it is.
    expect(text).toContain("Not read");
    expect(text).not.toContain("Not known");
    // A 403 is a role, not a reading: nothing here failed and nothing says so.
    expect(text).not.toContain("Your role in this Organization");
    // §3.5 — never `ApiError.message`.
    expect(text).not.toContain("Only owners and admins can manage web server");
  });

  /**
   * The same status, one code apart (H-48).
   *
   * `isRefusal` read `status === 403`, so a **banned** operator kept the whole
   * card, every row emptied, under a sentence saying an owner or an admin could
   * take these readings for them — and every one of those ten `Not read` dashes
   * was a claim that the machine was fine and only the reader's role was in the
   * way. Their role is not in the way, no owner can change it into one that
   * works, and the ban is the only fact worth putting on this card.
   *
   * `SectionFailed` is where it lands, which is the branch this card already had
   * for a request that did not land — and it renders `errorMessage()`, so the
   * sentence is `AUTH_SENTENCES`' one rather than a second copy written here.
   */
  it("names the ban rather than emptying the card behind a role sentence", () => {
    const text = said(threw(403, "BANNED_USER"));

    expect(text).toContain("This account has been banned. Ask an owner to lift the ban.");
    expect(text).not.toContain("Only an owner or an admin can take these readings");
    expect(text).not.toContain("Not read");
    // Nothing was read, so nothing is listed as if it had been.
    expect(text).not.toContain("Operating system");
  });

  it("states the failure when the request itself did not land", () => {
    const text = said(threw(500));

    expect(text).toContain("The backend hit an error handling that");
    // Nothing was read, so nothing is listed as if it had been.
    expect(text).not.toContain("Operating system");
  });

  it("reads as not known, not as an error, when the host answered nothing", () => {
    const text = said(
      answered({
        docker: probe(null, {
          declared: "28.5.0",
          reason: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        }),
      }),
    );

    // A stopped daemon is a 200. The row says the reading is absent and nothing
    // on the card goes red, because nothing is known to be wrong.
    expect(text).toContain("Not known");
    // The backend's `reason` is truncated host stderr, written for whoever
    // reads the logs — the same rule `IngressRow` keeps.
    expect(text).not.toContain("unix:///var/run/docker.sock");
  });

  it("distinguishes a network known to be absent from one not known", () => {
    expect(said(answered({ cloudgateNetwork: probe(false) }))).toContain(
      "not created",
    );
    cleanup();
    // `false` is a reading; only `null` is the absence of one.
    expect(said(answered({ cloudgateNetwork: probe<boolean>(null) }))).toContain(
      "Not known",
    );
  });

  it("names the pinned Traefik version beside the running one when they differ", () => {
    // `install.sh` and `server-setup.ts` read the same `TRAEFIK_VERSION` and
    // the platform host's container is started from it, so this disagreement is
    // real and actionable: the pin moved and the container was never recreated.
    const text = said(
      answered({
        traefik: probe("3.5.0", { declared: "3.6.7", drift: true }),
      }),
    );

    expect(text).toContain("Traefik 3.5.0");
    expect(text).toContain("declared 3.6.7");
  });

  it("does not repeat the Traefik pin beside an identical running version", () => {
    const text = said(answered());

    expect(text).toContain("Traefik 3.6.7");
    // Noise on every healthy install, and what stops the row above being
    // scannable on the one install where it matters.
    expect(text).not.toContain("declared 3.6.7");
  });

  it("shows the platform host's Docker without a drift nobody can act on", () => {
    // The stock install: `deploy/install.sh` installs this machine's Docker
    // with no `--version`, while `server-setup.ts` pins a Server's — so
    // `docker.drift` is true on virtually every instance and `docker.declared`
    // is not a claim about this host at all.
    const text = said(answered());

    expect(text).toContain("29.7.2");
    expect(text).not.toContain("28.5.0");
    expect(text).not.toContain("declared 28.5.0");
    // The reader is owed the reason rather than a silent omission.
    expect(text).toContain("nothing pins this machine");
  });

  it("says nothing has arrived yet while the reading is in flight", () => {
    useRuntimeInfo.mockReturnValue({
      data: undefined,
      error: null,
      isPending: true,
    } as unknown as RuntimeInfoQuery);
    render(<RuntimeCard />);

    expect(document.querySelector('[aria-busy="true"]')).not.toBe(null);
    expect(document.body.textContent).not.toContain("Not known");
  });
});
