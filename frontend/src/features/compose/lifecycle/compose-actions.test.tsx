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
 * or stop, so both are off with the reason beside them, the way Deploy is off
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
        "nothing to start or stop",
      );
    },
  );
});

/**
 * A stack on its own Stack VM (ADR-0070, #1370) gets Restart: its
 * containers restart through the cloud's tunnel and the VM does not. A
 * stack on a Server restarts a container from the Containers tab, as it
 * always has, so it gets no fifth control.
 */
describe("ComposeActions on a Stack VM", () => {
  it("offers Restart, saying it leaves the Stack VM running", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", {
            composeStatus: "done",
            cloudAccountId: "acct-1",
          })}
        />,
      ),
    );

    expect(named("Restart")?.getAttribute("title")).toBe(
      "docker compose restart — the containers restart. The Stack VM keeps running.",
    );
  });

  it("offers no Restart on a stack on a Server", () => {
    render(
      withQuery(
        <ComposeActions
          compose={stack("docker-compose", {
            composeStatus: "done",
            cloudAccountId: null,
          })}
        />,
      ),
    );

    expect(named("Restart")).toBe(null);
  });
});
