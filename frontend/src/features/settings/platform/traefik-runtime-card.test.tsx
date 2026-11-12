import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { traefikApi, type TraefikPort } from "@/lib/api/endpoints/traefik";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` consults. The routes are replaced at
// `traefikApi` below.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { TraefikRuntimeCard } = await import("./traefik-runtime-card");
const { RECREATION_TIMEOUT_MS } = await import("./use-recreation");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useActiveOrganizationId.mockReset();
});

const port = (n: number): TraefikPort => ({
  publishedPort: n,
  targetPort: n,
  protocol: "tcp",
});

/**
 * The card on a platform host whose Traefik answers each read from a queue: the first
 * answer is the page load, the next ones are the refetches after a save, and
 * the last one repeats.
 */
function mount(reads: {
  env?: Array<string | Error>;
  ports?: Array<TraefikPort[] | Error>;
  dashboard?: Array<boolean | Error>;
}) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  const queue =
    <T,>(answers: Array<T | Error>) =>
    () => {
      const next = answers.length > 1 ? answers.shift()! : answers[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
  const spies = {
    env: vi
      .spyOn(traefikApi, "readEnv")
      .mockImplementation(queue(reads.env ?? ["PATH=/usr/bin"])),
    ports: vi
      .spyOn(traefikApi, "ports")
      .mockImplementation(queue(reads.ports ?? [[]])),
    dashboard: vi
      .spyOn(traefikApi, "dashboardEnabled")
      .mockImplementation(queue(reads.dashboard ?? [false])),
    updatePorts: vi.spyOn(traefikApi, "updatePorts").mockResolvedValue(true),
    writeEnv: vi.spyOn(traefikApi, "writeEnv").mockResolvedValue(true),
    toggleDashboard: vi
      .spyOn(traefikApi, "toggleDashboard")
      .mockResolvedValue(true),
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TraefikRuntimeCard />
    </QueryClientProvider>,
  );
  return spies;
}

/**
 * Records, on every DOM change from now on, whether `seen()` held — so "it was
 * never shown" covers each render in between and not only the ones a
 * `waitFor` happened to sample.
 */
function watch(seen: () => boolean) {
  let ever = false;
  const observer = new MutationObserver(() => {
    if (seen()) ever = true;
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    get ever() {
      return ever;
    },
    stop: () => observer.disconnect(),
  };
}

const hostPorts = () =>
  screen
    .queryAllByLabelText("On the host")
    .map((input) => (input as HTMLInputElement).value);
const text = () => document.body.textContent ?? "";
const EMPTY = "Traefik publishes only 80 and 443 on this host.";

/**
 * A save to Traefik's container, until the container it recreates is read.
 *
 * Each route answers before the background recreation has run, so the refetch
 * a save triggers reads the old container. The card showed that as current —
 * the removed port came back — and a second Save wrote it back.
 */
describe("TraefikRuntimeCard after a save", () => {
  it("does not show a removed port again while the refetch still reads the old container", async () => {
    const spies = mount({ ports: [[port(8443)], [port(8443)], []] });
    await waitFor(() => expect(hostPorts()).toEqual(["8443"]));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const reappeared = watch(() => hostPorts().includes("8443"));
    fireEvent.click(screen.getByRole("button", { name: "Save ports" }));

    await waitFor(() => expect(spies.updatePorts).toHaveBeenCalledWith([], null));
    // The first refetch: the old container, with 8443 still published.
    await waitFor(() => expect(spies.ports).toHaveBeenCalledTimes(2));
    expect(text()).toContain("Recreating…");
    expect(text()).toContain(EMPTY);

    // The second: the recreated container.
    await waitFor(() => expect(spies.ports).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    await waitFor(() => expect(text()).not.toContain("Recreating…"));
    reappeared.stop();

    expect(reappeared.ever).toBe(false);
    expect(text()).toContain(EMPTY);
  });

  it("does not report Traefik as not running while its container is being replaced", async () => {
    const gone = new ApiError(500, "Resource type not found");
    const spies = mount({ ports: [[], gone, [port(8443)]] });
    await waitFor(() => expect(text()).toContain(EMPTY));

    fireEvent.click(screen.getByRole("button", { name: "Add a port" }));
    fireEvent.change(screen.getByLabelText("On the host"), {
      target: { value: "8443" },
    });
    fireEvent.change(screen.getByLabelText("In the container"), {
      target: { value: "8443" },
    });
    const failed = watch(() => text().includes("not running"));
    fireEvent.click(screen.getByRole("button", { name: "Save ports" }));

    await waitFor(() => expect(spies.ports).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    await waitFor(() => expect(text()).not.toContain("Recreating…"));
    failed.stop();

    expect(failed.ever).toBe(false);
    expect(hostPorts()).toEqual(["8443"]);
  });

  it("keeps the dashboard switch and its 8080 row as saved until the container reads that way", async () => {
    const spies = mount({
      dashboard: [true, true, false],
      ports: [[port(8080)], [port(8080)], []],
    });
    const toggle = await screen.findByRole("switch", {
      name: "Publish the Traefik dashboard on port 8080",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(spies.toggleDashboard).toHaveBeenCalledWith(false, null),
    );
    // Until the POST returns the switch is mid-press, not saved. From the
    // moment it has, neither the switch nor the ports list may read as before.
    await waitFor(() => expect(text()).toContain("Recreating…"));
    expect(spies.dashboard.mock.calls.length).toBeLessThan(3);
    const stale = watch(
      () =>
        screen
          .getByRole("switch", {
            name: "Publish the Traefik dashboard on port 8080",
          })
          .getAttribute("aria-checked") === "true" ||
        hostPorts().includes("8080"),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(EMPTY);

    await waitFor(() => expect(spies.dashboard).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    await waitFor(() => expect(text()).not.toContain("Recreating…"));
    stale.stop();

    expect(stale.ever).toBe(false);
  });

  it("does not bring a removed variable back while the refetch still reads the old container", async () => {
    const before = "PATH=/usr/bin\nUI_TRAEFIK_TEST=1";
    const spies = mount({ env: [before, before, "PATH=/usr/bin"] });
    const box = (await screen.findByLabelText(
      "Traefik's environment variables",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe(before));

    fireEvent.change(box, { target: { value: "PATH=/usr/bin" } });
    const back = watch(() =>
      (
        screen.getByLabelText(
          "Traefik's environment variables",
        ) as HTMLTextAreaElement
      ).value.includes("UI_TRAEFIK_TEST"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));

    await waitFor(() =>
      expect(spies.writeEnv).toHaveBeenCalledWith("PATH=/usr/bin", null),
    );
    await waitFor(() => expect(spies.env).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    await waitFor(() => expect(text()).not.toContain("Recreating…"));
    back.stop();

    expect(back.ever).toBe(false);
  });

  it("says so when the container still reads as before a minute later, and shows what it has", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount({ ports: [[port(8443)]] });
    await waitFor(() => expect(hostPorts()).toEqual(["8443"]));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save ports" }));
    await waitFor(() => expect(text()).toContain("Recreating…"));
    expect(hostPorts()).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(RECREATION_TIMEOUT_MS));

    await waitFor(() => expect(text()).not.toContain("Recreating…"));
    expect(text()).toContain("still reads as it did before it");
    expect(hostPorts()).toEqual(["8443"]);
  });
});
