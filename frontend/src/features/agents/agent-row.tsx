import Link from "next/link";

import { Chip } from "@/components/console/chip";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/api/endpoints/agents";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { TONE_TEXT } from "@/lib/design/status";
import { personName } from "@/lib/format/person";
import { counted } from "@/lib/format/plural";
import { timeAgo, timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

import { AgentAccess } from "./agent-access";
import {
  agentAuditHref,
  agentStatus,
  connectionLabel,
  keyFacts,
  lastUsed,
} from "./agent-facts";
import { AgentKeyList } from "./agent-key-list";
import type { AgentLifecycle } from "./agent-lifecycle";
import {
  agentRowAnchor,
  RateLimitedLine,
  useScrollToAnchor,
} from "./agent-rate-limited";
import { AGENT_ROLE_COPY } from "./agent-roles";

/**
 * One Agent at rest: who it is, the one status that
 * says what it can do right now, what it may reach, what its keys look like,
 * who made it, and where its trail is.
 *
 * **Never its address.** The listing does not carry it, and nothing here asks
 * for it — an Agent is named by its name, as the audit log names it.
 *
 * The row is laid out as four parts so each can grow on its own: the header
 * (name, role, status, and the row's actions), the access line, the facts
 * (`AgentKeys` is the keys cell), and the trail link. Actions are handed in
 * by the card, which holds the dialogs — a dialog mounted inside a row
 * unmounts when the list re-renders under it.
 */
export function AgentRow({
  agent,
  onConnect,
  onDelete,
  lifecycle,
}: {
  agent: Agent;
  /** Client configuration again, for a second machine. Any member. */
  onConnect: () => void;
  onDelete: () => void;
  /** Suspend/Resume, Change role, Manage access and the keys. */
  lifecycle: AgentLifecycle;
}) {
  // `DELETE /agents/:id` declares `member: ['delete']`; the audit route
  // `auditLog: ['read']`, which a plain member lacks — so they are told the
  // trail exists rather than sent to a refusal. Suspend/Resume, the key routes
  // and the two member routes behind Change role and Manage access all take
  // `member: ['update']`.
  const canDelete = usePermission({ member: ["delete"] });
  const canUpdate = usePermission({ member: ["update"] });
  const canReadTrail = usePermission({ auditLog: ["read"] });
  const status = agentStatus(agent);
  const role = AGENT_ROLE_COPY[agent.role];
  const anchor = agentRowAnchor(agent.id);
  const rowRef = useScrollToAnchor<HTMLLIElement>(anchor);

  return (
    <li
      id={anchor}
      ref={rowRef}
      className="grid gap-2.5 border-b border-line px-4 py-3.5 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-body font-medium wrap-anywhere text-tx">
          {agent.name}
        </span>
        <Chip variant="brand">{role.label}</Chip>
        <StatusPill mark={status.mark} />
        <span className="ml-auto flex flex-wrap justify-end gap-1.5">
          <Button type="button" size="xs" onClick={onConnect}>
            Connect
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={!canUpdate.allowed || lifecycle.resuming}
            title={
              canUpdate.allowed
                ? undefined
                : agent.suspended
                  ? RESUME_REFUSAL
                  : SUSPEND_REFUSAL
            }
            aria-busy={lifecycle.resuming || undefined}
            onClick={() =>
              canUpdate.allowed &&
              (agent.suspended ? lifecycle.resume() : lifecycle.suspend())
            }
          >
            {agent.suspended ? "Resume" : "Suspend"}
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={!canUpdate.allowed}
            title={canUpdate.allowed ? undefined : CHANGE_ROLE_REFUSAL}
            onClick={() => canUpdate.allowed && lifecycle.changeRole()}
          >
            Change role
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={!canUpdate.allowed}
            title={canUpdate.allowed ? undefined : MANAGE_ACCESS_REFUSAL}
            onClick={() => canUpdate.allowed && lifecycle.manageAccess()}
          >
            Manage access
          </Button>
          <Button
            type="button"
            size="xs"
            variant="dngr"
            disabled={!canDelete.allowed}
            title={canDelete.allowed ? undefined : DELETE_REFUSAL}
            onClick={() => canDelete.allowed && onDelete()}
          >
            Delete
          </Button>
        </span>
      </div>

      <p className="text-meta text-tx-2">{role.allows}</p>

      <AgentAccess agent={agent} />

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
        <dt className="text-tx-3">Keys</dt>
        <dd className="grid gap-1.5">
          <AgentKeys agent={agent} />
          <AgentKeyList
            agent={agent}
            onAdd={lifecycle.addKey}
            onRemove={lifecycle.removeKey}
          />
        </dd>
        <dt className="text-tx-3">Last used</dt>
        <dd className="text-tx-2">
          <LastUsed at={lastUsed(agent)} />
        </dd>
        <dt className="text-tx-3">Last connected</dt>
        <dd className="text-tx-2">
          <LastConnected agent={agent} />
        </dd>
        <dt className="text-tx-3">Created</dt>
        <dd className="text-tx-2">
          <Created agent={agent} />
        </dd>
      </dl>

      <RateLimitedLine agent={agent} canReadTrail={canReadTrail.allowed} />

      <p className="text-meta">
        {canReadTrail.allowed ? (
          <Link
            href={agentAuditHref(agent.id)}
            className="text-brand-tx underline-offset-2 hover:underline"
          >
            Every call it made, in the audit log
          </Link>
        ) : (
          <span className="text-tx-3">
            Its calls are in the audit log, which your role cannot read.
          </span>
        )}
      </p>
    </li>
  );
}

const DELETE_REFUSAL = roleRefusal("delete an Agent");
const SUSPEND_REFUSAL = roleRefusal("suspend an Agent");
const RESUME_REFUSAL = roleRefusal("resume an Agent");
const CHANGE_ROLE_REFUSAL = roleRefusal("change an Agent’s role");
const MANAGE_ACCESS_REFUSAL = roleRefusal("change what an Agent can reach");

/** "2 keys · next expires in 9 days", amber inside 14 days. */
export function AgentKeys({ agent }: { agent: Agent }) {
  const facts = keyFacts(agent);
  const keys = counted(facts.count, "key", "keys");

  if (facts.nextExpiry === null) {
    return (
      <span className={TONE_TEXT.bad}>
        {facts.count === 0
          ? "No keys"
          : `${keys}, ${facts.count === 1 ? "expired" : "all expired"}`}
      </span>
    );
  }

  return (
    <span className="text-tx-2">
      {keys} · next expires{" "}
      <time
        dateTime={facts.nextExpiry}
        title={timeExact(facts.nextExpiry)}
        className={cn(facts.soon && cn(TONE_TEXT.warn, "font-medium"))}
      >
        {timeAgo(facts.nextExpiry)}
      </time>
    </span>
  );
}

function LastUsed({ at }: { at: string | null }) {
  // One wording for an unused key, Agent or personal.
  if (at === null) return <>Never used</>;
  return (
    <time dateTime={at} title={timeExact(at)}>
      {timeAgo(at)}
    </time>
  );
}

/**
 * What its client last said about itself, and when — labelled self-reported,
 * because the endpoint records the client's own claim and nothing checks it.
 */
function LastConnected({ agent }: { agent: Agent }) {
  const connection = agent.lastConnection;
  if (connection === null) return <>No client has connected yet</>;
  const label = connectionLabel(connection);
  return (
    <>
      {label ?? "A client that did not name itself"},{" "}
      <time dateTime={connection.at} title={timeExact(connection.at)}>
        {timeAgo(connection.at)}
      </time>{" "}
      <span className="text-tx-3">(self-reported)</span>
    </>
  );
}

/**
 * When, and by whom — from the Agent's own `create` audit row, so the name is
 * the one recorded then, still right after that person has left.
 */
function Created({ agent }: { agent: Agent }) {
  const when = (
    <time dateTime={agent.createdAt} title={timeExact(agent.createdAt)}>
      {timeAgo(agent.createdAt)}
    </time>
  );
  if (agent.createdBy === null) {
    return <>{when}, by someone the audit log does not record</>;
  }
  return (
    <>
      {when} by {personName(agent.createdBy)}
    </>
  );
}
