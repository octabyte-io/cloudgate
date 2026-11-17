import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { ComposeDetail, ComposeType } from "@/lib/api/endpoints/compose";

import { ComposeActions } from "./compose-actions";

afterEach(cleanup);

function stack(
  composeType: ComposeType,
  overrides: Partial<ComposeDetail> = {},
) {
  return {
    composeId: "cmp-1",
    environmentId: "env-1",
    name: "invoices",
    appName: "invoices-a1b2c3",
    composeType,
    sourceType: "raw",
    composeFile: "services:\n  web:\n    image: nginx\n",
    ...overrides,
  } as ComposeDetail;
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const named = (name: string) => screen.queryByRole("button", { name });

/**
 * The row's rule is that a control which would do nothing for a service type is
 * **absent** rather than rendered off, and Remove containers is a second
 * control that rule applies to. Both halves are asserted, because the failure
 * this guards is the plausible one: a disabled Remove containers on a Swarm
 * stack, which reads as "not right now" about something that is never coming.
 */
describe("ComposeActions", () => {
  it("offers Remove containers on a docker-compose stack, beside Stop", () => {
    render(withQuery(<ComposeActions compose={stack("docker-compose")} />));

    expect(named("Remove containers")).not.toBe(null);
    expect(named("Stop")).not.toBe(null);
    expect(named("Start")).not.toBe(null);
  });

  it("leaves Remove containers off a Swarm stack entirely", () => {
    render(withQuery(<ComposeActions compose={stack("stack")} />));

    // Not rendered at all — no `aria-disabled` button of that name either, which
    // is what `queryByRole` would still have found.
    expect(named("Remove containers")).toBe(null);
    // Start is absent for the same reason and has been since F12; Stop is the
    // one that stays, because `docker stack rm` is what it runs there.
    expect(named("Start")).toBe(null);
    expect(named("Stop")).not.toBe(null);
  });

  /**
   * `volumes: {}` parses, so neither `composeFileIsEmpty` nor the Services
   * strip's `[]` stopped it: the button offered a Deployment that replaced the
   * project file the running containers came from and then failed on Docker's
   * `no service selected`. The backend refuses it in front of that write now,
   * and this is the half that stops offering it.
   */
  it("offers no Deploy for a raw file that parses and declares no services", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeFile: "volumes: {}\n" })}
        />,
      ),
    );

    const deploy = named("Deploy");
    expect(deploy?.getAttribute("aria-disabled")).toBe("true");
    // Its own sentence, not the empty file's: this one has been written to.
    expect(deploy?.getAttribute("title")).toBe(
      "There is nothing to deploy — the compose file declares no services. Add one on the Overview tab first.",
    );
  });

  it("still offers Deploy for a file that declares one", () => {
    render(withQuery(<ComposeActions compose={stack("docker-compose")} />));

    expect(named("Deploy")?.getAttribute("aria-disabled")).toBe(null);
  });

  it("says what Remove containers runs, in the words Stop uses", () => {
    render(withQuery(<ComposeActions compose={stack("docker-compose")} />));

    expect(named("Remove containers")?.getAttribute("title")).toBe(
      "docker compose rm --stop --force — the containers are removed. Start recreates them.",
    );
  });
});

/**
 * A stack no Deploy has run has nothing on its deploy target to start
 * or stop, so both are off with the reason under the row, the way Deploy is off
 * over an empty file.
 */
describe("ComposeActions before the first Deploy", () => {
  it("turns Start and Stop off on a never-deployed stack and says why", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeStatus: "idle" })}
        />,
      ),
    );

    for (const name of ["Start", "Stop"]) {
      expect(named(name)?.getAttribute("aria-disabled")).toBe("true");
    }
    expect(named("Deploy")?.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByText(/Deploy puts it there/)).toBeTruthy();
  });

  it("puts the reason under the whole row, after its last button, and describes Start and Stop by it", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeStatus: "idle" })}
        />,
      ),
    );

    const reason = screen.getByText(/Deploy puts it there/);
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)?.textContent).toBe("Remove containers");
    expect(
      buttons.at(-1)!.compareDocumentPosition(reason) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const name of ["Start", "Stop"]) {
      expect(named(name)?.getAttribute("aria-describedby")).toBe(reason.id);
    }
  });

  it("leaves them live on a stack that has been deployed", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeStatus: "stopped" })}
        />,
      ),
    );

    expect(named("Start")?.getAttribute("aria-disabled")).toBeNull();
    expect(named("Stop")?.getAttribute("aria-disabled")).toBeNull();
  });
});

