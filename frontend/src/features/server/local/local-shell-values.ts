/**
 * The connection settings for a shell on **this host** — the machine Cloudgate
 * itself runs on, which has no Server row.
 *
 * ## Why the console has to hold these at all
 *
 * A registered Server's terminal sends one parameter, `serverId`, and the
 * gateway reads the address, the port and the SSH user off that Server's row.
 * `serverId=local` has no row to read: the gateway resolves the *address*
 * itself — loopback natively, the Docker bridge from inside a container
 * — and requires the
 * caller to send the port and the user, closing `4400` without them.
 *
 * So somebody has to say who to sign in as, and it is a real choice rather than
 * a fact the console can look up: the key is installed by hand into one user's
 * `authorized_keys`, and the gateway's own remediation text says to run it "as
 * the same user as the one configured in connection settings". These are those
 * settings. They are asked **once, before the session opens**, and prefilled —
 * `docs/deploy.md` says the backend runs as root on the documented install and
 * that sshd is on 22 — so the stock host is one click, the same as a Server's
 * Terminal tab, and a hardened host is still reachable.
 */

/** What the fields open with. A stock native install connects on these. */
export const DEFAULT_LOCAL_SHELL: LocalShellDraft = {
  username: "root",
  port: "22",
};

/** The fields as typed. Strings, because a half-typed port is not a number. */
export interface LocalShellDraft {
  username: string;
  port: string;
}

/** A checked draft — what the terminal is opened with. */
export interface LocalShellSession {
  username: string;
  port: number;
}

export interface LocalShellCheck {
  /** Present only when both fields are good. */
  session?: LocalShellSession;
  errors: { username?: string; port?: string };
}

/**
 * Read the fields, or say which one is wrong.
 *
 * Both are checked here rather than at the socket, because the gateway's answer
 * to a bad one is to refuse the connection — an operator would watch a terminal
 * open and die to be told a port was empty.
 */
export function checkLocalShell(draft: LocalShellDraft): LocalShellCheck {
  const username = draft.username.trim();
  const port = Number(draft.port.trim());
  const errors: LocalShellCheck["errors"] = {};

  if (!username) {
    errors.username = "Name the user to sign in as. On a stock install, root.";
  }
  if (
    !draft.port.trim() ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    errors.port = "A port is a whole number from 1 to 65535.";
  }

  if (errors.username || errors.port) return { errors };
  return { session: { username, port }, errors };
}

/**
 * What the terminal frame is told it is attached to, and — for `serverId=local`
 * — where its dial parameters come from: `terminal-session.tsx` reads the user
 * and the port back out of this string. `user@host:port` is the documented shape
 * of a terminal target's address, and keeping the two in one place is the point:
 * the shell cannot sign in as a user other than the one printed over it.
 *
 * `localhost` is the host part because that is what this host is called from the
 * process dialling it. The gateway resolves the real address itself and does not
 * read this one.
 */
export function localShellAddress(session: LocalShellSession): string {
  return `${session.username}@localhost:${session.port}`;
}
