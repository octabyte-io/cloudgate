import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { LinkButton } from "@/components/console/link-button";
import { StatusPill } from "@/components/console/status-pill";
import type { Server } from "@/lib/api/endpoints/servers";
import { useSshKeys } from "@/lib/api/use-ssh-keys";
import { timeAgo, timeExact } from "@/lib/format/time";
import { serverMark } from "@/lib/design/server-mark";

/** What each `serverType` is called. The same two words the table uses. */
const ROLE: Record<Server["serverType"], string> = {
  deploy: "Deploy",
  build: "Build",
};

/**
 * The Server, as facts — the reference's aside card (`e-console.html:3610-3620`)
 * with its Origin row removed, because there is one origin.
 *
 * **The SSH line is the useful one** and it is assembled rather than stored:
 * `user@host:port` is what somebody pastes into their own terminal when the console
 * is not enough, so it carries a copy control. The key row names the key rather
 * than showing it — the public half is on the Access tab, where there is room for
 * a line of base64 and the sentence about `authorized_keys`.
 *
 * A Server with **no key** is a real state rather than a broken one: deleting a key
 * sets `server.sshKeyId` to null instead of refusing, so this row says so plainly
 * and points at the tab that fixes it.
 */
export function ServerFactsCard({ server }: { server: Server }) {
  const sshKeys = useSshKeys();
  const key = sshKeys.data?.find((row) => row.sshKeyId === server.sshKeyId);
  const ssh = `${server.username}@${server.ipAddress}:${server.port}`;

  return (
    <Card>
      <Card.Header title="Server" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Status"
            value={<StatusPill mark={serverMark(server)} />}
          />
          <KVRow label="Role" value={ROLE[server.serverType]} />
          <KVRow
            label="Address"
            value={server.ipAddress}
            mono
            title={server.ipAddress}
            action={
              <CopyButton
                value={server.ipAddress}
                label="address"
                size="icon-xs"
              />
            }
          />
          <KVRow
            label="SSH"
            value={ssh}
            mono
            title={ssh}
            action={
              <CopyButton value={ssh} label="SSH target" size="icon-xs" />
            }
          />
          <KVRow
            label="Key"
            value={
              server.sshKeyId === null ? (
                <Dash word="None" />
              ) : (
                (key?.name ?? server.sshKeyId)
              )
            }
            mono={server.sshKeyId !== null && !key}
          />
          <KVRow
            label="Added"
            value={timeAgo(server.createdAt) ?? <Dash word="Unknown" />}
            title={timeExact(server.createdAt)}
          />
          <KVRow
            label="ID"
            value={server.serverId}
            mono
            title={server.serverId}
            action={
              <CopyButton
                value={server.serverId}
                label="Server id"
                size="icon-xs"
              />
            }
          />
        </KVList>

        {server.sshKeyId === null ? (
          <div className="mt-3 rounded-lg border border-bad-line bg-bad-tint p-2.5">
            <p className="text-meta text-tx">
              This Server has no SSH key, so Cloudgate cannot reach it at all —
              nothing can be deployed, inspected or set up here.
            </p>
            <LinkButton
              size="xs"
              className="mt-2"
              href={`/servers/${server.serverId}/access`}
            >
              Choose a key
            </LinkButton>
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}
