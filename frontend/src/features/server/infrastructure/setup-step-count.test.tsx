import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

/**
 * **The setup copy counts the steps the list shows** (#187).
 *
 * The dialog and the card's heading both said "six steps" over a list of
 * eight, so a user checking the log against the list was told two steps
 * were not there. The count is written as a word in the copy, so it is held
 * to `STEPS.length` here: adding a step turns this red until the copy says so.
 */
vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useValidateServer: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    submittedAt: 0,
  }),
  useServerSetupRun: () => ({
    state: "running",
    lines: [],
    dropped: 0,
    connection: "open",
    reason: null,
    start: vi.fn(),
    watch: vi.fn(),
  }),
}));

const { SetupConfirmModal } = await import("./setup-confirm-modal");
const { SetupCard } = await import("./setup-card");
const { STEPS } = await import("./setup-steps");

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
const count = WORDS[STEPS.length];

const server = {
  serverId: "srv-1",
  name: "vps-a",
  ipAddress: "203.0.113.10",
  port: 22,
  username: "root",
  sshKeyId: "key-1",
  command: "",
  reachCheckedAt: null,
  reachOk: null,
  reachMessage: null,
  setupRanAt: null,
  setupOk: null,
  setupMessage: null,
} as unknown as Server;

afterEach(cleanup);

describe("setup step count", () => {
  it("names as many steps in the dialog as the list holds", () => {
    render(
      <SetupConfirmModal
        server={server}
        custom=""
        state="idle"
        actionLabel="Run setup"
        open
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(screen.getByRole("dialog").textContent).toContain(
      `It is the ${count} steps on the tab behind this one.`,
    );
  });

  it("names as many steps over the running list as the list holds", () => {
    render(<SetupCard server={server} />);

    expect(
      screen.getByText(
        `The ${count} steps, numbered the way the script numbers them in the output above.`,
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(
      STEPS.length,
    );
  });
});
