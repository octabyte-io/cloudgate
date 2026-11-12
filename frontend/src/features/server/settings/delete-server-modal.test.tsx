import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../use-server", () => ({
  useDeleteServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../docker/use-server-docker", () => ({
  useSwarmServices: () => ({ data: [], isPending: false, error: null }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { DeleteServerModal } = await import("./delete-server-modal");

const own = {
  serverId: "srv-1",
  name: "web-1",
  ipAddress: "203.0.113.7",
  boughtServer: null,
} as unknown as Server;

function renderModal(server: Server) {
  return render(
    <DeleteServerModal server={server} open onOpenChange={() => {}} />,
  );
}

afterEach(cleanup);

describe("DeleteServerModal", () => {
  it("says plainly that a Bought Server's data and backups are gone for good", () => {
    renderModal({
      ...own,
      boughtServer: { stage: "ready", deletesOn: null, deletedAt: null },
    });

    expect(
      screen.getByText(
        "Its machine is deleted, with its data and backups. This cannot be undone.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/They are gone for good/)).toBeTruthy();
    expect(screen.queryByText(/Nothing is stopped/)).toBeNull();
  });

  it("keeps the Services rule for a Bought Server", () => {
    renderModal({
      ...own,
      boughtServer: { stage: "ready", deletesOn: null, deletedAt: null },
    });

    expect(screen.getByText(/Move them to another Server/)).toBeTruthy();
  });

  it("still says a Server of the customer's own is only forgotten", () => {
    renderModal(own);

    expect(
      screen.getByText("Cloudgate forgets the machine. It does not touch it."),
    ).toBeTruthy();
    expect(screen.queryByText(/gone for good/)).toBeNull();
  });
});
