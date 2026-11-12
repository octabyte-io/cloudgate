import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeployTarget } from "@/lib/api/endpoints/environments";

const push = vi.fn();
const create = vi.fn();
const update = vi.fn();
const done = vi.fn();
const errorToast = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/api/endpoints/compose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints/compose")>()),
  composeApi: {
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
  },
}));

vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: [], isPending: false }),
}));

// The real one reaches the auth client for the active Organization, which is
// the whole session stack; what this test is about is the request body.
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ compose: vi.fn() }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: {
    done: (...args: unknown[]) => done(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}));

const { CreateComposeModal } = await import("./create-compose-modal");

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
    <CreateComposeModal
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

function submit(name: string) {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create stack" }));
}

beforeEach(() => {
  push.mockReset();
  create.mockReset();
  update.mockReset();
  done.mockReset();
  errorToast.mockReset();
});

afterEach(cleanup);

/**
 * Which source the stack is created with (#1338).
 *
 * `POST /compose` used to take no `sourceType`, so "A file written here" was a
 * create followed by `PATCH {sourceType: "raw"}` — and a failed `PATCH` was
 * swallowed, leaving a stack stored as GitHub that the deploy refused. The
 * create says it now, so it is one request.
 */
describe("CreateComposeModal", () => {
  it("creates a stack whose file is written here in one request, as raw", async () => {
    create.mockResolvedValue({ composeId: "cmp_1", name: "Workers" });
    const onOpenChange = open();

    submit("Workers");

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Workers",
        environmentId: "env_1",
        composeType: "docker-compose",
        serverId: null,
        composeFile: "",
        sourceType: "raw",
      }),
    );
    // No follow-up call to fix the source afterwards.
    expect(update).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/compose/cmp_1");
  });

  it("creates a stack from a repository without a sourceType, leaving it to be chosen", async () => {
    create.mockResolvedValue({ composeId: "cmp_2", name: "Workers" });
    open();

    fireEvent.click(screen.getByText("From a repository"));
    submit("Workers");

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Workers",
        environmentId: "env_1",
        composeType: "docker-compose",
        serverId: null,
        composeFile: "",
      }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/compose/cmp_2");
  });
});

/**
 * A stack in a Cloud Environment runs on its own Stack VM (#1372, ADR-0070):
 * the form asks for no Server, and says what it starts at and costs.
 */
describe("CreateComposeModal, in a Cloud Environment", () => {
  const CLOUD: DeployTarget = {
    kind: "cloud",
    cloudAccountId: "ca_1",
    region: "eu-west-1",
  };

  it("has no Server picker and no Swarm choice, and shows the starting size and cost note", () => {
    open(vi.fn(), CLOUD);

    expect(screen.queryByText("Server")).toBeNull();
    expect(screen.queryByText("Applied as")).toBeNull();
    const note = screen.getByRole("region", { name: "Stack VM" });
    expect(note.textContent).toContain("Runs on its own Stack VM");
    expect(note.textContent).toContain("medium (1 CPU, 2 GB)");
    expect(note.textContent).toContain("20 GB data disk");
    expect(note.textContent).toMatch(
      /plan shows the machine type and its monthly price, and nothing is made until you apply it/,
    );
  });

  it("creates the stack with no serverId, as docker-compose, and says its plan makes the Stack VM", async () => {
    create.mockResolvedValue({ composeId: "cmp_3", name: "Wiki" });
    open(vi.fn(), CLOUD);

    submit("Wiki");

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Wiki",
        environmentId: "env_1",
        composeType: "docker-compose",
        composeFile: "",
        sourceType: "raw",
      }),
    );
    expect(done).toHaveBeenCalledWith("Wiki created.", {
      description: expect.stringMatching(
        /^Its Stack VM is made when you apply this Environment's plan/,
      ),
    });
    expect(push).toHaveBeenCalledWith("/compose/cmp_3");
  });
});
