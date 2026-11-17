import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import {
  composeApi,
  type Compose,
  type ComposeDetail,
} from "@/lib/api/endpoints/compose";
import { dockerApi, type ContainerMatch } from "@/lib/api/endpoints/docker";

const toast = vi.hoisted(() => ({
  done: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const permission = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: permission.allowed, pending: false }),
}));

const { ComposeActions, COMPOSE_CONTAINERS_REMOVED } =
  await import("./compose-actions");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  permission.allowed = true;
  for (const fn of Object.values(toast)) fn.mockReset();
});

beforeEach(() => {
  vi.spyOn(composeApi, "findOne").mockReturnValue(new Promise(() => {}));
  vi.spyOn(composeApi, "loadServices").mockResolvedValue(["web", "db"]);
});

function stack(overrides: Partial<ComposeDetail> = {}) {
  return {
    composeId: "cmp-1",
    environmentId: "env-1",
    serverId: null,
    cloudAccountId: null,
    name: "invoices",
    appName: "invoices-a1b2c3",
    composeType: "docker-compose",
    composeStatus: "done",
    sourceType: "raw",
    composeFile: "services:\n  web:\n    image: nginx\n",
    ...overrides,
  } as ComposeDetail;
}

function withQuery(children: ReactNode, queryClient = client()) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const container = (name: string, state: string) =>
  ({ containerId: name, name, state, status: state }) as ContainerMatch;

const up = [container("web-1", "running"), container("db-1", "running")];
const partly = [container("web-1", "running"), container("db-1", "exited")];
const down = [container("web-1", "exited"), container("db-1", "exited")];

const named = (name: string) => screen.queryByRole("button", { name });

/**
 * Start on a stack whose containers are all up ran `docker compose up -d`
 * over them, which does nothing, and the button looked as live as Deploy.
 * Restart takes its slot while the containers are up; the two are never in
 * the row together.
 */
describe("ComposeActions: Start or Restart on a Server", () => {
  it("offers Restart, not Start, when every container is running", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(up);
    render(withQuery(<ComposeActions compose={stack()} />));

    await waitFor(() => expect(named("Restart")).not.toBe(null));
    expect(named("Start")).toBe(null);
    expect(named("Restart")?.getAttribute("aria-disabled")).toBe(null);
    expect(named("Restart")?.getAttribute("title")).toBe(
      "docker compose restart — the containers restart. Nothing is cloned or built.",
    );
  });

  it("keeps Restart in the slot Start had, between Deploy and Stop", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(up);
    render(withQuery(<ComposeActions compose={stack()} />));

    await waitFor(() => expect(named("Restart")).not.toBe(null));
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Deploy",
      "Restart",
      "Stop",
      "Remove containers",
    ]);
  });

  it("offers Start when one of its containers has stopped", async () => {
    const members = vi
      .spyOn(dockerApi, "containersByApp")
      .mockResolvedValue(partly);
    render(withQuery(<ComposeActions compose={stack()} />));

    await waitFor(() => expect(members).toHaveBeenCalled());
    await waitFor(() => expect(named("Start")).not.toBe(null));
    expect(named("Restart")).toBe(null);
  });

  it("offers Start on a stopped stack", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(down);
    render(
      withQuery(<ComposeActions compose={stack({ composeStatus: "stopped" })} />),
    );

    await waitFor(() => expect(named("Start")).not.toBe(null));
    expect(named("Start")?.getAttribute("aria-disabled")).toBe(null);
    expect(named("Restart")).toBe(null);
  });

  it("offers Start, saying it recreates them, on a stack whose containers are removed", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue([]);
    render(
      withQuery(<ComposeActions compose={stack({ composeStatus: "stopped" })} />),
    );

    await waitFor(() =>
      expect(screen.queryByText(COMPOSE_CONTAINERS_REMOVED)).not.toBe(null),
    );
    expect(named("Start")?.getAttribute("aria-disabled")).toBe(null);
    expect(named("Restart")).toBe(null);
  });

  it("goes from Restart to Start when the stack is stopped on another tab", async () => {
    const members = vi
      .spyOn(dockerApi, "containersByApp")
      .mockResolvedValue(up);
    const queryClient = client();
    const { rerender } = render(
      withQuery(<ComposeActions compose={stack()} />, queryClient),
    );
    await waitFor(() => expect(named("Restart")).not.toBe(null));

    members.mockResolvedValue(down);
    rerender(
      withQuery(
        <ComposeActions compose={stack({ composeStatus: "stopped" })} />,
        queryClient,
      ),
    );

    await waitFor(() => expect(named("Start")).not.toBe(null));
    expect(named("Restart")).toBe(null);
  });

  it("goes from Start to Restart once a Deploy brings the containers up", async () => {
    const members = vi
      .spyOn(dockerApi, "containersByApp")
      .mockResolvedValue(down);
    const queryClient = client();
    const { rerender } = render(
      withQuery(
        <ComposeActions compose={stack({ composeStatus: "error" })} />,
        queryClient,
      ),
    );
    await waitFor(() => expect(named("Start")).not.toBe(null));

    // The Deploy finished: the row reads `done`, Docker reads them up.
    members.mockResolvedValue(up);
    rerender(withQuery(<ComposeActions compose={stack()} />, queryClient));

    await waitFor(() => expect(named("Restart")).not.toBe(null));
    expect(named("Start")).toBe(null);
  });
});

