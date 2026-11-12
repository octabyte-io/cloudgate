import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Environment } from "@/lib/api/endpoints/environments";

const create = vi.fn();
const update = vi.fn();
const done = vi.fn();
const errorToast = vi.fn();

vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: {
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
  },
}));

// The real ones reach the auth client and the shell's stores; what this test is
// about is where a refusal lands.
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ environment: vi.fn() }),
}));
const servers = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: servers.data, isPending: false }),
}));
const clouds = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock("@/lib/api/use-cloud-accounts", () => ({
  useCloudAccounts: () => ({ data: clouds.data, isPending: false }),
}));
const mode = vi.hoisted(() => ({ data: "self-hosted" as "hosted" | "self-hosted" }));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));
vi.mock("@/components/shell/recents", () => ({ useForgetRecents: () => vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ useActiveOrganizationId: () => "org_1" }));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/components/console/toast", () => ({
  toast: {
    done: (...args: unknown[]) => done(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}));

const { EnvironmentFormModal } = await import("./environment-form-modal");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open(environment: Environment | null, onOpenChange = vi.fn()) {
  render(
    <EnvironmentFormModal
      projectId="prj_1"
      environment={environment}
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper: Wrapper },
  );
  return onOpenChange;
}

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  done.mockReset();
  errorToast.mockReset();
  push.mockReset();
  servers.data = [];
  clouds.data = [];
  mode.data = "self-hosted";
});

afterEach(cleanup);

/** What a screen reader says after the input's name: its hint and its error. */
function descriptionOf(input: HTMLElement): string {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/**
 * An Environment's name is unique in its Project, and the refusal is a
 * 409 about the name just typed — so it is said under Name, not above the
 * buttons or in a toast, on the create and on the rename alike.
 */
describe("EnvironmentFormModal", () => {
  const message = "An Environment with this name already exists in this Project";

  it.each([
    ["create", null, "Create Environment"],
    [
      "rename",
      { environmentId: "env_1", projectId: "prj_1", name: "qa", description: "" },
      "Save changes",
    ],
  ] as const)("says a taken name under Name on a %s", async (_verb, environment, button) => {
    create.mockRejectedValue(new ApiError(409, message));
    update.mockRejectedValue(new ApiError(409, message));
    const onOpenChange = open(environment as Environment | null);

    const name = screen.getByLabelText(/Name/);
    fireEvent.change(name, { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: button }));

    await waitFor(() =>
      expect(descriptionOf(name)).toContain(message),
    );
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(errorToast).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("still toasts a refusal that is not about the name", async () => {
    const refusal = new ApiError(500, "boom");
    create.mockRejectedValue(refusal);
    open(null);

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(refusal));
    expect(screen.getByLabelText(/Name/).getAttribute("aria-invalid")).toBeNull();
  });
});

/**
 * A new Environment's next step is always inside it, so the create goes
 * there, the way a new Project and a new Application already do. A rename stays.
 */
describe("EnvironmentFormModal, after saving", () => {
  it("lands on the new Environment after a create", async () => {
    create.mockResolvedValue({
      environmentId: "env_new",
      projectId: "prj_1",
      name: "staging",
      description: "",
      warnings: [],
    });
    const onOpenChange = open(null);

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/environments/env_new"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays where it is after a rename", async () => {
    update.mockResolvedValue({
      environmentId: "env_1",
      projectId: "prj_1",
      name: "qa2",
      description: "",
      warnings: [],
    });
    const onOpenChange = open({
      environmentId: "env_1",
      projectId: "prj_1",
      name: "qa",
      description: "",
    } as Environment);

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "qa2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(push).not.toHaveBeenCalled();
  });
});

/**
 * A new Environment asks for its Deploy target only when the
 * organization has somewhere other than the platform host to deploy, and then
 * is not created without one, the rule `POST /environments` enforces.
 */
describe("EnvironmentFormModal's Deploy target", () => {
  const worker = { serverId: "srv_1", name: "worker-1", ipAddress: "10.0.0.5", serverType: "deploy" };
  const builder = { serverId: "srv_2", name: "builder", ipAddress: "10.0.0.6", serverType: "build" };

  it("does not ask with no deploy Server, and sends no choice", async () => {
    servers.data = [builder];
    create.mockResolvedValue({});
    open(null);

    expect(screen.queryByText("Deploy target")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).not.toHaveProperty("deployTarget");
  });

  it("asks once there is a deploy Server, and refuses to create without a choice", async () => {
    servers.data = [worker];
    open(null);

    expect(screen.getByText("Deploy target")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(
        screen.getByText("Choose where this Environment's new Services will run."),
      ).toBeTruthy(),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("never asks on a rename", () => {
    servers.data = [worker];
    open({ environmentId: "env_1", projectId: "prj_1", name: "qa", description: "" } as Environment);

    expect(screen.queryByText("Deploy target")).toBeNull();
  });
});

/** The Deploy target's options, read off its open Picker. */
async function targetOptions(): Promise<string[]> {
  fireEvent.click(screen.getByRole("combobox"));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  return screen.getAllByRole("option").map((option) => option.textContent ?? "");
}

/**
 * ADR-0053: on the Hosted instance a new Environment always names
 * one of the Organization's own Servers or Cloud accounts. "This Cloudgate
 * host" is not offered at all, and with nothing to point at the form sends
 * the person to add one.
 */
describe("EnvironmentFormModal on the Hosted instance", () => {
  const worker = { serverId: "srv_1", name: "worker-1", ipAddress: "10.0.0.5", serverType: "deploy" };
  const production = { cloudAccountId: "ca_1", name: "Production AWS", cloud: "aws", cloudId: "123456789012" };

  it("offers the Servers and Cloud accounts, and no Cloudgate host", async () => {
    mode.data = "hosted";
    servers.data = [worker];
    clouds.data = [production];
    open(null);

    const options = await targetOptions();

    expect(options.some((option) => option.includes("worker-1"))).toBe(true);
    expect(options.some((option) => option.includes("Production AWS"))).toBe(true);
    expect(options.some((option) => option.includes("This Cloudgate host"))).toBe(false);
    expect(document.body.textContent).not.toContain("This Cloudgate host");
  });

  it("asks even with only a Cloud account, and sends it with its region", async () => {
    mode.data = "hosted";
    clouds.data = [production];
    create.mockResolvedValue({ environmentId: "env_new" });
    open(null);

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "staging" } });
    const target = screen.getByRole("combobox");
    fireEvent.click(target);
    await waitFor(() => expect(screen.queryAllByRole("option").length).toBe(1));
    const choice = screen.getByRole("option", { name: /Production AWS/ });
    fireEvent.pointerDown(choice, { pointerType: "mouse" });
    fireEvent.click(choice, { detail: 1 });
    await waitFor(() => expect(screen.getByText("AWS region")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(screen.getByText("Choose the region")).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
  });

  it("with no Server and no Cloud account links to adding one and does not submit", () => {
    mode.data = "hosted";
    open(null);

    expect(screen.getByRole("link", { name: "Add a Server" }).getAttribute("href")).toBe("/servers");
    expect(
      screen.getByRole("link", { name: "Connect a Cloud account" }).getAttribute("href"),
    ).toBe("/settings/cloud-accounts");
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps offering this Cloudgate host when self-hosted (counterpart)", async () => {
    servers.data = [worker];
    open(null);

    expect(await targetOptions()).toEqual(
      expect.arrayContaining([expect.stringContaining("This Cloudgate host")]),
    );
    expect(screen.queryByRole("link", { name: "Add a Server" })).toBeNull();
  });
});