/**
 * The Logs, Deployments and Containers empty states repeated the
 * header's whole row, misaligned, with Stop and Remove containers offered on
 * a stack never deployed. An empty state offers Deploy alone.
 */
describe("ComposeActions in an empty state", () => {
  it.each(["docker-compose", "stack"] as const)(
    "offers only Deploy on a %s, and no reason line beside it",
    (type) => {
      render(
        withQuery(
          <ComposeActions
            compose={stack(type, { composeStatus: "idle" })}
            size="sm"
            deployOnly
          />,
        ),
      );

      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
        "Deploy",
      ]);
      expect(document.body.textContent).not.toContain(
        "nothing to start",
      );
    },
  );

  it("offers Start, the way back its sentence names, on a stopped stack", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeStatus: "stopped" })}
          size="sm"
          deployOnly
        />,
      ),
    );

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Start",
    ]);
  });

  it.each([
    ["a stopped Swarm stack, which has no Start", "stack", "stopped"],
    ["a stack meant to be up", "docker-compose", "done"],
    ["a stack whose last Deployment failed", "docker-compose", "error"],
  ] as const)("offers Deploy on %s", (_case, type, composeStatus) => {
    render(
      withQuery(
        <ComposeActions
          compose={stack(type, { composeStatus })}
          size="sm"
          deployOnly
        />,
      ),
    );

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Deploy",
    ]);
  });
});

/**
 * Restart is no longer a Stack VM's fifth button: it takes Start's slot on
 * any `docker-compose` stack whose containers are up, and the cases are in
 * `compose-actions-restart.test.tsx`. What stays here is the rule that the
 * row never offers both.
 */
describe("ComposeActions: Start and Restart share one slot", () => {
  it.each([
    ["on a Server", null],
    ["on a Stack VM", "acct-1"],
  ])("never offers both %s", (_, cloudAccountId) => {
    for (const composeStatus of ["idle", "done", "error", "stopped"] as const) {
      render(
        withQuery(
          <ComposeActions
            compose={stack("docker-compose", { composeStatus, cloudAccountId })}
          />,
        ),
      );
      expect(
        [named("Start"), named("Restart")].filter((b) => b !== null),
      ).toHaveLength(1);
      cleanup();
    }
  });
});

/**
 * Once a stack is deployed, Deploy sits beside Restart, and the two read
 * alike to someone who wants a change picked up. Its title says what it
 * does then. Before the first Deploy there is nothing to compare it with.
 */
describe("ComposeActions: Deploy's title once deployed", () => {
  it("says it deploys the file as it is now, and what it does to images", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeStatus: "done" })}
        />,
      ),
    );

    expect(named("Deploy")?.getAttribute("title")).toBe(
      "Deploys the compose file as it is now, with every change since the last Deployment. Services with a build are built again; an image already on the deploy target is pulled again only if its pull_policy says so.",
    );
  });

  it("drops the build half for a Swarm stack", () => {
    render(
      withQuery(
        <ComposeActions compose={stack("stack", { composeStatus: "done" })} />,
      ),
    );

    expect(named("Deploy")?.getAttribute("title")).toBe(
      "Deploys the compose file as it is now, with every change since the last Deployment.",
    );
  });

  it("has no title on a stack never deployed", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", { composeStatus: "idle" })}
        />,
      ),
    );

    expect(named("Deploy")?.hasAttribute("title")).toBe(false);
  });

  it("keeps the empty file's reason over the hint", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", {
            composeStatus: "done",
            composeFile: "",
          })}
        />,
      ),
    );

    expect(named("Deploy")?.getAttribute("title")).toMatch(
      /the compose file is empty/,
    );
  });
});

