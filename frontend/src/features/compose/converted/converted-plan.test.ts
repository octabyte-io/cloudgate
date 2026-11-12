import { describe, expect, it } from "vitest";

import type { Compose } from "@/lib/api/endpoints/compose";
import type { Domain } from "@/lib/api/endpoints/domains";

import { convertedPlan, isolationPreview } from "./converted-plan";

const compose = (overrides: Partial<Compose> = {}): Compose =>
  ({
    appName: "wp-stack",
    composeType: "docker-compose",
    sourceType: "raw",
    isolatedDeployment: false,
    composeFile: "services:\n  wordpress:\n    image: wordpress:6\n",
    ...overrides,
  }) as Compose;

const titles = (plan: ReturnType<typeof convertedPlan>) =>
  plan.items.map((item) => item.title);

const toneOf = (plan: ReturnType<typeof convertedPlan>, match: string) =>
  plan.items.find((item) => item.title.includes(match))?.tone;

/** A compose domain routed into a service the fixture file declares. */
const domain = (serviceName: string): Domain =>
  ({
    domainId: "dom-1",
    host: "shop.example.com",
    serviceName,
    port: 80,
    https: false,
    uniqueConfigKey: 3,
  }) as Domain;

/**
 * The tab's whole job is being trusted, so what it claims the deploy will do is
 * asserted rather than eyeballed — a plan that is *wrong* is worse than no plan.
 *
 * These pin the half that is a claim about the **backend's** behaviour: the two
 * platform defaults `applyComposeDefaults` writes into the converted file.
 * Before those landed this card answered "Nothing." for an isolated stack with
 * no domains, which was true then and is false now — and that shape was exactly
 * the one the two defaults were added to reach, so it was the wrongest sentence
 * on the tab.
 */
