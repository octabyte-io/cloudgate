import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import {
  deploymentsApi,
  type Deployment,
  type DeploymentStatus,
} from "@/lib/api/endpoints/deployments";

const toast = vi.hoisted(() => ({
  done: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const allowed = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({
    allowed: allowed.current,
    pending: false,
    role: "member",
  }),
}));

const { BuildNowButton } = await import("./build-now-button");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  allowed.current = true;
  toast.done.mockReset();
  toast.warn.mockReset();
  toast.error.mockReset();
});

function mount(status: DeploymentStatus) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BuildNowButton
        deployment={{ deploymentId: "dep-1", status }}
        applicationId="app-1"
      />
    </QueryClientProvider>,
  );
}

const button = () =>
  screen.queryByRole("button", { name: "Build now with saved settings" });

/** A build a push held for a plan can be released at once. */
describe("BuildNowButton", () => {
  it("is offered for a held build only", () => {
    mount("held");
    expect(button()).not.toBe(null);
    cleanup();
    for (const status of ["pending", "running", "done", "cancelled"] as const) {
      mount(status);
      expect(button()).toBe(null);
      cleanup();
    }
  });

  it("releases the build and says it is queued with the saved settings", async () => {
    const buildNow = vi
      .spyOn(deploymentsApi, "buildNow")
      .mockResolvedValue({ deploymentId: "dep-1", status: "pending" } as Deployment);
    mount("held");

    fireEvent.click(button()!);

    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(buildNow).toHaveBeenCalledWith("dep-1");
    expect(toast.done).toHaveBeenCalledWith(
      "The build is queued with the saved settings.",
    );
  });

  it("shows the backend's sentence for a build released meanwhile", async () => {
    const refusal =
      "This deployment is not held for a plan (it is pending), so there is nothing to build now";
    vi.spyOn(deploymentsApi, "buildNow").mockRejectedValue(
      new ApiError(409, refusal),
    );
    mount("held");

    fireEvent.click(button()!);

    await waitFor(() => expect(toast.warn).toHaveBeenCalled());
    expect(toast.warn).toHaveBeenCalledWith(`${refusal}.`);
  });

  it("is disabled for a role that cannot deploy", () => {
    allowed.current = false;
    mount("held");
    expect(button()?.getAttribute("aria-disabled")).toBe("true");
  });
});
