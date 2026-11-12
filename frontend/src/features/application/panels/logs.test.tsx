import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeLog = vi.hoisted(() => vi.fn());
const appRow = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  error: null as unknown,
}));

vi.mock("@/lib/api/endpoints/applications", async (original) => {
  const actual =
    await original<typeof import("@/lib/api/endpoints/applications")>();
  return {
    ...actual,
    applicationsApi: { ...actual.applicationsApi, runtimeLog },
  };
});
vi.mock("../use-application", async (original) => ({
  ...(await original<typeof import("../use-application")>()),
  useApplication: () => ({
    data: appRow.current,
    error: appRow.error,
    isPending: false,
  }),
}));

const { ApiError } = await import("@/lib/api/api-error");
const { default: Panel, BEHIND_LABEL, DELAYED_LABEL } = await import("./logs");

afterEach(() => {
  cleanup();
  runtimeLog.mockReset();
  appRow.error = null;
});

const CLOUD = {
  applicationId: "app-1",
  name: "web",
  cloudPlace: {
    cloudAccountId: "ca-1",
    cloudAccountName: "Production AWS",
    region: "eu-central-1",
  },
};

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Panel id="app-1" kind={null} label="Logs" icon="term" />
    </QueryClientProvider>,
  );
}

/** The log tab of a cloud Service. */
describe("Panel — Runtime log", () => {
  it("says why the Service could not be read, as a refusal rather than an empty log", () => {
    appRow.current = null;
    appRow.error = new ApiError(404, "Application not found");

    mount();

    expect(screen.getByRole("alert").textContent).toMatch(/not here any more/);
  });

  it("shows every task's lines merged by time, each naming its task, labelled a few seconds behind", async () => {
    appRow.current = CLOUD;
    runtimeLog.mockResolvedValue({
      lines: [
        { id: "1", at: 1_000, task: "aaaaaaaa1111", message: "a: listening" },
        { id: "2", at: 2_000, task: "bbbbbbbb2222", message: "b: listening" },
      ],
      next: 2_000,
      more: false,
    });

    mount();

    expect(screen.getByText(BEHIND_LABEL)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("[aaaaaaaa] a: listening")).toBeTruthy(),
    );
    expect(screen.getByText("[bbbbbbbb] b: listening")).toBeTruthy();
    expect(runtimeLog).toHaveBeenCalledWith("app-1", undefined);
  });

  it("says what the backend said when the read fails, naming the Cloud account", async () => {
    appRow.current = CLOUD;
    runtimeLog.mockRejectedValue(
      new ApiError(
        400,
        "Cloud account Production AWS could not take on its deploy role",
      ),
    );

    mount();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Cloud account Production AWS",
      ),
    );
  });

  it("marks a Cloud Run Service's lines and says when Google's quota delays them", async () => {
    appRow.current = {
      ...CLOUD,
      cloudPlace: {
        cloudAccountId: "ca-2",
        cloudAccountName: "Production Google",
        cloud: "gcp",
        region: "europe-west1",
      },
    };
    runtimeLog.mockResolvedValue({
      lines: [
        {
          id: "1",
          at: 1_000,
          task: "aaaaaaaa1111",
          revision: "cloudgate-abc-00002-xyz",
          source: "stdout",
          message: "listening",
        },
      ],
      next: 1_000,
      more: false,
      delayed: true,
    });

    mount();

    await waitFor(() =>
      expect(
        screen.getByText("[aaaaaaaa 00002-xyz] stdout: listening"),
      ).toBeTruthy(),
    );
    expect(screen.getByText(DELAYED_LABEL)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/quota/);
    expect(screen.queryByText(BEHIND_LABEL)).toBeNull();
  });

  // An Application on a Server follows its Swarm service instead
  // (`logs-server.test.tsx`), and never reads the cloud's log store.
  it("reads no cloud log store for an Application on a Server", () => {
    appRow.current = {
      applicationId: "app-1",
      name: "web",
      appName: "web-x1y2",
      serverId: "srv-1",
      server: { serverId: "srv-1", name: "worker-1" },
      cloudPlace: null,
      applicationStatus: "idle",
    };

    mount();

    expect(screen.getByText("Not deployed yet", { exact: false })).toBeTruthy();
    expect(screen.queryByText(BEHIND_LABEL)).toBeNull();
    expect(runtimeLog).not.toHaveBeenCalled();
  });
});
