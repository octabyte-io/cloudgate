// No `"use client"`: its only importer, `agents-card.tsx`, is already inside
// the section's boundary.

import { useId, useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { AccessTree, useAccessTree } from "@/components/console/access-tree";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AGENT_KEY_EXPIRY_DAYS,
  DEFAULT_AGENT_KEY_EXPIRY_DAYS,
  type AgentKeyExpiryDays,
  type CreatedAgent,
} from "@/lib/api/endpoints/agents";
import type { AgentRole } from "@/lib/api/endpoints/roles";
import {
  entitlementsBody,
  noGrants,
  type AccessGrants,
} from "@/lib/auth/access-grants";

import { AgentKeyReveal } from "./agent-key-reveal";
import { AGENT_ROLE_CHOICES, AGENT_ROLE_COPY } from "./agent-roles";
import { LogMaskNotice } from "./log-mask-notice";
import { useCreateAgent } from "./use-agents";

/** The backend's own bounds on an Agent's name (`CreateAgentSchema`). */
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "An Agent needs a name.")
    .max(64, "A name is at most 64 characters."),
});
type Values = z.infer<typeof schema>;

/** A key's three lifetimes, as the create and Add key dialogs offer them. */
export const EXPIRY_OPTIONS = AGENT_KEY_EXPIRY_DAYS.map((days) => ({
  value: String(days),
  label: days === 365 ? "In a year" : `In ${days} days`,
}));

/**
 * Create an Agent, in one dialog: name, role, access, the first key's expiry
 * — then the key, once.
 *
 * **One request, not one per step.** `POST /agents` writes the user, the
 * member row and the first key in one transaction, so the steps are sections
 * of a single form rather than a wizard that could leave an Agent half-made.
 * Creating one always mints its first key; there is no "create now, key
 * later", because an Agent with no key can do nothing and has no obvious next
 * step.
 *
 * **Reader is the default and access starts empty.** Both are the least an
 * Agent can be handed, and saving with nothing ticked is allowed — the row
 * then reads "Reaches nothing yet". The access tree is Manage access's own
 * (`components/console/access-tree.tsx`), reading only what the signed-in person can see.
 *
 * **The reveal takes the dialog over**, as the personal key's does:
 * `keepOpen` stops a backdrop click, which is not a decision, from costing the
 * key. There is no Never among the expiries, by decision.
 *
 * **The name is the one registered field** (§3.6): a 400 naming `name` lands
 * under the Name box. Role, access and expiry are controls without a text
 * value, held in state and folded into the body at submit; a refusal naming
 * one of them has no field here and goes to the root error, as `useApiForm`
 * routes any issue it cannot place.
 *
 * **`preset` opens it already chosen**: an AI model's "Create a caller Agent"
 * hands in `agentCaller` and a grant on that AI model. It is where the
 * dialog starts, not a lock; the role and the tree stay editable.
 */
export function CreateAgentModal({
  open,
  onOpenChange,
  connect,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The client-configuration panel, handed the created Agent and its key. */
  connect?: (created: CreatedAgent) => React.ReactNode;
  /** The role and grant it opens holding, in place of Reader and nothing. */
  preset?: { role: AgentRole; grants: AccessGrants };
}) {
  const create = useCreateAgent();
  const [role, setRole] = useState<AgentRole>(preset?.role ?? "agentReader");
  const [grants, setGrants] = useState(() => preset?.grants ?? noGrants());
  const [expiry, setExpiry] = useState<AgentKeyExpiryDays>(
    DEFAULT_AGENT_KEY_EXPIRY_DAYS,
  );
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const tree = useAccessTree(grants);
  const accessHeading = useId();

  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "" },
    onSubmit: async (values) => {
      setCreated(
        await create.mutateAsync({
          name: values.name.trim(),
          role,
          grant: entitlementsBody(grants, tree.inventory),
          keyExpiresInDays: expiry,
        }),
      );
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      keepOpen={created !== null}
      wide
    >
      <Modal.Header
        title={created ? `${created.agent.name}’s first key` : "Create an Agent"}
        description={
          created
            ? "This is the only time it is readable."
            : "A Member that is not a person: it acts through the MCP endpoint with its own key, inside the role and access you give it."
        }
      />

      {created ? (
        <>
          <Modal.Body>
            <AgentKeyReveal
              agentName={created.agent.name}
              role={created.agent.role}
              value={created.key}
              connect={connect?.(created)}
            />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Button
              type="button"
              variant="pri"
              onClick={() => onOpenChange(false)}
            >
              I have copied it
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <FormProvider {...form}>
          <form method="post" noValidate onSubmit={form.submit}>
            <Modal.Body>
              <Field
                name="name"
                label="Name"
                hint="What it is for — “deploy-bot”, “staging reader”. It is how the audit log names it."
              >
                <Input maxLength={64} autoComplete="off" />
              </Field>

              {/* Not a `Field`: a label names one control, and this is a group
                  of choices, which `PickGrid` names itself. */}
              <div className="grid gap-1.5">
                <p aria-hidden="true" className="text-body font-medium text-tx">
                  Role
                </p>
                <PickGrid label="Role">
                  {AGENT_ROLE_CHOICES.map((choice) => (
                    <PickCard
                      key={choice}
                      title={AGENT_ROLE_COPY[choice].label}
                      description={AGENT_ROLE_COPY[choice].choice}
                      selected={role === choice}
                      onClick={() => setRole(choice)}
                    />
                  ))}
                </PickGrid>
              </div>

              <section aria-labelledby={accessHeading} className="grid gap-3">
                <div>
                  <h3
                    id={accessHeading}
                    className="text-body font-medium text-tx"
                  >
                    Access
                  </h3>
                  <p className="mt-0.5 text-meta text-tx-2">
                    Starts empty. An Agent reaches a Service through its Project
                    and its Environment, so granting one grants the two above it.
                    You can save it with nothing granted and grant it later.
                  </p>
                </div>
                <LogMaskNotice />
                <AccessTree
                  tree={tree}
                  grants={grants}
                  onChange={setGrants}
                  subject="this Agent"
                />
              </section>

              <Field
                name="expiry"
                label="First key expires"
                hint="Every Agent key expires. Add a new key before this one lapses."
                manual
              >
                <Picker
                  value={String(expiry)}
                  onValueChange={(value) =>
                    setExpiry(Number(value) as AgentKeyExpiryDays)
                  }
                  options={EXPIRY_OPTIONS}
                />
              </Field>

              <FormError message={form.rootError} />
            </Modal.Body>
            <Modal.Footer>
              <Modal.Gap />
              <Modal.Close render={<Button type="button">Cancel</Button>} />
              <SubmitButton pending={form.formState.isSubmitting}>
                Create Agent
              </SubmitButton>
            </Modal.Footer>
          </form>
        </FormProvider>
      )}
    </Modal>
  );
}
