import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

const usePermission = vi.hoisted(() => vi.fn());
const useGpuCounts = vi.hoisted(() =>
  vi.fn<(serverId: string | null, enabled: boolean) => { data: unknown }>(
    () => ({
      data: undefined,
    }),
  ),
);

// The caller's effective statements are the boundary; the cards are real.
// Nothing is locked: no repository keeps this config (the locks are
// config-lock.test.tsx's and build-card.test.tsx's).
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => null,
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
// The run Server's cards are a live read; its answer is the boundary.
vi.mock("@/lib/api/use-gpu", () => ({ useGpuCounts }));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { APPLICATION_SETTINGS_REFUSAL } = await import("../use-application");
const { BuildServerCard } = await import("./build-server-card");
const { ResourcesCard } = await import("./resources-card");
const { RuntimeCard } = await import("./runtime-card");
const { roleRefusal } = await import("@/lib/auth/use-permission");

const application = {
  applicationId: "app-1",
  sourceType: "docker",
  buildServerId: null,
  registryId: null,
  buildRegistryId: null,
  server: null,
  buildServer: null,
  serverId: "srv-1",
  replicas: 1,
  gpus: 0,
  cpuLimit: null,
  cpuReservation: null,
  memoryLimit: null,
  memoryReservation: null,
  command: "node server.js",
  args: null,
} as unknown as ApplicationDetail;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  useGpuCounts.mockClear();
});

const CARDS = [
  {
    name: "Build server",
    mount: (save: (input: Record<string, unknown>) => Promise<unknown>) =>
      render(
        <BuildServerCard
          application={application}
          servers={[]}
          serversPending={false}
          save={save}
        />,
      ),
    saved: { buildServerId: null },
  },
  {
    name: "Resources",
    mount: (save: (input: Record<string, unknown>) => Promise<unknown>) =>
      render(<ResourcesCard application={application} save={save} />),
    saved: {
      replicas: 1,
      cpuLimit: null,
      cpuReservation: null,
      memoryLimit: null,
      memoryReservation: null,
      gpus: 0,
    },
  },
  {
    name: "Run command",
    mount: (save: (input: Record<string, unknown>) => Promise<unknown>) =>
      render(<RuntimeCard application={application} save={save} />),
    saved: { command: "node server.js", args: null },
  },
];

function mount(
  card: (typeof CARDS)[number],
  { allowed }: { allowed: boolean },
) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  const save = vi.fn(async () => undefined);
  card.mount(save);
  return { save, button: screen.getByRole("button", { name: "Save changes" }) };
}

/**
 * The three cards on an Application's Advanced tab that save through
 * `PATCH /applications/:id`, which `findOwnedForUpdate` holds to
 * `service: ['update']`.
 */
it("says the role's reason in the words every gated control uses", () => {
  expect(APPLICATION_SETTINGS_REFUSAL).toBe(
    roleRefusal(
      "change how this Application is built, run, previewed or rolled back",
    ),
  );
});

