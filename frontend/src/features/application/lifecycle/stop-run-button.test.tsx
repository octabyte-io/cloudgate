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

const { StopRunButton, STOP_RUN_CONSEQUENCE } = await import("./stop-run-button");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.done.mockReset();
  toast.warn.mockReset();
  toast.error.mockReset();
});

const cloudRun = {
  kind: "deploy" as const,
  stateKey: "application:app-1",
  environmentId: "env-1",
  touchesNetwork: false,
};

function mount(status: DeploymentStatus, cloud: boolean = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const deployment = {
    deploymentId: "dep-1",
    status,
    cloudRun: cloud ? cloudRun : null,
  } as Deployment;
  return render(
    <QueryClientProvider client={client}>
      <StopRunButton deployment={deployment} applicationId="app-1" />
    </QueryClientProvider>,
  );
}

const opener = () => screen.queryByRole("button", { name: "Stop the run" });

/**
 * Stop the run is
 * offered on a running Cloud run, and only after the confirmation the spec
 * words.
 */
describe("StopRunButton", () => {
  it("is offered for a running Cloud run", () => {
    mount("running");
    expect(opener()).not.toBe(null);
  });

  it.each<DeploymentStatus>(["pending", "done", "error", "cancelled"])(
    "is not offered for a %s one — a waiting run is Cancel's",
    (status) => {
      mount(status);
      expect(opener()).toBe(null);
    },
  );

  it("is not offered for a build", () => {
    mount("running", false);
    expect(opener()).toBe(null);
  });

  it("asks first, saying changes made so far stay, and stops the run on confirm", async () => {
    const stop = vi
      .spyOn(deploymentsApi, "stopRun")
      .mockResolvedValue({ deploymentId: "dep-1", status: "running" } as Deployment);
    mount("running");

    fireEvent.click(opener()!);
    await screen.findByText(`${STOP_RUN_CONSEQUENCE}.`);
    expect(stop).not.toHaveBeenCalled();

    const confirm = screen.getAllByRole("button", { name: "Stop the run" }).at(-1)!;
    fireEvent.click(confirm);

    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(stop).toHaveBeenCalledWith("dep-1");
  });

  it("shows the backend's refusal for a run that ended while the dialog was open", async () => {
    const refusal = "Only a running Cloud run can be stopped, and this deployment is not one.";
    vi.spyOn(deploymentsApi, "stopRun").mockRejectedValue(
      new ApiError(409, refusal),
    );
    mount("running");

    fireEvent.click(opener()!);
    await screen.findByText(`${STOP_RUN_CONSEQUENCE}.`);
    fireEvent.click(screen.getAllByRole("button", { name: "Stop the run" }).at(-1)!);

    await waitFor(() => expect(toast.warn).toHaveBeenCalledWith(refusal));
  });
});
