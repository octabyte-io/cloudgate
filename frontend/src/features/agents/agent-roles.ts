import {
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  type AgentRole,
} from "@/lib/api/endpoints/roles";

/**
 * The three agent roles in plain words.
 *
 * Written out rather than derived from the served vocabulary, as `role-hint.ts`
 * derives a person's role hint, because the grants are fixed and short: the
 * backend's `agentReader` holds `service`, `environment`, `deployment` and
 * `domain` read, and `agentOperator` adds `deployment` create and cancel —
 * which is what deploying, starting, stopping and cancelling check.
 * `agentCaller` holds `service` call alone, which only the AI model Gateway
 * checks, and its key gets no MCP tool. None is a custom role nor can become
 * one, so there is no drift to guard.
 *
 * `choice` is the one line under each option in the create dialog; `allows` is
 * the sentence on the row, which can afford to name what it cannot do.
 */
export const AGENT_ROLE_COPY: Record<
  AgentRole,
  { label: string; choice: string; allows: string }
> = {
  agentReader: {
    label: AGENT_ROLE_LABELS.agentReader,
    choice:
      "Reads what it is granted — Services, Environments, Deployments, Deployment logs and Domains — and changes nothing.",
    allows:
      "Can read its Services, Environments, Deployments, Deployment logs and Domains. Cannot deploy, start, stop or change anything.",
  },
  agentOperator: {
    label: AGENT_ROLE_LABELS.agentOperator,
    choice:
      "Everything a Reader can, and deploys, starts, stops and cancels Deployments of what it is granted.",
    allows:
      "Can read its Services, Environments, Deployments, Deployment logs and Domains, and deploy, start, stop and cancel them. Cannot change settings, variables or access.",
  },
  agentCaller: {
    label: AGENT_ROLE_LABELS.agentCaller,
    choice:
      "Calls the AI models it is granted through their endpoint, and nothing else.",
    allows:
      "Can call its AI models through their endpoint. Cannot read, deploy or change anything, and gets no tools over MCP.",
  },
};

/** Every agent role, Reader first — the create dialog's order and its default. */
export const AGENT_ROLE_CHOICES: readonly AgentRole[] = AGENT_ROLES;
