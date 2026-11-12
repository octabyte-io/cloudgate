import { z } from "zod";

import type { DeployTarget } from "@/lib/api/endpoints/environments";
import type { SetupForm } from "@/lib/api/endpoints/templates";

import { fromPickerValue } from "../environment/deploy-target";
import { askedValueProblem, SETUP_NAME } from "./asked-value";

/**
 * The setup form's values, as `useApiForm` holds them.
 *
 * The names are the request's, so a 400 whose issue names `setupName`,
 * `environmentId` or `newProject.name` lands beside the field that sent it.
 * The asked values and the Domain hosts are lists in the order the form
 * lists them, not records by name: an input or a compose service name may
 * hold a dot, which react-hook-form would read as a path.
 */
export type SetupValues = {
  environmentId: string;
  setupName: string;
  values: string[];
  hosts: string[];
  newProject: { name: string; target: string; region: string };
};

/** Where the setup goes: an Environment of the Project, or a new Project. */
export type SetupChoice = (
  | { environmentId: string }
  | { newProject: { name: string; deployTarget: DeployTarget } }
) & {
  setupName: string;
  values: Record<string, string>;
  /** Each compose Domain's host, by its name; absent with no Domain. */
  hosts?: Record<string, string>;
};

/** The label each field the backend may name is shown under. */
export const SETUP_LABELS: Readonly<Record<string, string>> = {
  setupName: "Setup name",
  environmentId: "Environment",
  newProject: "Project name",
};

/**
 * The checks the form makes before Submit: the setup name's, each asked
 * value's and each Domain host's as the setup will make them, and a place
 * to set up into. The setup checks all of it again, and its word is final.
 */
export function setupSchema(
  form: SetupForm,
  newProject: boolean,
): z.ZodType<SetupValues> {
  return z
    .object({
      environmentId: z.string(),
      setupName: z.string(),
      values: z.array(z.string()),
      hosts: z.array(z.string()),
      newProject: z.object({
        name: z.string(),
        target: z.string(),
        region: z.string(),
      }),
    })
    .superRefine((values, issues) => {
      const problem = (path: (string | number)[], message: string) =>
        issues.addIssue({ code: "custom", path, message });
      if (!SETUP_NAME.test(values.setupName)) {
        problem(
          ["setupName"],
          "Use lowercase letters, digits and hyphens, starting with a letter",
        );
      }
      if (newProject) {
        const { name, target, region } = values.newProject;
        if (!name.trim())
          problem(["newProject", "name"], "A Project needs a name.");
        if (!target) problem(["newProject", "target"], "Pick a Deploy target");
        else if (!fromPickerValue(target, region)) {
          problem(["newProject", "region"], "Choose the region");
        }
      } else if (!values.environmentId) {
        problem(["environmentId"], "Pick an Environment");
      }
      form.asked.forEach((input, at) => {
        const found = askedValueProblem(input, values.values[at] ?? "");
        if (found) problem(["values", at], found);
      });
      form.domains.forEach((_domain, at) => {
        if ((values.hosts[at] ?? "").trim() === "") {
          problem(["hosts", at], "Give this Domain a host");
        }
      });
    });
}

/** The values the form starts on. */
export function startingValues(
  form: SetupForm,
  newProject: { firstTarget: string } | null,
): SetupValues {
  const first = form.environments.find((env) => env.canTake);
  return {
    environmentId: newProject ? "" : (first?.environmentId ?? ""),
    setupName: form.setupName,
    values: form.asked.map((input) => input.default ?? ""),
    hosts: startingHosts(form, newProject ? null : first?.hosts),
    newProject: { name: "", target: newProject?.firstTarget ?? "", region: "" },
  };
}

/** Each compose Domain's starting host: the one generated, or empty. */
export function startingHosts(
  form: SetupForm,
  generated: Readonly<Record<string, string>> | null | undefined,
): string[] {
  return form.domains.map((domain) => generated?.[domain.name] ?? "");
}

/**
 * The setup the checked values ask for. An optional value left empty is not
 * sent, so the template's default holds.
 */
export function setupChoice(
  form: SetupForm,
  values: SetupValues,
  newProject: boolean,
): SetupChoice {
  const asked = Object.fromEntries(
    form.asked
      .map((input, at) => [input.name, values.values[at] ?? ""] as const)
      .filter(([, value]) => value !== ""),
  );
  const hosts =
    form.domains.length > 0
      ? {
          hosts: Object.fromEntries(
            form.domains.map((domain, at) => [
              domain.name,
              (values.hosts[at] ?? "").trim(),
            ]),
          ),
        }
      : {};
  const deployTarget = fromPickerValue(
    values.newProject.target,
    values.newProject.region,
  );
  const place =
    newProject && deployTarget
      ? {
          newProject: { name: values.newProject.name.trim(), deployTarget },
        }
      : { environmentId: values.environmentId };
  return { ...place, setupName: values.setupName, values: asked, ...hosts };
}
