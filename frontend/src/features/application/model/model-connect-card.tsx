import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CodeWell } from "@/components/console/code-well";
import { CopyButton } from "@/components/console/copy-button";
import { Button } from "@/components/ui/button";
import type { Agent, CreatedAgent } from "@/lib/api/endpoints/agents";
import type {
  AiModel,
  ApplicationDetail,
} from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";

import { CreateAgentModal } from "../../agents/create-agent-modal";
import { useAgents } from "../../agents/use-agents";
import {
  CALLER_ROLE,
  callerGrant,
  callersOf,
  modelClientSnippet,
} from "./model-client";

/**
 * Wiring a client to an AI model: its
 * endpoint and an OpenAI SDK snippet, "Create a caller Agent", and the Agents
 * that can call it.
 *
 * **The endpoint is the backend's** (`aiModel.endpoint`), built from the
 * platform host URL by the same helper `get_service` and the gateway's route
 * use, so the console never spells it differently. It is `null` until the
 * instance has a console domain or a server IP, and the card says so.
 *
 * **"Create a caller Agent"** is shown only with `member: ['create']` — what
 * `POST /agents` asks — and opens the Agents page's own create dialog holding
 * the Caller role and a grant on this AI model (with its Environment and
 * Project, which a Service grant needs). The key shows once, in that dialog,
 * with this AI model's snippet under it.
 *
 * **The callers list** is shown to whoever holds `member: ['read']`, the
 * statement for reading the Organization's members: owners and admins, not
 * the base member. Its rows are `GET /agents` filtered here (`callersOf`).
 */
export function ModelConnectCard({
  application,
  facet,
}: {
  application: ApplicationDetail;
  facet: AiModel;
}) {
  const canCreate = usePermission({ member: ["create"] });
  const canReadMembers = usePermission({ member: ["read"] });
  const [creating, setCreating] = useState(false);
  const endpoint = facet.endpoint;
  const snippet = endpoint ? modelClientSnippet(endpoint, facet.model) : null;

  const createButton = canCreate.allowed ? (
    <Button
      size="sm"
      disabled={!canCreate.allowed}
      onClick={() => canCreate.allowed && setCreating(true)}
    >
      Create a caller Agent
    </Button>
  ) : null;

  return (
    <Card>
      <Card.Header
        title="Connect a client"
        sub="Any OpenAI-compatible client calls this AI model with an Agent key."
        actions={createButton}
      />
      <Card.Body className="grid gap-3">
        {endpoint && snippet ? (
          <>
            <div className="grid gap-1.5">
              <p className="text-body font-medium text-tx">Endpoint</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 font-mono text-ui wrap-anywhere text-tx">
                  {endpoint}
                </code>
                <CopyButton value={endpoint} label="endpoint" />
              </div>
              <p className="text-meta text-tx-2">
                The client’s base URL. The key goes in an{" "}
                <code className="font-mono text-tx">Authorization: Bearer</code>{" "}
                header, and it must be a Caller Agent’s granted this AI model.
              </p>
            </div>
            <ModelSnippet snippet={snippet} />
          </>
        ) : (
          <p className="text-body text-tx-2">
            No endpoint yet: this instance has no console domain or server IP,
            so there is no address a client could call. Set one in{" "}
            <Link
              href="/settings/instance"
              className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
            >
              Instance settings
            </Link>
            .
          </p>
        )}
        {canReadMembers.allowed ? (
          <ModelCallers applicationId={application.applicationId} />
        ) : null}
      </Card.Body>

      {creating ? (
        <CreateAgentModal
          key="create-caller"
          open
          onOpenChange={setCreating}
          preset={{
            role: CALLER_ROLE,
            grants: callerGrant({
              applicationId: application.applicationId,
              environmentId: application.environmentId,
              projectId: application.environment.project.projectId,
            }),
          }}
          connect={(created: CreatedAgent) =>
            snippet &&
            callersOf([created.agent], application.applicationId).length > 0 ? (
              <ModelSnippet snippet={snippet} />
            ) : null
          }
        />
      ) : null}
    </Card>
  );
}

/** The snippet, which never holds a key, and its copy button. */
function ModelSnippet({ snippet }: { snippet: string }) {
  return (
    <section aria-label="OpenAI SDK" className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-tx-2">
          With the OpenAI SDK for JavaScript. Replace{" "}
          <code className="font-mono text-tx">&lt;agent key&gt;</code> with the
          key, or read it from your environment.
        </p>
        <CopyButton value={snippet} label="OpenAI SDK snippet" />
      </div>
      <CodeWell content={snippet} label="OpenAI SDK snippet" />
    </section>
  );
}

/** The Agents that can call this AI model, under `member: ['read']`. */
function ModelCallers({ applicationId }: { applicationId: string }) {
  const agents = useAgents();
  const callers: Agent[] = callersOf(agents.data ?? [], applicationId);

  return (
    <section
      aria-label="Agents that can call this AI model"
      className="grid gap-1.5"
    >
      <p className="text-body font-medium text-tx">Agents that can call it</p>
      {agents.isPending ? (
        <p className="text-meta text-tx-3">Reading the Agents…</p>
      ) : agents.error ? (
        <p className="text-meta text-bad">The Agents could not be read.</p>
      ) : callers.length === 0 ? (
        <p className="text-meta text-tx-2">
          None yet. A Caller Agent granted this AI model can call it.
        </p>
      ) : (
        <ul className="grid gap-1">
          {callers.map((agent) => (
            <li
              key={agent.id}
              className="flex items-center gap-2 text-body text-tx"
            >
              {agent.name}
              {agent.suspended ? <Chip>Suspended</Chip> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-meta text-tx-3">
        Manage them, their keys and their access in{" "}
        <Link
          href="/settings/agents"
          className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
        >
          Agents
        </Link>
        .
      </p>
    </section>
  );
}
