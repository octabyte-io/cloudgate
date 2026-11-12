import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The first-run path. With no SSH keys, Add a Server's way out is
 * "Manage SSH keys" — and coming back used to mean a fresh form, with the Name
 * and Address gone and the new key not chosen.
 *
 * The keys list and the two creates are the boundary; both dialogs are real.
 */
type Key = {
  sshKeyId: string;
  name: string;
  description: string | null;
  publicKey: string;
  createdAt: string;
  lastUsedAt: string | null;
};
const keys = vi.hoisted(() => ({ current: [] as Key[] }));
const createServer = vi.hoisted(() => vi.fn());

const keyList = () => ({ data: keys.current, isPending: false, error: null });
vi.mock("@/lib/api/use-ssh-keys", () => ({ useSshKeys: keyList }));
vi.mock("@/features/ssh-keys/use-ssh-keys", () => ({
  useSshKeys: keyList,
  useCreateSshKey: () => ({
    mutateAsync: async (input: { name: string }) => {
      const created = {
        sshKeyId: "key-new",
        name: input.name,
        description: null,
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample cloudgate",
        createdAt: "2026-11-03T18:00:00.000Z",
        lastUsedAt: null,
      };
      keys.current = [...keys.current, created];
      return created;
    },
  }),
  useUpdateSshKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSshKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useCreateServer: () => ({ mutateAsync: createServer }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/billing/server-allowance-notice", () => ({
  useServerAllowance: () => ({ blocked: false }),
  ServerAllowanceNotice: () => null,
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { AddServerDialogs } = await import("./add-server-dialogs");

function Screen() {
  const [adding, setAdding] = useState(true);
  const [managingKeys, setManagingKeys] = useState(false);
  return (
    <AddServerDialogs
      opening={1}
      adding={adding}
      onAddingChange={setAdding}
      managingKeys={managingKeys}
      onManagingKeysChange={setManagingKeys}
      servers={[]}
    />
  );
}

afterEach(() => {
  cleanup();
  keys.current = [];
  createServer.mockReset();
});

describe("Add a Server, by way of the SSH keys dialog", () => {
  it("comes back with what was typed and the new key chosen", async () => {
    createServer.mockResolvedValue({ serverId: "srv-1", name: "vps-a" });
    render(<Screen />);

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "vps-a" },
    });
    fireEvent.change(screen.getByLabelText(/^Address/), {
      target: { value: "203.0.113.10" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Manage SSH keys/ }));

    // The keys dialog, over a hidden Add.
    await screen.findByRole("button", { name: "Add key" });
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "first-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(keys.current).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // Back on Add, as it was.
    await screen.findByRole("button", { name: "Add Server" });
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "vps-a",
    );
    expect((screen.getByLabelText(/^Address/) as HTMLInputElement).value).toBe(
      "203.0.113.10",
    );

    // And the key it went to make is the one it sends.
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));
    await waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    expect(createServer.mock.calls[0][0]).toMatchObject({
      name: "vps-a",
      ipAddress: "203.0.113.10",
      sshKeyId: "key-new",
    });
  });
});
