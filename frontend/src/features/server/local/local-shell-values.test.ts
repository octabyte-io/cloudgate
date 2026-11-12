import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_SHELL,
  checkLocalShell,
  localShellAddress,
} from "./local-shell-values";

describe("the local Server's connection settings", () => {
  it("connects a stock host on its defaults, with nothing typed", () => {
    // The whole ergonomic claim: `docs/deploy.md`'s install runs the backend as
    // root and sshd on 22, so opening a shell here is one click — the same as a
    // registered Server's Terminal tab, which asks nothing.
    const { session, errors } = checkLocalShell(DEFAULT_LOCAL_SHELL);

    expect(errors).toEqual({});
    expect(session).toEqual({ username: "root", port: 22 });
  });

  it("reads a hardened host's own port and user", () => {
    expect(
      checkLocalShell({ username: "deploy", port: "2222" }).session,
    ).toEqual({ username: "deploy", port: 2222 });
  });

  it("trims the user, so a pasted name still matches authorized_keys", () => {
    expect(checkLocalShell({ username: " root ", port: "22" }).session).toEqual(
      {
        username: "root",
        port: 22,
      },
    );
  });

  it("refuses an empty user rather than opening a socket that will be", () => {
    // The gateway's answer to this is to close the connection, which an
    // operator reads as a terminal that failed for no reason.
    const { session, errors } = checkLocalShell({ username: "  ", port: "22" });

    expect(session).toBeUndefined();
    expect(errors.username).toContain("user to sign in as");
  });

  it.each(["", "0", "70000", "22.5", "twenty-two"])(
    "refuses %o as a port",
    (port) => {
      const { session, errors } = checkLocalShell({ username: "root", port });

      expect(session).toBeUndefined();
      expect(errors.port).toContain("1 to 65535");
    },
  );

  it("writes the address the terminal's dial parameters are read back out of", () => {
    // `terminal-session.tsx` parses this string for `serverId=local`. The two
    // have to agree: `localDial(localShellAddress(s))` is `s`.
    expect(localShellAddress({ username: "deploy", port: 2222 })).toBe(
      "deploy@localhost:2222",
    );
  });
});
