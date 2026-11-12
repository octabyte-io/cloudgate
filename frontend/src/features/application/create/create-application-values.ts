import { z } from "zod";

import type { CreateApplicationInput } from "@/lib/api/endpoints/applications";
import { serviceNameField } from "@/lib/forms/service-name";

/**
 * What the create form holds, and how it becomes `POST /applications`.
 *
 * Kept apart from the modal because it is the half with no React in it: the
 * schema the form validates against and the fold from what was typed into the
 * body the route accepts. `createApplicationSchema` on the backend
 * (`applications/dto/application.dto.ts`) takes exactly five keys — `name`,
 * `appName`, `description`, `environmentId` and `serverId` — of which two are
 * required, so this fold is short and every rule in it is a decision about a
 * blank field rather than about a shape.
 */
export const createApplicationSchema = z.object({
  name: serviceNameField("An Application needs a name."),
  description: z.string(),
});

export type CreateApplicationValues = z.infer<typeof createApplicationSchema>;

/** A form that has been opened and not typed into. */
export const BLANK_APPLICATION: CreateApplicationValues = {
  name: "",
  description: "",
};

/**
 * The form's values as the route wants them.
 *
 * **Blank optional keys are omitted rather than sent empty**, which is the one
 * thing worth stating: `description` is `z.string().optional()` on the backend,
 * so sending `""` stores an empty description — a value that reads on the
 * Application's own screen as *somebody wrote nothing here* rather than as *this
 * has no description*.
 *
 * **`serverId` is the exception: the platform host is sent as `null`, never
 * left out**.
 * A body with no `serverId` lands on the Environment's Deploy target's Server,
 * so leaving it out would put the Application somewhere other than where the
 * picker said. `serverId` arrives already read off the picker
 * (`useCreateServerPicker().serverIdOf`): it is `undefined`, and left out,
 * only for nothing chosen in a cloud Environment, which the API answers by
 * asking for a Server.
 *
 * `appName` is not offered at all. The backend generates one, it names the
 * container, its volumes and its Traefik router, and it is immutable once
 * created — so it is the one field on this route that a person choosing badly
 * cannot take back.
 */
export function toCreateApplicationInput(
  values: CreateApplicationValues,
  environmentId: string,
  serverId: string | null | undefined,
): CreateApplicationInput {
  const description = values.description.trim();
  return {
    name: values.name.trim(),
    ...(description === "" ? {} : { description }),
    environmentId,
    ...(serverId === undefined ? {} : { serverId }),
  };
}
