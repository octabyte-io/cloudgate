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
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";
import type { SshKeySummary } from "@/lib/api/endpoints/ssh-keys";

const useSshKeys = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const useServers = vi.hoisted(() => vi.fn());
const removeKey = vi.hoisted(() => vi.fn());
const toastDone = vi.hoisted(() => vi.fn());

// Two system boundaries, replaced rather than driven: the keys list this card
// reads, and better-auth's session store that `useInvalidate` reads underneath
// the update mutation. Nothing of the card's own is doubled — the assertions
// below are about the path it names.
vi.mock("@/lib/api/use-ssh-keys", () => ({ useSshKeys }));
vi.mock("@/lib/api/use-servers", () => ({ useServers }));
// The delete's HTTP call and the toast it ends in, for the case below.
vi.mock("@/lib/api/endpoints/ssh-keys", async (original) => {
  const real = await original<typeof import("@/lib/api/endpoints/ssh-keys")>();
  return { ...real, sshKeysApi: { ...real.sshKeysApi, remove: removeKey } };
});
vi.mock("@/components/console/toast", () => ({
  toast: { done: toastDone, error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { KeyCard } = await import("./key-card");

afterEach(() => {
  cleanup();
  useSshKeys.mockReset();
  useActiveOrganizationId.mockReset();
  useServers.mockReset();
});

const key = {
  sshKeyId: "key-1",
  name: "fleet",
  description: null,
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 cloudgate",
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  organizationId: "org-1",
} satisfies SshKeySummary;

/** A Server on that key, signing in as whichever user is under test. */
function server(username: string): Server {
  return {
    serverId: "srv-1",
    name: "ui-self",
    ipAddress: "203.0.113.42",
    port: 22,
    username,
    sshKeyId: key.sshKeyId,
  } as unknown as Server;
}

function said(username: string): string {
  useServers.mockReturnValue({
    data: [server(username)],
    error: null,
    isPending: false,
  });
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  useSshKeys.mockReturnValue({
    data: [key],
    error: null,
    isPending: false,
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(<KeyCard server={server(username)} />));
  return document.body.textContent ?? "";
}

/**
 * The card names one file, and it has to be the file the Server's own user
 * actually has.
 *
 * Both users are rendered because the defect was not the `root` branch missing
 * — it was that there was no branch: one template served every user, and `root`
 * is the user the Add a Server dialog offers by default, so the wrong answer
 * was the one most operators read. `ls /home/root` on the host that produced
 * the finding answers `No such file or directory`.
 */
describe("KeyCard", () => {
  it("names root's own home for a Server that signs in as root", () => {
    const text = said("root");

    expect(text).toContain("/root/.ssh/authorized_keys");
    expect(text).not.toContain("/home/root");
  });

  it("names the user's home under /home for any other user", () => {
    expect(said("deploy")).toContain("/home/deploy/.ssh/authorized_keys");
  });

  it("no longer hedges about which of the two paths is meant", () => {
    // The clause the reader had to resolve for themselves, beside the path that
    // now answers it. Gone for both users, not only for root.
    expect(said("root")).not.toContain("if the user is root");
    cleanup();
    expect(said("deploy")).not.toContain("if the user is root");
  });
});

/**
 * **All keys counts every Server in the Organization, not the page's one**.
 *
 * The dialog is the same `ManageKeysModal` the fleet screen opens, and each row
 * reads usage off the `servers` it is given. Fed only this Server, a key another
 * Server used read "no Server uses it", and its delete confirm said so — while
 * `server.sshKeyId` is `onDelete: 'set null'`, so the delete stranded that other
 * Server. The case below is the finding's: `ui-garbage-2` is used by
 * `ui-unreachable` only, and the dialog is opened from `ui-self`.
 */
describe("KeyCard — All keys", () => {
  const other = {
    ...key,
    sshKeyId: "key-2",
    name: "ui-garbage-2",
  } satisfies SshKeySummary;
  const unreachable = {
    serverId: "srv-2",
    name: "ui-unreachable",
    ipAddress: "203.0.113.9",
    port: 22,
    username: "root",
    sshKeyId: other.sshKeyId,
  } as unknown as Server;

  it("names the other Server that uses a key, in its row, its confirm and its toast", async () => {
    useActiveOrganizationId.mockReturnValue({
      organizationId: "org-1",
      pending: false,
    });
    useSshKeys.mockReturnValue({
      data: [key, other],
      error: null,
      isPending: false,
    });
    useServers.mockReturnValue({
      data: [server("root"), unreachable],
      error: null,
      isPending: false,
    });
    removeKey.mockResolvedValue(undefined);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <KeyCard server={server("root")} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "All keys" }));
    const row = (await screen.findByText("ui-garbage-2")).closest("li");
    if (!row) throw new Error("no row for ui-garbage-2");
    expect(row.textContent).toContain("ui-unreachable uses it");
    expect(row.textContent).not.toContain("no Server uses it");

    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(row.textContent).toContain("ui-unreachable");
    expect(row.textContent).not.toContain("No Server is using it");

    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastDone).toHaveBeenCalled());
    expect(toastDone.mock.calls[0][1]).toEqual({
      description: expect.stringContaining("ui-unreachable has no key now"),
    });
  });

  /**
   * Without the list there is no right answer to "which Servers use it", and
   * the page's own Server alone is the wrong one the ticket was. So the dialog
   * waits for the list, and says why when the list cannot be read.
   */
  it.each([
    [
      "while the Server list loads",
      { data: undefined, error: null, isPending: true },
    ],
    [
      "when the Server list cannot be read",
      { data: undefined, error: new Error("boom"), isPending: false },
    ],
  ])("does not open All keys %s", (_when, servers) => {
    useActiveOrganizationId.mockReturnValue({
      organizationId: "org-1",
      pending: false,
    });
    useSshKeys.mockReturnValue({
      data: [key, other],
      error: null,
      isPending: false,
    });
    useServers.mockReturnValue(servers);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <KeyCard server={server("root")} />
      </QueryClientProvider>,
    );

    const allKeys = screen.getByRole("button", { name: "All keys" });
    expect(
      allKeys.matches(":disabled, [aria-disabled='true'], [data-disabled]"),
    ).toBe(true);
    fireEvent.click(allKeys);
    expect(screen.queryByText("ui-garbage-2")).toBeNull();
    expect(document.body.textContent).not.toContain("no Server uses it");
    if (servers.error) {
      expect(document.body.textContent).toContain(
        "the list of Servers could not be read",
      );
    }
  });
});
