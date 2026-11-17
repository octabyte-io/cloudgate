import { describe, expect, it } from "vitest";

import { startOrRestart } from "./start-or-restart";

const of = (...states: string[]) => states.map((state) => ({ state }));

describe("startOrRestart", () => {
  it.each([
    ["every container running", of("running", "running"), "restart"],
    ["one restarting under its policy", of("running", "restarting"), "restart"],
    ["one exited", of("running", "exited"), "start"],
    ["one paused", of("running", "paused"), "start"],
    ["none there", of(), "start"],
  ] as const)("on a Server, %s: %s", (_, members, expected) => {
    expect(
      startOrRestart({ composeStatus: "done", stackVm: false, members }),
    ).toBe(expected);
  });

  it("lets the containers decide on a Server even when the row reads error", () => {
    expect(
      startOrRestart({
        composeStatus: "error",
        stackVm: false,
        members: of("running"),
      }),
    ).toBe("restart");
  });

  it.each(["idle", "stopped"] as const)(
    "is Start on an %s stack, whatever Docker says",
    (composeStatus) => {
      expect(
        startOrRestart({ composeStatus, stackVm: false, members: of("running") }),
      ).toBe("start");
    },
  );

  it.each([
    ["done", "restart"],
    ["running", "start"],
    ["error", "start"],
  ] as const)(
    "reads the status alone until Docker answers, and on a Stack VM: %s is %s",
    (composeStatus, expected) => {
      for (const stackVm of [false, true]) {
        expect(
          startOrRestart({ composeStatus, stackVm, members: undefined }),
        ).toBe(expected);
      }
    },
  );
});