describe.each(CARDS)("$name — Save", (card) => {
  it("asks for service:update", () => {
    mount(card, { allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("is off with the reason for a role that cannot change the Application, and a forced submit sends nothing", async () => {
    const { save, button } = mount(card, { allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(APPLICATION_SETTINGS_REFUSAL);

    // Enter in a field submits the form whatever the button says.
    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        APPLICATION_SETTINGS_REFUSAL,
      ),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("is live for a role that can, and saves", async () => {
    const { save, button } = mount(card, { allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(
      APPLICATION_SETTINGS_REFUSAL,
    );

    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledWith(card.saved));
  });
});

describe("Resources — GPUs", () => {
  const withServer = {
    ...application,
    replicas: 2,
    gpus: 1,
    server: { name: "gpu-1" },
  } as unknown as ApplicationDetail;

  function mountResources(counts: unknown, app = withServer) {
    usePermission.mockReturnValue({
      allowed: true,
      pending: false,
      role: "owner",
    });
    useGpuCounts.mockReturnValue({ data: counts });
    render(
      <ResourcesCard application={app} save={vi.fn(async () => undefined)} />,
    );
  }

  it("reads the run Server's cards and free count, and the total held, copies × N", () => {
    mountResources({ gpuSetup: "card-id", cards: 2, free: 1 });

    expect(useGpuCounts).toHaveBeenCalledWith("srv-1", true);
    expect(document.body.textContent).toContain("gpu-1 has 2 GPUs, 1 free");
    expect(document.body.textContent).toContain(
      "Holds 2 in all: 2 copies × 1.",
    );
  });

  it("says why a Server has no cards to reserve", () => {
    mountResources({ gpuSetup: "count", cards: 0, free: 0 });
    expect(document.body.textContent).toContain(
      "gpu-1 was set up for GPUs the old way: run GPU setup again",
    );
    cleanup();
    mountResources({ gpuSetup: "none", cards: 0, free: 0 }, {
      ...withServer,
      server: null,
      serverId: null,
    } as unknown as ApplicationDetail);
    expect(document.body.textContent).toContain(
      "The platform host is not set up for GPUs",
    );
    expect(useGpuCounts).toHaveBeenLastCalledWith(null, true);
  });

  it("asks for the cards only with service:create, and still saves the field without them", async () => {
    usePermission.mockImplementation(({ service }: { service: string[] }) => ({
      allowed: service[0] === "update",
      pending: false,
      role: "member",
    }));
    const save = vi.fn<(input: Record<string, unknown>) => Promise<undefined>>(
      async () => undefined,
    );
    render(<ResourcesCard application={withServer} save={save} />);

    expect(useGpuCounts).toHaveBeenCalledWith("srv-1", false);
    expect(document.body.textContent).toContain("Holds 2 in all");
    fireEvent.change(screen.getByLabelText("GPUs"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ gpus: 2 })),
    );
  });
});

/**
 * The four limits are typed in cores and sizes and saved in the
 * nano-CPUs and bytes the API keeps. `1` used to save as one nano-CPU.
 */
describe("Resources — units", () => {
  function mountWith(app: ApplicationDetail) {
    usePermission.mockReturnValue({ allowed: true, pending: false, role: "owner" });
    const save = vi.fn<(input: Record<string, unknown>) => Promise<undefined>>(
      async () => undefined,
    );
    render(<ResourcesCard application={app} save={save} />);
    return save;
  }

  it("shows the stored nano-CPUs and bytes as cores and MB", () => {
    mountWith({
      ...application,
      cpuLimit: "1500000000",
      memoryLimit: "536870912",
    } as unknown as ApplicationDetail);
    expect(screen.getByLabelText(/^CPU limit/)).toHaveProperty("value", "1.5");
    expect(screen.getByLabelText(/^Memory limit/)).toHaveProperty("value", "512 MB");
  });

  it("saves 1 core and 512 MB as 1000000000 nano-CPUs and 536870912 bytes", async () => {
    const save = mountWith(application);
    fireEvent.change(screen.getByLabelText(/^CPU limit/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/^Memory limit/), { target: { value: "512MB" } });
    fireEvent.change(screen.getByLabelText(/^Memory reservation/), { target: { value: "0.25 GB" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          cpuLimit: "1000000000",
          memoryLimit: "536870912",
          memoryReservation: "268435456",
        }),
      ),
    );
  });

  it("says a negative replica count inline, where the browser's own check used to stop the form", async () => {
    const save = mountWith(application);
    fireEvent.change(screen.getByLabelText(/^Replicas/), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Replicas cannot be negative.")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a CPU limit under 0.01 core and a size it cannot read, beside the fields", async () => {
    const save = mountWith(application);
    fireEvent.change(screen.getByLabelText(/^CPU limit/), { target: { value: "0.001" } });
    fireEvent.change(screen.getByLabelText(/^Memory limit/), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/at least 0.01 core/)).toBeTruthy();
    expect(screen.getByText(/Memory limit is a size, like 512 MB/)).toBeTruthy();
    // Nothing was sent on the way to being refused.
    expect(save).not.toHaveBeenCalled();
  });
});

/**
 * An Application on no Server runs and builds on Cloudgate's own host,
 * and the card said "—" for both while Overview said so in words.
 */
describe("Build server — where it runs", () => {
  it("names Cloudgate's own host for both, as Overview does", () => {
    usePermission.mockReturnValue({ allowed: true, pending: false, role: "owner" });
    render(
      <BuildServerCard
        application={application}
        servers={[]}
        serversPending={false}
        save={vi.fn(async () => undefined)}
      />,
    );
    expect(document.body.textContent).toMatch(/Runs on\s*Cloudgate's own host/);
    expect(document.body.textContent).toMatch(/Builds on\s*Cloudgate's own host/);
    expect(document.body.textContent).not.toContain("—");
  });
});