describe("ComposeActions: Restart's press", () => {
  it("restarts the containers and says so", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(up);
    const restart = vi
      .spyOn(composeApi, "restart")
      .mockResolvedValue(stack() as Compose);
    render(withQuery(<ComposeActions compose={stack()} />));
    await waitFor(() => expect(named("Restart")).not.toBe(null));

    fireEvent.click(named("Restart")!);

    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "invoices's containers are restarting.",
        undefined,
      ),
    );
    expect(restart).toHaveBeenCalledWith("cmp-1");
  });

  it("shows the restart pending in every row of the stack and refuses a second press", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(up);
    const restart = vi
      .spyOn(composeApi, "restart")
      .mockReturnValue(new Promise<Compose>(() => {}));
    render(
      withQuery(
        <>
          <div data-testid="header">
            <ComposeActions compose={stack()} />
          </div>
          <div data-testid="tab">
            <ComposeActions compose={stack()} size="sm" />
          </div>
        </>,
      ),
    );
    const header = screen.getByTestId("header");
    await waitFor(() =>
      expect(within(header).queryByRole("button", { name: "Restart" })).not.toBe(
        null,
      ),
    );

    fireEvent.click(within(header).getByRole("button", { name: "Restart" }));

    const other = within(screen.getByTestId("tab")).getByRole("button", {
      name: "Restart",
    });
    await waitFor(() => expect(other.getAttribute("aria-busy")).toBe("true"));
    expect(other.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(other);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal, a Server in Maintenance's among them", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(up);
    const refusal = new ApiError(409, "The Server is in maintenance", {
      path: "/compose/cmp-1/restart",
    });
    vi.spyOn(composeApi, "restart").mockRejectedValue(refusal);
    render(withQuery(<ComposeActions compose={stack()} />));
    await waitFor(() => expect(named("Restart")).not.toBe(null));

    fireEvent.click(named("Restart")!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
    expect(toast.done).not.toHaveBeenCalled();
  });

  it("is off for a role that may not deploy, saying why", async () => {
    permission.allowed = false;
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue(up);
    const restart = vi.spyOn(composeApi, "restart");
    render(withQuery(<ComposeActions compose={stack()} />));
    await waitFor(() => expect(named("Restart")).not.toBe(null));

    const button = named("Restart")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toMatch(/restart this stack's containers/);
    fireEvent.click(button);
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("ComposeActions: Start or Restart on a Stack VM", () => {
  const onVm = (overrides: Partial<ComposeDetail> = {}) =>
    stack({ cloudAccountId: "acct-1", ...overrides });

  it("offers Restart, not Start, on a deployed stack, saying the VM keeps running", () => {
    const members = vi.spyOn(dockerApi, "containersByApp");
    render(withQuery(<ComposeActions compose={onVm()} />));

    expect(named("Start")).toBe(null);
    expect(named("Restart")?.getAttribute("title")).toBe(
      "docker compose restart — the containers restart. The Stack VM keeps running.",
    );
    // Its membership is not read from the VM.
    expect(members).not.toHaveBeenCalled();
  });

  it("names the Stack VM in Restart's toast", async () => {
    vi.spyOn(composeApi, "restart").mockResolvedValue(onVm() as Compose);
    render(withQuery(<ComposeActions compose={onVm()} />));

    fireEvent.click(named("Restart")!);

    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "invoices's containers are restarting. Its Stack VM keeps running.",
        undefined,
      ),
    );
  });

  it.each(["stopped", "error"] as const)(
    "offers Start, not Restart, on a %s stack, since only Start brings the VM back",
    (composeStatus) => {
      render(withQuery(<ComposeActions compose={onVm({ composeStatus })} />));

      expect(named("Start")).not.toBe(null);
      expect(named("Restart")).toBe(null);
    },
  );
});

describe("ComposeActions on a Swarm stack", () => {
  it("offers neither Start nor Restart: Deploy is what restarts one", () => {
    render(
      withQuery(<ComposeActions compose={stack({ composeType: "stack" })} />),
    );

    expect(named("Start")).toBe(null);
    expect(named("Restart")).toBe(null);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Deploy",
      "Stop",
    ]);
  });
});
