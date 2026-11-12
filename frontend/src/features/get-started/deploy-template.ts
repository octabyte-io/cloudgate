import { environmentsApi } from "@/lib/api/endpoints/environments";
import { projectsApi } from "@/lib/api/endpoints/projects";
import {
  templatesApi,
  type SetupForm,
  type TemplateSetupResult,
} from "@/lib/api/endpoints/templates";

/**
 * A refusal the wizard words itself, because no request made it: the
 * Server has no address a generated host can carry.
 */
export class DeployRefusal extends Error {}

/** The Environment a new Project from the wizard gets, as the setup names it. */
export const WIZARD_ENVIRONMENT = "production";

/**
 * Sets the template up in a new Project named after the app, on the chosen
 * Server, with `autoApply`: Cloudgate applies the plan itself once the
 * Server is Ready, so nobody presses Apply (the setup flow's own review is
 * for people who know what a plan is; this page's readers do not).
 *
 * **Two routes, by whether the template has compose Domains.**
 *
 * - None: one request, the setup's own "New Project from a template"
 *   (#1376), which checks everything before it makes anything.
 * - Some: each needs a host, and only an Environment generates one (its
 *   Server's sslip.io name, ADR-0064), which a Project that does not exist
 *   yet has none of. So the Project and its Environment are made first,
 *   the setup form is read again for the Environment's generated hosts, and
 *   the setup goes into it. A refusal on the way deletes the Project again,
 *   which is what the one-request route does on its own refusal, so either
 *   way a refused deploy leaves nothing behind.
 *
 * Rejected: working the sslip.io host out in the browser. It is the
 * backend's name (a hash and the Server's address, `domains.service.ts`),
 * and a copy here would drift from it.
 */
export async function deployTemplate({
  templateId,
  form,
  projectName,
  serverId,
  values,
}: {
  templateId: string;
  /** The new-Project setup form (`setupForm(templateId, null)`). */
  form: SetupForm;
  projectName: string;
  serverId: string;
  /** Asked values by input name; an empty one is left out, so its default holds. */
  values: Record<string, string>;
}): Promise<TemplateSetupResult> {
  const deployTarget = { kind: "server" as const, serverId };

  if (form.domains.length === 0) {
    return templatesApi.setUp({
      templateId,
      newProject: { name: projectName, deployTarget },
      setupName: form.setupName,
      values,
      autoApply: true,
    });
  }

  const project = await projectsApi.create({ name: projectName });
  try {
    const environment = await environmentsApi.create({
      projectId: project.projectId,
      name: WIZARD_ENVIRONMENT,
      deployTarget,
    });
    const setup = await templatesApi.setupForm(templateId, project.projectId);
    const place = setup.environments.find(
      (env) => env.environmentId === environment.environmentId,
    );
    if (!place?.canTake) {
      throw new DeployRefusal(
        place?.reason ?? "This server cannot take this app.",
      );
    }
    if (!place.hosts) {
      throw new DeployRefusal(
        "This server has no public address for the app's web address. Set the app up from the Templates page instead, where you can type your own domain.",
      );
    }
    return await templatesApi.setUp({
      templateId,
      projectId: project.projectId,
      environmentId: environment.environmentId,
      setupName: setup.setupName,
      values,
      hosts: place.hosts,
      autoApply: true,
    });
  } catch (error) {
    // Nothing ran in it yet; a failed clean-up leaves an empty Project,
    // which is not worth hiding the first refusal for.
    await projectsApi.remove(project.projectId).catch(() => undefined);
    throw error;
  }
}
