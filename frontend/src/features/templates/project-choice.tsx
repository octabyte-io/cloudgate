import { Field } from "@/components/console/field";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Picker } from "@/components/console/picker";
import { Skeleton } from "@/components/console/skeleton";
import type { Project } from "@/lib/api/endpoints/projects";

import { NEW_PROJECT } from "./use-templates";

/** Up to this many Projects are cards; past it, one picker. */
const CARDS_UP_TO = 5;

/**
 * Which Project a Template is set up in: the first question of the setup
 * form, and the only one until it is answered.
 *
 * **Cards, not a lone picker.** A single select on an otherwise empty page
 * read as a page that had not loaded, and it hid the one thing worth knowing
 * at a glance: what the choices are. So "New Project" and each Project are
 * cards in a grid, the way the form's other places (an Environment, a Deploy
 * target) are rows to pick from. A Project's description is its second line.
 *
 * **Past five Projects it is a picker again**, with New Project first: a grid
 * of thirty cards would push the form below the fold for a choice a picker
 * makes in one keystroke.
 *
 * Outside the setup form's `react-hook-form` state on purpose: the form is
 * read per Project, so the choice is what fetches it.
 */
export function ProjectChoice({
  projects,
  pending,
  value,
  onChange,
}: {
  projects: readonly Project[] | undefined;
  pending: boolean;
  value: string | null;
  onChange: (next: string) => void;
}) {
  if (pending) return <Skeleton className="h-21" />;
  const list = projects ?? [];

  if (list.length > CARDS_UP_TO) {
    return (
      <Field name="projectId" label="Project" manual className="max-w-md">
        <Picker
          value={value ?? ""}
          onValueChange={(next) => {
            if (next) onChange(next);
          }}
          placeholder="Choose a Project"
          options={[
            { value: NEW_PROJECT, label: "New Project" },
            ...list.map((project) => ({
              value: project.projectId,
              label: project.name,
            })),
          ]}
        />
      </Field>
    );
  }

  return (
    <div className="grid gap-2">
      <span aria-hidden="true" className="text-body font-medium">
        Project
      </span>
      <PickGrid label="Project">
        <PickCard
          icon="plus"
          title="New Project"
          description="Made with a production Environment"
          selected={value === NEW_PROJECT}
          onClick={() => onChange(NEW_PROJECT)}
        />
        {list.map((project) => (
          <PickCard
            key={project.projectId}
            icon="folder"
            title={project.name}
            description={project.description || "An existing Project"}
            descriptionLines={2}
            selected={value === project.projectId}
            onClick={() => onChange(project.projectId)}
          />
        ))}
      </PickGrid>
    </div>
  );
}
