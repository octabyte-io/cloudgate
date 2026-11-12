import { Chip } from "@/components/console/chip";
import { Button } from "@/components/ui/button";
import type { Agent, AgentKey } from "@/lib/api/endpoints/agents";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { TONE_TEXT } from "@/lib/design/status";
import { timeAgo, timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

import { keyExpiry } from "./agent-facts";

/**
 * An Agent's keys, one line each, and Add key.
 *
 * Each line is the key's first characters, when it was made, when it was last
 * used and when it lapses — the columns of the personal-keys table, because it
 * is the same fact about the same kind of row. What differs is the action: a
 * live key has **Revoke**, and an expired one stays listed as **Expired** with
 * **Remove** — it can authenticate nothing, so taking it away is tidying, not
 * revoking. A key inside 14 days of its expiry is amber, as the row's next-
 * expiry line is.
 *
 * Recovery and rotation are both Add key, then Revoke on the old one; there
 * is no "regenerate", which would stop the old key before the client had the
 * new one.
 *
 * Every control here writes to `/agents/:id/keys`, which declares
 * `member: ['update']`, so each reads that statement and is off, with
 * `roleRefusal`'s sentence, for a role without it.
 */
export function AgentKeyList({
  agent,
  onAdd,
  onRemove,
}: {
  agent: Agent;
  onAdd: () => void;
  onRemove: (key: AgentKey) => void;
}) {
  const canWrite = usePermission({ member: ["update"] });

  return (
    <div className="grid gap-1.5">
      {agent.keys.length === 0 ? null : (
        <ul
          aria-label={`${agent.name}’s keys`}
          className="grid gap-1 rounded-lg border border-line px-3 py-2"
        >
          {agent.keys.map((key) => {
            const expired = keyExpiry(key) === "expired";
            return (
              <KeyLine key={key.id} agentKey={key}>
                <Button
                  type="button"
                  size="xs"
                  variant="dngr"
                  className="ml-auto"
                  disabled={!canWrite.allowed}
                  title={
                    canWrite.allowed
                      ? undefined
                      : expired
                        ? REMOVE_KEY_REFUSAL
                        : REVOKE_KEY_REFUSAL
                  }
                  onClick={() => canWrite.allowed && onRemove(key)}
                >
                  {expired ? "Remove" : "Revoke"}
                </Button>
              </KeyLine>
            );
          })}
        </ul>
      )}
      <div>
        <Button
          type="button"
          size="xs"
          disabled={!canWrite.allowed}
          title={canWrite.allowed ? undefined : ADD_KEY_REFUSAL}
          onClick={() => canWrite.allowed && onAdd()}
        >
          Add key
        </Button>
      </div>
    </div>
  );
}

function KeyLine({
  agentKey,
  children,
}: {
  agentKey: AgentKey;
  /** The line's action — Revoke, or Remove once it has expired. */
  children: React.ReactNode;
}) {
  const expiry = keyExpiry(agentKey);
  const expired = expiry === "expired";

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-tx-2">
      {agentKey.start ? (
        <Chip variant="mono">{agentKey.start}…</Chip>
      ) : (
        <span className="text-tx-3">Unknown start</span>
      )}
      <span>
        Created <When iso={agentKey.createdAt} />
      </span>
      <span>
        {agentKey.lastUsedAt === null ? (
          "Never used"
        ) : (
          <>
            Last used <When iso={agentKey.lastUsedAt} />
          </>
        )}
      </span>
      {agentKey.expiresAt === null ? null : (
        <span
          data-expiry={expiry}
          className={cn(
            expiry === "soon" && cn(TONE_TEXT.warn, "font-medium"),
            expired && cn(TONE_TEXT.bad, "font-medium"),
          )}
        >
          {expired ? "Expired" : "Expires"} <When iso={agentKey.expiresAt} />
        </span>
      )}
      {children}
    </li>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={timeExact(iso)}>
      {timeAgo(iso)}
    </time>
  );
}

const ADD_KEY_REFUSAL = roleRefusal("add a key to an Agent");
const REVOKE_KEY_REFUSAL = roleRefusal("revoke an Agent’s key");
const REMOVE_KEY_REFUSAL = roleRefusal("remove an Agent’s key");
