import type { Agent } from "@/lib/api/endpoints/agents";
import type { AgentRole } from "@/lib/api/endpoints/roles";
import type { AccessGrants } from "@/lib/auth/access-grants";

import { AGENT_KEY_PLACEHOLDER } from "../../agents/connect-snippets";

/**
 * Wiring a client to an AI model from its Model tab: the snippet, who can call
 * it, and the Agent "Create a caller Agent" makes. Pure, so the spec needs no
 * DOM.
 */

/** The only agent role holding `service: ['call']`, which the gateway checks. */
export const CALLER_ROLE: AgentRole = "agentCaller";

/**
 * An OpenAI SDK client pointed at the AI model's endpoint.
 *
 * **It never holds a key**: `apiKey` is the literal `<agent key>`, which the
 * reader replaces. The SDK sends it as `Authorization: Bearer`, which is what
 * the gateway reads. `model` is the one this AI model serves, because the
 * gateway refuses a call naming any other.
 */
export function modelClientSnippet(endpoint: string, model: string): string {
  return [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({`,
    `  baseURL: ${JSON.stringify(endpoint)},`,
    `  apiKey: ${JSON.stringify(AGENT_KEY_PLACEHOLDER)},`,
    `});`,
    ``,
    `const reply = await client.chat.completions.create({`,
    `  model: ${JSON.stringify(model)},`,
    `  messages: [{ role: "user", content: "Hello" }],`,
    `});`,
    `console.log(reply.choices[0].message.content);`,
    ``,
  ].join("\n");
}

/**
 * The Agents that can call this AI model: on the caller role, and granted the
 * AI model itself. A grant on its Project or Environment alone reaches no
 * Service (`PermissionService.checkServiceAccess`), so it is not enough.
 * A suspended Agent is still listed — it holds the grant, and Resume gives it
 * back the calls; the row says it is suspended.
 */
export function callersOf(
  agents: readonly Agent[],
  applicationId: string,
): Agent[] {
  return agents.filter(
    (agent) =>
      agent.role === CALLER_ROLE &&
      agent.accessedServices.includes(applicationId),
  );
}

/**
 * The grant "Create a caller Agent" opens holding: this AI model, and the
 * Environment and Project above it, because a Service grant without them is
 * one the Agent cannot reach (`access-grants.ts`, "The cascade").
 */
export function callerGrant(target: {
  applicationId: string;
  environmentId: string;
  projectId: string;
}): AccessGrants {
  return {
    projects: [target.projectId],
    environments: [target.environmentId],
    services: [target.applicationId],
  };
}
