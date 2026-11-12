import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

import {
  CONCERN_OF_COLUMN,
  CONCERNS_CLOSED_ON_KIND,
  configOwnedConcerns,
  swarmConcerns,
} from "./swarm-concerns";
import { SWARM_UNSAVED, SwarmSection } from "./swarm-section";
import { toSwarmColumns, toSwarmValues } from "./swarm-values";

/**
 * **A refused Swarm setting is shown on the card that edits it**.
 *
 * The eleven columns are folded out of forty-odd flat fields, so a 400 names
 * `labelsSwarm` and no field on the form is called that. Every refusal used to
 * land in the form's generic root error — "The backend refused a value this
 * form does not show — labelsSwarm: …" — under all eleven cards, naming an
 * internal column and saying the form does not show the card it was typed into.
 */

/**
 * The role's statements, as `build-card.test.tsx` fakes them: `service:update`
 * held unless a test refuses it.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

/** The Environment's copy's lock on this Application: none unless a test sets one. */
const configLock = vi.hoisted(() => ({
  current: null as import("@/components/console/config-lock").ConfigLock | null,
}));
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => configLock.current,
}));

afterEach(() => {
  cleanup();
  refused.current = new Set();
  configLock.current = null;
});

const application = {
  applicationId: "app-1",
  replicas: 1,
  modeSwarm: null,
  placementSwarm: null,
  labelsSwarm: null,
  networkSwarm: null,
  restartPolicySwarm: null,
  updateConfigSwarm: null,
  rollbackConfigSwarm: null,
  healthCheckSwarm: null,
  endpointSpecSwarm: null,
  stopGracePeriodSwarm: null,
  ulimitsSwarm: null,
} as unknown as ApplicationDetail;

const TRAEFIK_REFUSAL =
  'A service label may not be in the "traefik" namespace: those keys are ' +
  "router configuration for the ingress every domain on the server shares — " +
  "offending label(s): traefik.enable";

describe("CONCERN_OF_COLUMN", () => {
  const columns = Object.keys(toSwarmColumns(toSwarmValues(application), application));
  const ids = new Set(swarmConcerns(toSwarmValues(application)).map((c) => c.id));

  // The census, both ways: a twelfth column cannot be added without a card to
  // show its refusals on, and a card cannot be renamed out from under one.
  it.each(columns)("%s is edited by a card that exists", (column) => {
    const concern = CONCERN_OF_COLUMN[column];
    expect(concern).toBeDefined();
    expect(ids.has(concern!)).toBe(true);
  });

  it("maps every column the form sends, and nothing else", () => {
    expect(Object.keys(CONCERN_OF_COLUMN).sort()).toEqual([...columns].sort());
  });

  it("found the eleven the section is built from", () => {
    expect(columns).toHaveLength(11);
  });
});

