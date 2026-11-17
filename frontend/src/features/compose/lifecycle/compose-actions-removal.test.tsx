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
  type ComposeDetail,
  type Compose,
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

const { ComposeActions, COMPOSE_CONTAINERS_REMOVED } =
  await import("./compose-actions");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of Object.values(toast)) fn.mockReset();
});

beforeEach(() => {
  // The row's own reads, which nothing here is about.
  vi.spyOn(composeApi, "findOne").mockReturnValue(new Promise(() => {}));
  vi.spyOn(composeApi, "loadServices").mockResolvedValue(["web"]);
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

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function withQuery(queryClient: QueryClient, children: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const running: ContainerMatch[] = [
  {
    containerId: "c1",
    name: "invoices-a1b2c3-web-1",
    state: "exited",
    status: "Exited (0) 3 minutes ago",
  } as ContainerMatch,
];

/** Presses Remove containers in `row`, then the dialog's own button. */
function removeFrom(row: HTMLElement) {
  fireEvent.click(within(row).getByRole("button", { name: "Remove containers" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Remove containers" }),
  );
}

/**
 * The report: Remove containers ran, twice, and the page gave no sign of it.
 * Two halves. While it runs, every Compose row on the page — the header's on
 * each tab, an empty state's — says it is running and refuses a second press,
 * not only the row it was pressed in. Once it has run, the row says the
 * containers are gone: Stop and Remove containers have nothing left to act on.
 */
describe("ComposeActions while Remove containers runs", () => {
  it("shows the removal pending in every row of the stack and refuses a second press", async () => {
    const removal = vi
      .spyOn(composeApi, "removeContainers")
      .mockReturnValue(new Promise<Compose>(() => {}));
    const queryClient = client();
    render(
      withQuery(
        queryClient,
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

    removeFrom(screen.getByTestId("header"));

    const other = within(screen.getByTestId("tab")).getByRole("button", {
      name: "Remove containers",
    });
    await waitFor(() => expect(other.getAttribute("aria-busy")).toBe("true"));
    expect(other.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(other);
    expect(screen.queryByRole("dialog")).toBe(null);
    expect(removal).toHaveBeenCalledTimes(1);
  });
});

describe("ComposeActions after Remove containers", () => {
  it("says the containers are removed and that Start recreates them", async () => {
    vi.spyOn(composeApi, "removeContainers").mockResolvedValue(
      stack({ composeStatus: "stopped" }) as Compose,
    );
    render(withQuery(client(), <ComposeActions compose={stack()} />));

    removeFrom(document.body);

    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "invoices's containers are removed.",
        {
          description:
            "Its named volumes and project directory stay. Start recreates the containers.",
        },
      ),
    );
  });

  it("says what failed when the removal is refused", async () => {
    const refusal = new ApiError(
      409,
      "Volume invoices-data is busy with a backup",
      { path: "/compose/cmp-1/remove-containers" },
    );
    vi.spyOn(composeApi, "removeContainers").mockRejectedValue(refusal);
    render(withQuery(client(), <ComposeActions compose={stack()} />));

    removeFrom(document.body);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
    expect(toast.done).not.toHaveBeenCalled();
  });

  it("turns Stop and Remove containers off once the stack's row reads stopped with nothing on its deploy target, and leaves Start on", async () => {
    vi.spyOn(composeApi, "removeContainers").mockResolvedValue(
      stack({ composeStatus: "stopped" }) as Compose,
    );
    // The refresh reads Docker again; the row must not wait for it.
    vi.spyOn(dockerApi, "containersByApp").mockReturnValue(
      new Promise<ContainerMatch[]>(() => {}),
    );
    const queryClient = client();
    const { rerender } = render(
      withQuery(queryClient, <ComposeActions compose={stack()} />),
    );

    removeFrom(document.body);
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    // The row the refresh reads back.
    rerender(
      withQuery(
        queryClient,
        <ComposeActions compose={stack({ composeStatus: "stopped" })} />,
      ),
    );

    for (const name of ["Stop", "Remove containers"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(COMPOSE_CONTAINERS_REMOVED);
    }
    expect(
      screen.getByRole("button", { name: "Start" }).getAttribute("aria-disabled"),
    ).toBe(null);
    expect(screen.getByText(COMPOSE_CONTAINERS_REMOVED)).not.toBe(null);
  });

  it("reads the same off state from Docker for a stopped stack opened later", async () => {
    vi.spyOn(dockerApi, "containersByApp").mockResolvedValue([]);
    render(
      withQuery(
        client(),
        <ComposeActions compose={stack({ composeStatus: "stopped" })} />,
      ),
    );

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Remove containers" })
          .getAttribute("aria-disabled"),
      ).toBe("true"),
    );
  });

  it("keeps Stop and Remove containers on for a stopped stack whose exited containers are still there", async () => {
    const members = vi
      .spyOn(dockerApi, "containersByApp")
      .mockResolvedValue(running);
    render(
      withQuery(
        client(),
        <ComposeActions compose={stack({ composeStatus: "stopped" })} />,
      ),
    );

    await waitFor(() => expect(members).toHaveBeenCalled());
    for (const name of ["Stop", "Remove containers"]) {
      expect(
        screen.getByRole("button", { name }).getAttribute("aria-disabled"),
      ).toBe(null);
    }
    expect(screen.queryByText(COMPOSE_CONTAINERS_REMOVED)).toBe(null);
  });

  it("turns Remove containers off on a stack no Deploy has run, with Start and Stop", () => {
    render(
      withQuery(
        client(),
        <ComposeActions compose={stack({ composeStatus: "idle" })} />,
      ),
    );

    expect(
      screen
        .getByRole("button", { name: "Remove containers" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
