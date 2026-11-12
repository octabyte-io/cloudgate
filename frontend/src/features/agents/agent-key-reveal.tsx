import { RevealedKey } from "@/components/console/revealed-key";
import type { AgentRole } from "@/lib/api/endpoints/roles";

/**
 * The one limit said at the reveal rather than left to the docs: a deploy tool
 * call coalesces onto a Deployment already queued for the Service, so an Agent
 * that asks twice gets the first one back, not a second.
 */
const QUEUED_DEPLOY_NOTICE =
  "Deploys to a Service already queued return the queued Deployment.";

/**
 * An Agent key, the one time it is readable.
 *
 * The same box as a personal key's, because it is the same fact — Cloudgate
 * keeps a hash and cannot show it again. What differs is what comes after it:
 * an Agent key is only useful pasted into a coding client, so `connect` is
 * where the client configuration goes (the Connect panel), under the key
 * rather than instead of it. Creation hands it in; so will Add key.
 *
 * The key is a prop, never state kept here or in the query cache — the dialog
 * that holds it is unmounted on close, so reopening the page cannot find it.
 *
 * **A Caller's key goes elsewhere**: it is sent to an AI model's
 * endpoint on the gateway and gets no MCP tool, so the MCP sentence and the
 * deploy notice would both be wrong of it.
 */
export function AgentKeyReveal({
  agentName,
  role,
  value,
  connect,
}: {
  agentName: string;
  /** The Agent's role; only `agentCaller` changes what is said. */
  role?: AgentRole;
  value: string;
  /** The client-configuration panel, when there is one to show. */
  connect?: React.ReactNode;
}) {
  const name = <strong className="font-medium text-tx">{agentName}</strong>;
  return (
    <div className="grid gap-4">
      <RevealedKey value={value} label="agent key" />
      {role === "agentCaller" ? (
        <p className="text-body text-tx-2">
          Give it to the client that will call AI models as {name}. It is sent
          to an AI model’s endpoint on this console, as a bearer token, and
          reaches no MCP tool.
        </p>
      ) : (
        <>
          <p className="text-body text-tx-2">
            Give it to the coding client that will act as {name}. It is sent
            only to this console’s MCP endpoint, as a bearer token, and it is
            refused everywhere else.
          </p>
          <p className="text-body text-tx-2">{QUEUED_DEPLOY_NOTICE}</p>
        </>
      )}
      {connect}
    </div>
  );
}