describe("convertedPlan", () => {
  it("names both platform defaults for a docker-compose stack", () => {
    expect(titles(convertedPlan(compose(), []))).toContain(
      "Every service gets a log cap",
    );
    expect(titles(convertedPlan(compose(), []))).toContain(
      "Every service gets restart: unless-stopped",
    );
  });

  it("names the log cap but not a restart policy for a swarm stack", () => {
    const plan = convertedPlan(compose({ composeType: "stack" }), []);

    // `docker stack deploy` ignores `restart:` and warns about it on every
    // deploy, and Swarm restarts its own tasks — so claiming one here would be
    // the console promising something the deploy does not do.
    expect(titles(plan)).toContain("Every service gets a log cap");
    expect(titles(plan)).not.toContain(
      "Every service gets restart: unless-stopped",
    );
  });

  it("still lists the defaults for an isolated stack with no domains", () => {
    // The one shape `writeDomainsToCompose` used to return verbatim, which is
    // why this card used to say "Nothing." about it. There is no such answer
    // any more, and this is the case that proves it.
    const plan = convertedPlan(
      compose({ isolatedDeployment: true }),
      [] as Domain[],
    );

    expect(titles(plan)).toContain("No network is added to the file");
    expect(titles(plan)).toContain("Every service gets a log cap");
    expect(plan.items).not.toHaveLength(1);
    // The network item may not go back to claiming the file is untouched.
    const network = plan.items.find(
      (item) => item.title === "No network is added to the file",
    );
    expect(network?.detail).not.toContain("the file is unchanged");
  });

  /**
   * The headline. Both default rows carried `tone: "info"` whatever the
   * file said, so `plan-row.tsx` drew `○ no-op` beside them while the Changes
   * tab on the same card listed the twelve lines they added — and `docker
   * inspect` on the containers confirmed the rewrite rather than the marker.
   *
   * The rule being pinned is `applyComposeDefaults`': a `??=` per service, so
   * one service missing the key is a change and every service declaring it is
   * not. Asserted on `tone` rather than on the rendered glyph because this is
   * where the decision is made; `plan-row.tsx` only maps it.
   */
  it("marks both defaults as changes when no service declares either key", () => {
    const plan = convertedPlan(compose(), []);

    expect(toneOf(plan, "log cap")).toBe("add");
    expect(toneOf(plan, "restart: unless-stopped")).toBe("add");
  });

  it("marks both defaults no-op when every service declares both keys", () => {
    const plan = convertedPlan(
      compose({
        composeFile: [
          "services:",
          "  web:",
          "    image: nginx",
          "    restart: always",
          "    logging:",
          "      driver: none",
          "  cache:",
          "    image: redis:7-alpine",
          // `restart: false` and an empty `logging:` block are the two shapes a
          // truthiness check would call absent, and `??=` keeps both — so this
          // service is the one that proves the test reads the file the way the
          // backend writes it.
          "    restart: false",
          "    logging: {}",
          "",
        ].join("\n"),
      }),
      [],
    );

    expect(toneOf(plan, "already caps its own logs")).toBe("info");
    expect(toneOf(plan, "already declares its own restart")).toBe("info");
  });

  it("claims neither for a git source, whose file it cannot read", () => {
    // Not `○ no-op`, which is a statement that nothing happens, and not
    // `+ create` either: the clone may already carry both keys. The third mark
    // is the honest one and `fileChecked` says why.
    const plan = convertedPlan(compose({ sourceType: "github" }), []);

    expect(plan.fileChecked).toBe(false);
    expect(toneOf(plan, "log cap")).toBe("unknown");
    expect(toneOf(plan, "restart: unless-stopped")).toBe("unknown");
  });

  /**
   * The other half: `+ create · Every routed service joins
   * cloudgate-network` on a stack with no domains, where the routed set is
   * empty and both containers came up on the project's own default network and
   * nothing else. The root declaration is real — `addDomainsToComposeSpec` ends
   * on `if (!isolatedDeployment || domains.length > 0)` — so the row stays a
   * change and says which one.
   */
  it("does not claim a service joins cloudgate-network with no domains", () => {
    const plan = convertedPlan(compose(), []);
    const network = plan.items.find((item) =>
      item.title.includes("cloudgate-network"),
    );

    expect(network?.title).toBe(
      "cloudgate-network is declared at the file's root, and nothing joins it",
    );
    expect(network?.detail).toContain("no service is joined");
    // The line really is added, so the mark is not a no-op either.
    expect(network?.tone).toBe("add");
  });

  it("says every routed service joins it once a domain is attached", () => {
    const plan = convertedPlan(compose(), [domain("wordpress")]);

    expect(titles(plan)).toContain(
      "Every routed service joins cloudgate-network",
    );
  });

  // Swarm keeps deploy.labels on the service, where Traefik's docker
  // provider never reads them, so a stack's Domain is routed by the config file
  // the backend writes — and the plan may not promise labels.
  it("routes a Swarm stack's Domain by Traefik's config file, not by labels", () => {
    const plan = convertedPlan(compose({ composeType: "stack" }), [
      { ...domain("wordpress"), https: true },
    ]);
    const routing = plan.items.find((item) => item.service === "wordpress");

    expect(routing?.title).toBe(
      "Traefik routing for shop.example.com into wordpress",
    );
    expect(routing?.detail).toContain(
      "wp-stack-router-3 on web, and wp-stack-router-websecure-3 on websecure",
    );
    expect(routing?.detail).toContain("wp-stack_wordpress on port 80");
    const said = plan.items.map((item) => item.detail).join(" ");
    expect(said).not.toContain("They go under");
    expect(said).not.toMatch(/traefik\.\w+\.network/);
  });

  it("says a declared key wins, because that is the rule the backend applies", () => {
    const details = convertedPlan(compose(), []).items.map(
      (item) => item.detail,
    );

    // Presence is the author's statement; absence is the platform's default.
    // If this sentence ever stops being true of `applyComposeDefaults`, the tab
    // is lying about the operator's own file and this is what catches it.
    expect(details.join(" ")).toContain(
      "keeps it exactly as written, an uncapped one included",
    );
    expect(details.join(" ")).toContain(
      "keeps it, including restart: no",
    );
  });
});

