import { LinkButton } from "@/components/console/link-button";
import { tabHref } from "@/components/shell/scope";
import { useOptionalScope } from "@/components/shell/scope-provider";
import { Icon } from "@/lib/design/icons";

/** The Shell tab's slug, in every service scope's table. */
export const SHELL_TAB = "shell";

/**
 * **Open a shell**, on a Service's Overview: one click to its Shell
 * tab.
 *
 * Shown exactly where the tab is, by reading the rail rather than restating
 * the rule: the rail is the tab table's `absentBecause` applied to this row
 * and this caller (`resolve-scope.ts`), so a Service in a Cloud account and a
 * role without `service:update` lose the button for the same reason they lose
 * the tab. Nothing outside a scope, and nothing while the row loads.
 */
export function OpenShellButton() {
  const context = useOptionalScope();
  if (!context || context.pending) return null;
  const offered = context.nav.some(
    (row) => row.kind === "item" && row.tab === SHELL_TAB,
  );
  if (!offered) return null;

  return (
    <LinkButton href={tabHref(context.scope, SHELL_TAB)}>
      <Icon name="term" size={14} />
      Open a shell
    </LinkButton>
  );
}
