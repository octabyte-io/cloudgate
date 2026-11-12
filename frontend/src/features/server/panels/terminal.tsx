"use client";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { LinkButton } from "@/components/console/link-button";
import { Terminal } from "@/components/console/terminal";
import type { Server } from "@/lib/api/endpoints/servers";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ServerPanel } from "../server-panel";
import { serverTerminalTarget } from "../shell-offers";

/**
 * A shell on this Server.
 *
 * **This is the tab F13 added, and it is the phase's one edit to the registry**
 * (`lib/shell/tabs/server.ts`, contract rule 2 — the reasoning is in that file too).
 * The reference has "Open a shell" as a header action opening nothing in particular;
 * a tab is the better home for three reasons, and only the last is about taste:
 *
 * 1. **A dialog dies on Escape**, and Escape is a key people press inside a terminal
 *    constantly — `vim`, `less`, a mistyped command. A dialog would end the session
 *    every time.
 * 2. **It has an address**, so a shell can be opened in a second browser tab beside
 *    whatever screen sent you looking for one. Every other tab's header links here for
 *    exactly that.
 * 3. **A privileged surface should say what it is attached to in its own page
 *    header**, which is where the masthead already names the Server.
 *
 * Teardown is `<Terminal>`'s: leaving the tab ends a session the page still holds and
 * closes the socket, and the gateway's `ws.on("close")` closes the SSH channel behind
 * it. Nothing has to be remembered. A session moved into the docked terminal with its
 * Dock control is the Dock's instead, and outlives the tab.
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      aside={(server) => <ShellAside server={server} />}
    >
      {(server) =>
        server.sshKeyId === null ? (
          <Card>
            <Card.Body>
              {/* The gateway closes the connection at once without a key,
                  which would look like a terminal that failed for no reason —
                  so no terminal is drawn. */}
              <p className="text-body text-tx">
                Choose an SSH key for this Server to open a shell on it.
              </p>
              <LinkButton
                size="sm"
                variant="pri"
                className="mt-2.5"
                href={`/servers/${server.serverId}/access`}
              >
                Choose a key
              </LinkButton>
            </Card.Body>
          </Card>
        ) : (
          <Terminal target={serverTerminalTarget(server)} />
        )
      }
    </ServerPanel>
  );
}

/**
 * What this session is and is not.
 *
 * This used to carry the 80 × 24 note — the session was that size for its whole life
 * because nothing could tell the Server the window had changed. The socket now has a
 * resize control frame, so the size is now the frame's and says so in the frame
 * itself; what is left here is what the operator still cannot get back.
 */
function ShellAside({ server }: { server: Server }) {
  return (
    <Card>
      <Card.Header title="About this session" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Host"
            value={server.ipAddress}
            title={server.ipAddress}
            mono
          />
          <KVRow
            label="User"
            value={server.username}
            title={server.username}
            mono
          />
          <KVRow label="Port" value={String(server.port)} mono />
        </KVList>
        <p className="mt-3 text-ui text-tx-2">
          The pty is the size of the frame. Resize the window and Cloudgate
          tells the Server, which signals whatever is running there —{" "}
          <code className="font-mono">top</code> and{" "}
          <code className="font-mono">vim</code> redraw into the new shape. The
          current size is printed above the terminal.
        </p>
        <p className="mt-2.5 text-ui text-tx-2">
          A real shell as{" "}
          <code className="font-mono wrap-anywhere">{server.username}</code>:
          Cloudgate records nothing you run and undoes none of it.
        </p>
      </Card.Body>
      <Card.Footer>
        {/* There is no way to reattach to an ended session. */}
        Leaving this tab ends the session unless you Dock it first; run
        anything long under <code className="font-mono">tmux</code> or{" "}
        <code className="font-mono">nohup</code>.
      </Card.Footer>
    </Card>
  );
}