describe("SwarmSection", () => {
  const refusing = () =>
    vi.fn(async () => {
      throw new ApiError(400, "Validation failed", {
        issues: [{ path: "labelsSwarm", message: TRAEFIK_REFUSAL }],
      });
    });

  it("shows a refused label on the Labels card, in the backend's own words", async () => {
    const save = refusing();
    render(<SwarmSection application={application} save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("offending label(s): traefik.enable");

    // On the card, not under all eleven of them.
    const card = screen.getByRole("heading", { name: "Labels" }).closest("section");
    expect(card?.contains(alert)).toBe(true);
  });

  it("names no column and does not claim the form hides it", async () => {
    render(<SwarmSection application={application} save={refusing()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    await screen.findByRole("alert");
    expect(document.body.textContent).not.toMatch(/labelsSwarm/);
    expect(document.body.textContent).not.toMatch(/this form does not show/);
  });

  it("still reads out a refusal naming something no card owns", async () => {
    const save = vi.fn(async () => {
      throw new ApiError(400, "Validation failed", {
        issues: [{ path: "somethingElse", message: "no" }],
      });
    });
    render(<SwarmSection application={application} save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    await waitFor(() =>
      expect(document.body.textContent).toMatch(/this form does not show/),
    );
  });

  /**
   * Swarm cannot change a service's mode in place, so a Deployment
   * recreates the service, and the card says so before the change is saved.
   */
  describe("a service mode change", () => {
    const card = (title: string) =>
      screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

    /** Base UI's trigger opens on `mousedown`, so a bare click is what opens it. */
    async function chooseMode(mode: HTMLElement, name: RegExp) {
      fireEvent.click(within(mode).getByRole("combobox"));
      await waitFor(() =>
        expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
      );
      const option = screen.getByRole("option", { name });
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option, { detail: 1 });
      await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    }

    it("says a new mode replaces the service, once a different mode is chosen", async () => {
      render(<SwarmSection application={application} save={vi.fn()} />);
      const mode = card("Service mode");
      expect(mode.textContent).not.toMatch(/This replaces the service/);

      await chooseMode(mode, /^Global — one task on every node/);

      expect(mode.textContent).toMatch(/This replaces the service/);
      expect(mode.textContent).toMatch(/removes the service and creates it again/);
      expect(mode.textContent).toMatch(/Volumes are kept/);
    });

    it("does not warn when a replicated service only changes its replica count", async () => {
      render(<SwarmSection application={application} save={vi.fn()} />);
      const mode = card("Service mode");

      await chooseMode(mode, /^Replicated — a fixed number of tasks/);

      expect(mode.textContent).not.toMatch(/This replaces the service/);
    });
  });

  /** An AI model's API refuses these three, so they are not offered. */
  describe("on an AI model", () => {
    const aiModel = {
      ...application,
      aiModel: { runtime: "ollama", model: "smollm2:135m" },
    } as unknown as ApplicationDetail;

    it("leaves out Networks, Health check and Endpoint spec, and never sends them", async () => {
      const save = vi.fn<(input: Record<string, unknown>) => Promise<object>>(
        async () => ({}),
      );
      render(<SwarmSection application={aiModel} save={save} />);

      for (const title of ["Networks", "Health check", "Endpoint spec"]) {
        expect(screen.queryByRole("heading", { name: title })).toBeNull();
      }
      expect(screen.getByRole("heading", { name: "Placement" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const sent = Object.keys(save.mock.calls[0][0]);
      expect(sent).not.toContain("networkSwarm");
      expect(sent).not.toContain("healthCheckSwarm");
      expect(sent).not.toContain("endpointSpecSwarm");
      expect(sent).toContain("placementSwarm");
    });
  });

  /**
   * A saved network list used to replace cloudgate-network, and every
   * domain answered 502. It is added to it now, and the card says so.
   */
  describe("operator networks", () => {
    it("says cloudgate-network stays attached beside the listed networks", () => {
      render(<SwarmSection application={application} save={vi.fn()} />);
      const networks = screen
        .getByRole("heading", { name: "Networks" })
        .closest("section") as HTMLElement;

      expect(networks.textContent).toMatch(/cloudgate-network is always attached/);
      expect(networks.textContent).not.toContain("`");
    });
  });
});

/**
 * `PATCH /applications/:id` takes `service: ['update']`, so a role
 * without it had eleven cards, six row adders and a Save that was refused only
 * once pressed — while Add a mount and Add a redirect beside them were off.
 */
describe("SwarmSection for a role that cannot change the Application", () => {
  const ADDERS = [
    "Add a preference",
    "Add a platform",
    "Add a label",
    "Add a network",
    "Add a port",
    "Add a ulimit",
  ];

  it("turns Save and every row adder off, with the role's reason", () => {
    refused.current = new Set(["service:update"]);
    render(<SwarmSection application={application} save={vi.fn()} />);

    for (const name of ["Save Swarm settings", ...ADDERS]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled"), name).toBe("true");
      expect(button.getAttribute("title"), name).toMatch(
        /^Your role in this Organization cannot change this Application’s Swarm settings\./,
      );
    }
    expect(document.body.textContent).toMatch(
      /Your role in this Organization cannot change this Application’s Swarm settings/,
    );
  });

  it("sends nothing when the form is submitted anyway", async () => {
    refused.current = new Set(["service:update"]);
    const save = vi.fn();
    render(<SwarmSection application={application} save={save} />);

    fireEvent.submit(
      screen.getByRole("button", { name: "Save Swarm settings" }).closest("form")!,
    );

    await screen.findByRole("alert");
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves them live for a role that holds service:update", () => {
    render(<SwarmSection application={application} save={vi.fn()} />);

    for (const name of ["Save Swarm settings", ...ADDERS]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled"), name).not.toBe("true");
      expect(button.getAttribute("title"), name).toBeNull();
    }
  });
});

/**
 * On a Service a repository-kept file describes, the seven Swarm
 * settings `native.docker` owns are the file's: their cards are off with the
 * file's pointer and never sent, while placement, networks, ports and the
 * mode stay the console's.
 */
describe("SwarmSection on a Service a repository-kept config describes", () => {
  const LOCK = {
    repository: "acme/shop",
    path: "cloudgate.yaml",
    branch: "main",
    fileUrl: null,
    appliedCommit: null,
    stated: new Set<string>(),
    listed: { env: [], build_args: [], build_secrets: [] },
  };
  const OWNED = [
    "Labels",
    "Restart policy",
    "Update config",
    "Rollback config",
    "Health check",
    "Stop grace period",
    "Ulimits",
  ];
  const described = { ...application, configKind: "web" } as ApplicationDetail;

  it("turns the seven off with the file's pointer and leaves the rest live", () => {
    configLock.current = LOCK;
    render(<SwarmSection application={described} save={vi.fn()} />);

    for (const name of ["Add a label", "Add a ulimit"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled"), name).toBe("true");
      expect(button.getAttribute("title"), name).toMatch(
        /^Set by the Project config\. Change it in cloudgate\.yaml in acme\/shop on branch main/,
      );
    }
    for (const name of ["Add a preference", "Add a network", "Add a port"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).not.toBe(
        "true",
      );
    }
    expect(document.body.textContent).toMatch(
      /native\.docker.*set by the Project config: cloudgate\.yaml in acme\/shop on branch main/,
    );
  });

  it("sends placement, networks, ports and the mode, and none of the seven", async () => {
    configLock.current = LOCK;
    const save = vi.fn<(input: Record<string, unknown>) => Promise<object>>(
      async () => ({}),
    );
    render(<SwarmSection application={described} save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(Object.keys(save.mock.calls[0][0]).sort()).toEqual(
      ["endpointSpecSwarm", "modeSwarm", "networkSwarm", "placementSwarm"].sort(),
    );
    for (const title of OWNED) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
  });

  /** A cron's file takes Labels, StopGracePeriod and Ulimits alone. */
  it("locks a Cron service's Labels, stop grace period and ulimits, and leaves its other four the console's", async () => {
    configLock.current = LOCK;
    const save = vi.fn<(input: Record<string, unknown>) => Promise<object>>(
      async () => ({}),
    );
    const cron = { ...application, configKind: "cron" } as ApplicationDetail;
    render(<SwarmSection application={cron} save={save} />);

    for (const name of ["Add a label", "Add a ulimit"]) {
      expect(
        screen.getByRole("button", { name }).getAttribute("aria-disabled"),
        name,
      ).toBe("true");
    }
    expect(document.body.textContent).toMatch(
      /Labels, the stop grace period and ulimits are this Service’s native\.docker, set by the Project config/,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = Object.keys(save.mock.calls[0][0]);
    expect(sent).toContain("healthCheckSwarm");
    expect(sent).toContain("restartPolicySwarm");
    for (const column of [
      "labelsSwarm",
      "stopGracePeriodSwarm",
      "ulimitsSwarm",
    ]) {
      expect(sent, column).not.toContain(column);
    }
  });
});

/**
 * The keys a kind refuses are mirrored by hand from the backend's
 * `DOCKER_KEYS_CLOSED_ON_KIND`; this reads that table back so the two never
 * drift (a key opened or closed there and not here would lock the wrong card).
 */
describe("CONCERNS_CLOSED_ON_KIND", () => {
  const CONCERN_OF_KEY: Record<string, string> = {
    Labels: "labels",
    HealthCheck: "health",
    RestartPolicy: "restart",
    UpdateConfig: "update",
    RollbackConfig: "rollback",
    StopGracePeriod: "stop",
    Ulimits: "ulimits",
  };

  it("names the keys the backend's DOCKER_KEYS_CLOSED_ON_KIND refuses, kind by kind", () => {
    const source = readFileSync(
      join(process.cwd(), "../backend/src/native/docker-native.ts"),
      "utf8",
    );
    const table =
      /export const DOCKER_KEYS_CLOSED_ON_KIND[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
        source,
      );
    expect(table).not.toBeNull();
    const backend: Record<string, string[]> = {};
    for (const [, kind, body] of table![1].matchAll(
      /\n {2}(\w+): \{([\s\S]*?)\n {2}\},/g,
    )) {
      backend[kind] = [...body.matchAll(/\n {4}(\w+):/g)].map(
        ([, key]) => CONCERN_OF_KEY[key],
      );
    }
    expect(Object.keys(backend).sort()).toEqual(["bucket", "cron"]);
    for (const kind of Object.keys(backend)) {
      expect([...CONCERNS_CLOSED_ON_KIND[kind]].sort(), kind).toEqual(
        backend[kind].sort(),
      );
    }
  });

  it("leaves a web Service all seven, a cron three and a bucket Labels alone", () => {
    expect(configOwnedConcerns("web")).toHaveLength(7);
    expect(configOwnedConcerns("cron")).toEqual(["labels", "stop", "ulimits"]);
    expect(configOwnedConcerns("bucket")).toEqual(["labels"]);
  });
});

describe("swarmConcerns", () => {
  /** The Service mode card's note, before anything is chosen. */
  it("says in advance, whatever is chosen, that a mode change recreates a deployed service", () => {
    const [mode] = swarmConcerns(toSwarmValues(application));
    const { container } = render(<p>{mode.note}</p>);
    expect(container.textContent).toMatch(/cannot change the mode of a service/);
    expect(container.textContent).not.toContain("`");
  });
});

/**
 * Every Swarm duration is typed in seconds and stored in the
 * nanoseconds the Docker Engine API takes. `30` used to be thirty nanoseconds.
 */
describe("SwarmSection durations", () => {
  it("shows a stored grace period in seconds and saves seconds as nanoseconds", async () => {
    const save = vi.fn(async () => undefined);
    render(
      <SwarmSection
        application={{ ...application, stopGracePeriodSwarm: 10_000_000_000 } as ApplicationDetail}
        save={save}
      />,
    );
    const field = screen.getByLabelText(/^Stop grace period/);
    expect(field).toHaveProperty("value", "10");

    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(/^Interval/), { target: { value: "500ms" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          stopGracePeriodSwarm: 30_000_000_000,
          healthCheckSwarm: { Interval: 500_000_000 },
        }),
      ),
    );
  });

  it("refuses a duration it cannot read beside its field, and sends nothing", async () => {
    const save = vi.fn(async () => undefined);
    render(<SwarmSection application={application} save={save} />);
    fireEvent.change(screen.getByLabelText(/^Stop grace period/), {
      target: { value: "a while" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));

    expect(await screen.findByText(/This is a number of seconds/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
});

/**
 * Eleven cards share one Save at the bottom, and an edit near the top
 * used to be lost to a click elsewhere without a word.
 */
describe("SwarmSection with edits not saved", () => {
  const link = () => {
    const anchor = document.createElement("a");
    anchor.href = "/applications/app-1/deployments";
    anchor.textContent = "Deployments";
    document.body.append(anchor);
    return anchor;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll("a").forEach((anchor) => anchor.remove());
  });

  it("says nothing of unsaved changes until a field is edited", () => {
    render(<SwarmSection application={application} save={vi.fn()} />);
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/^Stop grace period/), {
      target: { value: "30" },
    });
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
  });

  it("asks before a link leaves the page, and stays when the answer is no", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SwarmSection application={application} save={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Stop grace period/), {
      target: { value: "30" },
    });

    const followed = fireEvent.click(link());

    expect(confirm).toHaveBeenCalledWith(SWARM_UNSAVED);
    // `fireEvent` answers false when the default was prevented: not followed.
    expect(followed).toBe(false);
  });

  it("asks the browser to hold a reload or a closed tab", () => {
    render(<SwarmSection application={application} save={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Stop grace period/), {
      target: { value: "30" },
    });

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });

  it("lets a link through and asks nothing once the edits are saved", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const save = vi.fn(async () => undefined);
    render(<SwarmSection application={application} save={save} />);
    fireEvent.change(screen.getByLabelText(/^Stop grace period/), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Swarm settings" }));
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).toBeNull());

    // jsdom does not navigate; what matters is that nothing stopped the click.
    expect(fireEvent.click(link())).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