/**
 * Advanced → Network isolation listed its effects from two fixed arrays that
 * never looked at the stack (the third site). A stack *with* a domain,
 * switched on, was shown `○ no-op · leave the file's own networks alone —
 * nothing is added to the services and nothing to the root` and `○ no-op · with
 * no domains configured, change nothing but the two defaults` — and the deploy
 * that followed put `networks: [<appName>, default]` on the routed service,
 * declared the network external at the root, labelled it and connected Traefik
 * to it. Both no-ops were changes.
 */
describe("isolationPreview", () => {
  const marks = (lines: ReturnType<typeof isolationPreview>) =>
    lines.map((line) => line.change);

  it("calls the isolated file rewrite a change when a domain is attached", () => {
    const lines = isolationPreview({
      appName: "wp-stack",
      swarm: false,
      isolated: true,
      domainCount: 1,
    });

    // Two creates: the network itself, and what the rewrite does to the file.
    expect(marks(lines)).toEqual(["create", "create", "noop"]);
    expect(lines[1].text).toContain("declare it external at the file's root");
    expect(lines[1].text).toContain("traefik.docker.network");
    // The sentence that was wrong may not come back.
    expect(lines.map((line) => line.text).join(" ")).not.toContain(
      "nothing is added to the services and nothing to the root",
    );
  });

  it("keeps the no-op for an isolated stack with no domains, which is the one shape it was true of", () => {
    const lines = isolationPreview({
      appName: "wp-stack",
      swarm: false,
      isolated: true,
      domainCount: 0,
    });

    expect(marks(lines)).toEqual(["create", "noop", "noop"]);
    expect(lines[1].text).toContain("nothing is added to the services");
  });

  it("adds only the root declaration with isolation off and no domains", () => {
    const lines = isolationPreview({
      appName: "wp-stack",
      swarm: false,
      isolated: false,
      domainCount: 0,
    });

    expect(lines[0].text).toContain("no service joins it");
    expect(lines.map((line) => line.text).join(" ")).not.toContain(
      "add cloudgate-network to every service",
    );
  });

  // The off deploy now releases the network an isolated one created,
  // so switching it off says so — and only then, since a stack that was never
  // isolated has no such network and the release is a no-op for it.
  it("says the stack's own network goes when isolation is switched off", () => {
    const off = (wasIsolated: boolean) =>
      isolationPreview({
        appName: "wp-stack",
        swarm: false,
        isolated: false,
        wasIsolated,
        domainCount: 1,
      });

    expect(off(true)[0]).toEqual({
      change: "destroy",
      text: "detach the Traefik container from wp-stack and remove that network, once nothing else is on it",
    });
    expect(marks(off(false))).not.toContain("destroy");
  });

  // A Swarm overlay is not released by a deploy — its tasks may be on other
  // nodes, where this node cannot see them — so switching a stack off may not
  // promise it; the delete removes it.
  it("leaves a Swarm stack's overlay to the delete when isolation is switched off", () => {
    const lines = isolationPreview({
      appName: "wp-stack",
      swarm: true,
      isolated: false,
      wasIsolated: true,
      domainCount: 1,
    });

    expect(marks(lines)).not.toContain("destroy");
    expect(lines[0]).toEqual({
      change: "noop",
      text: "leave the overlay network wp-stack, and the Traefik container on it, until the stack is deleted",
    });
  });

  it("claims neither while the domains are still loading", () => {
    const lines = isolationPreview({
      appName: "wp-stack",
      swarm: true,
      isolated: true,
      domainCount: null,
    });

    expect(marks(lines)).toEqual(["create", "change", "noop"]);
    // A Swarm stack's network is an overlay, and its services get no network
    // label: Traefik reaches them through its config file.
    expect(lines[0].text).toContain("attachable overlay network");
    expect(lines[1].text).not.toMatch(/traefik\.\w+\.network/);
  });
});
