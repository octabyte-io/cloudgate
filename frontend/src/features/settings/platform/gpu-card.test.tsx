import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { settingsApi } from "@/lib/api/endpoints/settings";
import type { GpuInfo } from "@/lib/api/endpoints/settings";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` reads at render for the mutations this card
// holds. The probe itself is replaced at `settingsApi.gpu` below.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { GpuCard } = await import("./gpu-card");
const { GpuSupportCard } =
  await import("@/components/console/gpu-support-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
});

/**
 * What the GPU check may say about Swarm, and what it may not.
 *
 * The defect was not the value — `Advertised to Swarm ○ no` is correct on a box
 * with no GPU — but the caption beside it. It was derived from `swarmEnabled`,
 * which the backend sets only when `docker node inspect self` lists a GPU
 * generic resource, so it is false on every Swarm host without a GPU; the card
 * rendered that as "this host is not in a Swarm" on a Swarm manager, two cards
 * below a This machine card reading `Swarm active`. Swarm membership is
 * `docker info`'s `Swarm.LocalNodeState` and nothing in this payload carries it,
 * so the assertion is that the card claims nothing about it.
 *
 * The card is driven for real through TanStack Query rather than calling its
 * private `findings` builder: what is asserted is what an operator reads.
 */
const payload = (over: Partial<GpuInfo> = {}): GpuInfo => ({
  driverInstalled: false,
  runtimeInstalled: false,
  runtimeConfigured: false,
  cudaSupport: false,
  availableGPUs: 0,
  swarmEnabled: false,
  gpuResources: 0,
  gpuSetup: "none",
  gpuCardIds: [],
  ...over,
});

/** A machine with the driver and runtime in place, advertising `setup`. */
const equipped = (over: Partial<GpuInfo>): GpuInfo =>
  payload({
    driverInstalled: true,
    driverVersion: "570.86.15",
    availableGPUs: 2,
    gpuModel: "NVIDIA L4",
    runtimeInstalled: true,
    runtimeConfigured: true,
    ...over,
  });

async function check(
  info: GpuInfo,
  card: ReactNode = <GpuCard />,
  checkLabel = "Check this host",
): Promise<string> {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  const spy = vi.spyOn(settingsApi, "gpu").mockResolvedValue(info);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(card));

  // The probe is behind a button on purpose, so the reading only exists once
  // somebody has asked for it.
  fireEvent.click(screen.getByRole("button", { name: checkLabel }));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  await waitFor(() =>
    expect(document.body.textContent ?? "").toContain("Advertised to Swarm"),
  );
  return document.body.textContent ?? "";
}

describe("GpuCard", () => {
  it("says nothing about Swarm membership when no GPU is advertised to Swarm", async () => {
    // The exact payload a Swarm manager with no GPU answers with, from the
    // ticket's own network capture.
    const said = await check(payload());

    expect(said).toContain("Advertised to Swarm");
    expect(said).not.toContain("not in a Swarm");
    // Nothing weaker either: no sentence on this card is about whether the host
    // is a Swarm node, because no probe behind it reads that.
    expect(said).not.toMatch(/(is|not) in a Swarm/i);
  });

  it("turns the check off with the instance-authority sentence, not the role one, when the instance read is refused", async () => {
    // The owner of a second Organization: `GET /settings/infrastructure-health`
    // answers instance authority's coded 403, and no role of theirs grants it,
    // so "ask an owner or an admin" would send them to themselves.
    useActiveOrganizationId.mockReturnValue({
      organizationId: "org-2",
      pending: false,
    });
    vi.spyOn(settingsApi, "infrastructureHealth").mockRejectedValue(
      new ApiError(
        403,
        "Only an owner or admin of the instance organization can configure the platform host",
        { code: "INSTANCE_AUTHORITY_REQUIRED" },
      ),
    );
    vi.spyOn(settingsApi, "gpu");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <GpuCard />
      </QueryClientProvider>,
    );

    const button = screen.getByRole("button", { name: "Check this host" });
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(button.getAttribute("title")).toBe(
      "Only an owner or admin of the Instance organization can do this.",
    );
    fireEvent.click(button);
    expect(settingsApi.gpu).not.toHaveBeenCalled();
  });

  it("reports how many GPUs are advertised when the node advertises them", async () => {
    const said = await check(
      equipped({
        swarmEnabled: true,
        gpuResources: 2,
        gpuSetup: "card-id",
        gpuCardIds: ["GPU-a", "GPU-b"],
      }),
    );

    // The count sits between the label and the glyph, so the row reads
    // "Advertised to Swarm 2 by card ID ● yes".
    expect(said).toContain("Advertised to Swarm2 by card ID");
    expect(said).not.toContain("not in a Swarm");
  });
});

/**
 * Three setup states, in words, and a setup that asks first.
 */
describe("GpuSupportCard", () => {
  it("reads a machine with no GPU advertised as not set up", async () => {
    const said = await check(equipped({}));

    expect(said).toContain("Not set up");
    expect(said).toContain("Run GPU setup");
  });

  it("reads a machine advertising a count as set up the old way, and offers setup again", async () => {
    const said = await check(
      equipped({ swarmEnabled: true, gpuResources: 2, gpuSetup: "count" }),
    );

    expect(said).toContain("Set up the old way: run setup again");
    expect(said).not.toContain("Ready");
    expect(said).toContain("Set up GPU support again");
    expect(screen.getByRole("button", { name: "Run GPU setup" })).toBeTruthy();
  });

  it("reads a machine set up by card ID as ready, with nothing to run", async () => {
    const said = await check(
      equipped({
        swarmEnabled: true,
        gpuResources: 2,
        gpuSetup: "card-id",
        gpuCardIds: ["GPU-a", "GPU-b"],
      }),
    );

    expect(said).toContain("Ready");
    expect(said).toContain("2 by card ID");
    expect(screen.queryByRole("button", { name: "Run GPU setup" })).toBeNull();
  });

  it("asks before setup, naming the Docker restart, and sets up only the machine it was rendered for", async () => {
    const setup = vi
      .spyOn(settingsApi, "setupGpu")
      .mockResolvedValue({ success: true });
    await check(
      equipped({ gpuSetup: "count", gpuResources: 2, swarmEnabled: true }),
      <GpuSupportCard
        serverId="srv-1"
        machineName="gpu-box"
        checkLabel="Check this Server"
        gate={{ allowed: true, refusal: "" }}
      />,
      "Check this Server",
    );
    expect(settingsApi.gpu).toHaveBeenCalledWith("srv-1");

    fireEvent.click(screen.getByRole("button", { name: "Run GPU setup" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Run GPU setup on gpu-box?");
    expect(dialog.textContent).toContain(
      "This restarts Docker on that machine",
    );
    expect(dialog.textContent).toContain(
      "Every Service on that machine stops for a moment",
    );
    // Nothing ran on the way to being asked.
    expect(setup).not.toHaveBeenCalled();

    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Run GPU setup",
    );
    fireEvent.click(confirm!);
    await waitFor(() => expect(setup).toHaveBeenCalledWith("srv-1"));
  });

  it("keeps the check off, with the reason, for a caller the gate refuses", () => {
    vi.spyOn(settingsApi, "gpu");
    useActiveOrganizationId.mockReturnValue({
      organizationId: "org-1",
      pending: false,
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <GpuSupportCard
          serverId="srv-1"
          machineName="gpu-box"
          checkLabel="Check this Server"
          gate={{ allowed: false, refusal: "Ask an owner or an admin." }}
        />
      </QueryClientProvider>,
    );

    const button = screen.getByRole("button", { name: "Check this Server" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("Ask an owner or an admin.");
    fireEvent.click(button);
    expect(settingsApi.gpu).not.toHaveBeenCalled();
  });
});
