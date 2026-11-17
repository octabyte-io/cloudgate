import { environmentsApi } from "@/lib/api/endpoints/environments";
import {
  templatesApi,
  type TemplateSetupResult,
} from "@/lib/api/endpoints/templates";

/**
 * Where the wizard's setup goes, as step 2's "More options" chose it.
 *
 * - A new Project (the default), made with a `production` Environment on
 *   the Server, as Template setup's "New Project from a template" makes it.
 * - An existing Project's Environment already on the Server.
 * - An existing Project with none there: a new Environment on the Server,
 *   so the setup never lands in an Environment on another Deploy target.
 */
export type WizardPlace =
  | { newProject: { name: string } }
  | { projectId: string; environmentId: string }
  | { projectId: string; newEnvironment: string };

/**
 * Sets the template up on the chosen Server with what step 2 chose: the
 * place, the setup name, the asked values and each compose Domain's host.
 * With `autoApply`: Cloudgate applies the plan itself once the Server is
 * Ready (ADR-0073), so nobody presses Apply.
 *
 * A new Project or an existing Environment is one request, which the setup
 * checks whole before it makes anything. A new Environment in an existing
 * Project is made first, and deleted again when the setup refuses, so a
 * refused deploy leaves nothing behind either way.
 */
export async function deployTemplate({
  templateId,
  serverId,
  place,
  setupName,
  values,
  hosts,
}: {
  templateId: string;
  serverId: string;
  place: WizardPlace;
  setupName: string;
  /** Asked values by input name; an empty one is left out, so its default holds. */
  values: Record<string, string>;
  /** Each compose Domain's host, by its name; absent with no Domain. */
  hosts?: Record<string, string>;
}): Promise<TemplateSetupResult> {
  const deployTarget = { kind: "server" as const, serverId };
  const chosen = {
    setupName,
    values,
    ...(hosts ? { hosts } : {}),
    autoApply: true,
  };

  if ("newProject" in place) {
    return templatesApi.setUp({
      templateId,
      newProject: { name: place.newProject.name, deployTarget },
      ...chosen,
    });
  }
  if ("environmentId" in place) {
    return templatesApi.setUp({
      templateId,
      projectId: place.projectId,
      environmentId: place.environmentId,
      ...chosen,
    });
  }

  const environment = await environmentsApi.create({
    projectId: place.projectId,
    name: place.newEnvironment,
    deployTarget,
  });
  try {
    return await templatesApi.setUp({
      templateId,
      projectId: place.projectId,
      environmentId: environment.environmentId,
      ...chosen,
    });
  } catch (error) {
    // Nothing ran in it yet; a failed clean-up leaves an empty Environment,
    // which is not worth hiding the refusal for.
    await environmentsApi
      .remove(environment.environmentId)
      .catch(() => undefined);
    throw error;
  }
}
