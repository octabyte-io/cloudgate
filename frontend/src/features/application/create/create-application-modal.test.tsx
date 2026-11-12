import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const create = vi.fn();
const done = vi.fn();
const errorToast = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/api/endpoints/applications", () => ({
  applicationsApi: { create: (...args: unknown[]) => create(...args) },
}));

const servers = [
  { serverId: "srv_1", name: "web-1", ipAddress: "10.0.0.7" },
];
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: servers, isPending: false }),
}));

// The real one reaches the auth client for the active Organization, which is
// the whole session stack; what this test is about is the request body.
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ application: vi.fn() }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: {
    done: (...args: unknown[]) => done(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}));

const { CreateApplicationModal } = await import("./create-application-modal");
type DeployTarget = Parameters<typeof CreateApplicationModal>[0]["deployTarget"];

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open(
  onOpenChange = vi.fn(),
  deployTarget: DeployTarget = { kind: "platform-host" },
) {
  render(
    <CreateApplicationModal
      environmentId="env_1"
      environmentName="production"
      deployTarget={deployTarget}
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper: Wrapper },
  );
  return onOpenChange;
}

beforeEach(() => {
  push.mockReset();
  create.mockReset();
  done.mockReset();
  errorToast.mockReset();
});

afterEach(cleanup);

/**
 * The create flow, driven the way a person drives it.
 *
 * The one thing worth pinning with a render rather than with the pure fold
 * beside it is the **ending**: `POST /applications` answers with the row, and
 * the whole argument for a create dialog that opens from a list is that it lands
 * on the thing it just made. A flow that creates the Application and leaves you
 * on the list is the dead end F08 refused to ship, and nothing in the fold can
 * catch that.
 */
describe("CreateApplicationModal", () => {
  it("creates the Application, tells you it is not deployed, and lands on it", async () => {
    create.mockResolvedValue({ applicationId: "app_1", name: "Storefront web" });
    const onOpenChange = open();

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "  Storefront web  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Application" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Storefront web",
        environmentId: "env_1",
        serverId: null,
      }),
    );

    expect(done).toHaveBeenCalledWith("Storefront web created.", {
      description:
        "It is not deployed yet — set where its code comes from, then deploy.",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/applications/app_1");
  });

  it("starts on the Environment's Deploy target Server and creates it there", async () => {
    create.mockResolvedValue({ applicationId: "app_1", name: "Storefront web" });
    open(vi.fn(), { kind: "server", serverId: "srv_1" });

    // The picker shows the target, not this Cloudgate host.
    expect(screen.getByRole("combobox").textContent).toContain("web-1");
    expect(
      screen.getByText("Which Server it runs on. It starts on this Environment's Deploy target."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Storefront web" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Application" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Storefront web",
        environmentId: "env_1",
        serverId: "srv_1",
      }),
    );
  });

  it("refuses a blank name at the field, without calling the route", async () => {
    const onOpenChange = open();

    fireEvent.click(screen.getByRole("button", { name: "Create Application" }));

    expect(await screen.findByText("An Application needs a name.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("stays open and toasts when the backend refuses", async () => {
    const refusal = Object.assign(new Error("nope"), { status: 500 });
    create.mockRejectedValue(refusal);
    const onOpenChange = open();

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Storefront web" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Application" }));

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(refusal));
    expect(push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
