import { useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Field } from "@/components/console/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Project } from "@/lib/api/endpoints/projects";

import { ProjectChoice } from "../templates/project-choice";
import type { SetupValues } from "../templates/setup-values";
import { NEW_PROJECT } from "../templates/use-templates";
import type { WizardPlace } from "./deploy-template";

/**
 * Step 2's "Where it goes": the Project (Template setup's `ProjectChoice`)
 * and the setup name, folded behind More options with their defaults said
 * in one line (spec #106). The line stays when
 * unfolded: with the Server it names, it is what Deploy makes, said before
 * it is pressed, standing in for the Plan review nobody here is asked to
 * do (ADR-0073).
 *
 * A refusal of the Project name or the setup name, the form's own check or
 * the setup's, unfolds it, so the message is never on a field out of view.
 */
export function DetailsPlace({
  projects,
  projectId,
  onProject,
  place,
  environmentName,
  serverName,
}: {
  projects: readonly Project[];
  /** {@link NEW_PROJECT} or an existing Project's id. */
  projectId: string;
  onProject: (next: string) => void;
  /** Where Deploy sets up; null while an existing Project's form is read. */
  place: WizardPlace | null;
  /** The name of the existing Environment it goes into, if it does. */
  environmentName: string | null;
  serverName: string;
}) {
  const [more, setMore] = useState(false);
  const { formState } = useFormContext<SetupValues>();
  const projectName = useWatch<SetupValues, "newProject.name">({
    name: "newProject.name",
  });
  const setupName = useWatch<SetupValues, "setupName">({ name: "setupName" });
  const refused =
    formState.errors.setupName !== undefined ||
    formState.errors.newProject !== undefined;
  const open = more || refused;
  const project = projects.find((one) => one.projectId === projectId)?.name;

  return (
    <section
      aria-labelledby="details-where"
      className="grid gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="grid min-w-0 gap-0.5">
          <h3 id="details-where" className="text-body font-medium text-tx">
            Where it goes
          </h3>
          <p className="text-ui wrap-anywhere text-tx-2">
            {where(
              place,
              projectId === NEW_PROJECT ? projectName : project,
              environmentName,
            )}
            , on {serverName}, set up as{" "}
            <span className="font-mono text-meta">{setupName}</span>.
          </p>
        </div>
        {refused ? null : (
          <Button
            variant="qt"
            size="sm"
            type="button"
            aria-expanded={open}
            onClick={() => setMore((now) => !now)}
          >
            {open ? "Fewer options" : "More options"}
          </Button>
        )}
      </div>
      {open ? (
        <div className="grid animate-rise gap-4">
          <ProjectChoice
            projects={projects}
            pending={false}
            value={projectId}
            onChange={onProject}
          />
          {projectId === NEW_PROJECT ? (
            <Field
              name="newProject.name"
              label="Project name"
              className="max-w-md"
            >
              <Input autoComplete="off" />
            </Field>
          ) : null}
          <Field
            name="setupName"
            label="Setup name"
            hint={`Each part is named ${setupName || "<setup name>"}-<part>.`}
            className="max-w-md"
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-meta md:text-meta"
            />
          </Field>
        </div>
      ) : null}
    </section>
  );
}

/** The place, in words: its Project and, in an existing one, its Environment. */
function where(
  place: WizardPlace | null,
  project: string | undefined,
  environmentName: string | null,
): string {
  if (place === null || "newProject" in place) {
    if (place === null) return `The ${project ?? ""} Project`;
    return `A new Project, ${project || "unnamed"}`;
  }
  if ("newEnvironment" in place) {
    return `A new ${place.newEnvironment} Environment in the ${project ?? ""} Project`;
  }
  return `The ${project ?? ""} Project’s ${environmentName ?? ""} Environment`;
}
