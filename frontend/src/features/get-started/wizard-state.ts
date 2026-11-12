import { GET_STARTED_PATH } from "@/lib/auth/routes";

/**
 * Where the get-started wizard is, read from and written to its address.
 *
 * **Everything is in the query string**, never in React state or storage:
 * the wizard leaves the console twice on the way (Stripe Checkout, and a
 * bank's 3D Secure page), and a reload or a shared link has to land on the
 * same step. So the address is the one record of the wizard, and each step
 * is a link to the next address rather than a `setState`.
 *
 * - `template`: the catalogue id of the app being deployed.
 * - `path`: how the person chose to get a Server, `buy` or `own`.
 * - `server`: the Server the app goes on, once there is one.
 * - `step`: `deploy` once a Ready Server is chosen; absent before.
 * - `env`: the Environment the setup was made in, once Deploy was pressed;
 *   the wizard then only shows how the deploy is going.
 * - `checkout`: added by the backend when Stripe sends the browser back
 *   (`success` or `cancelled`, `api-schemas`' `withCheckoutOutcome`).
 */

export type ServerPath = "buy" | "own";

export type WizardState = {
  templateId: string | null;
  path: ServerPath | null;
  serverId: string | null;
  /** The details step: a Ready Server is chosen, the app's values are asked. */
  deploying: boolean;
  environmentId: string | null;
  checkout: "success" | "cancelled" | null;
};

/** Reads the wizard out of its query string. Unknown values read as absent. */
export function readWizard(params: {
  get: (name: string) => string | null;
}): WizardState {
  const path = params.get("path");
  const checkout = params.get("checkout");
  const blank = (value: string | null) =>
    value === null || value.trim() === "" ? null : value;
  return {
    templateId: blank(params.get("template")),
    path: path === "buy" || path === "own" ? path : null,
    serverId: blank(params.get("server")),
    deploying: params.get("step") === "deploy",
    environmentId: blank(params.get("env")),
    checkout:
      checkout === "success" || checkout === "cancelled" ? checkout : null,
  };
}

/**
 * The wizard's address for a state. `checkout` is never written back: it
 * says how one return from Stripe went, and carrying it on would say so
 * again on every later step.
 */
export function wizardHref(
  state: Partial<Omit<WizardState, "checkout">>,
): string {
  const query = new URLSearchParams();
  if (state.templateId) query.set("template", state.templateId);
  if (state.path) query.set("path", state.path);
  if (state.serverId) query.set("server", state.serverId);
  if (state.deploying) query.set("step", "deploy");
  if (state.environmentId) query.set("env", state.environmentId);
  const search = query.toString();
  return search ? `${GET_STARTED_PATH}?${search}` : GET_STARTED_PATH;
}

/** Which of the three steps the wizard shows. */
export type WizardStep = "server" | "details" | "launch";

export function stepOf(state: WizardState): WizardStep {
  if (state.environmentId) return "launch";
  if (state.deploying && state.serverId) return "details";
  return "server";
}
