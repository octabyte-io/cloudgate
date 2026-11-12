/**
 * Where an Environment's plan is read: its card on the Project's Config tab.
 * Promoted out of `features/application` when Template setup, a second
 * feature, came to send people there too, and into `lib/format` because it
 * renders nothing.
 */
export function environmentPlanHref(
  projectId: string,
  environmentId: string,
): string {
  return `/projects/${projectId}/config#plan-${environmentId}`;
}
