/**
 * Where a setup was started from: an Environment's "Set up a template"
 * opens the catalogue as `/templates?project=<id>&environment=<id>`, and the
 * catalogue and the setup screen carry the two along, so the form starts on
 * that Project and Environment. Either may be absent.
 */
export interface SetupPlace {
  projectId: string | null;
  environmentId: string | null;
}

/** The place a `/templates` address carries, read from its search params. */
export function setupPlaceOf(params: {
  get(name: string): string | null;
}): SetupPlace {
  return {
    projectId: params.get("project"),
    environmentId: params.get("environment"),
  };
}

/** `/templates`, or one Template's setup, keeping the place it came from. */
export function templatesHref(place: SetupPlace, templateId?: string): string {
  const query = new URLSearchParams();
  if (templateId !== undefined) query.set("template", templateId);
  if (place.projectId) query.set("project", place.projectId);
  if (place.environmentId) query.set("environment", place.environmentId);
  const search = query.toString();
  return search ? `/templates?${search}` : "/templates";
}
