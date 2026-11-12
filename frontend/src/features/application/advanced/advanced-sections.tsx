import { MetaStrip } from "@/components/console/meta-strip";

/**
 * **The Advanced tab's five sub-sections, and how each one saves**.
 *
 * The tab was one page about 8,750px tall at 1440 wide, with three ways of
 * saving on it and no way to tell which card used which: four cards with a
 * Save of their own, eleven Swarm cards sharing one Save at the very bottom,
 * and two lists that apply the moment a row is saved. An edit to a Swarm card
 * near the top was lost to a click on another tab, and the Delete card sat
 * under all of it.
 *
 * So the tab is split by **what an operator came to change**, one sub-section
 * shown at a time, and each opens on the sentence saying how its cards save
 * and when the change lands. The order is the old page's: what every
 * Application has first, the Docker Engine passthrough most should never
 * touch after it, and the one card that removes the Application last.
 *
 * Rejected: separate registry tabs (`/advanced/swarm` and the like). The
 * rail is a list of what an Application *is*; five more rows for one
 * screen's parts would push Rollbacks, Previews and the rest below the fold,
 * and a deep link already lands on the screen they belong to.
 */
export const ADVANCED_SECTIONS = [
  { id: "resources", label: "Resources" },
  { id: "runtime", label: "Runtime" },
  { id: "routing", label: "Routing" },
  { id: "swarm", label: "Docker Swarm" },
  { id: "danger", label: "Danger zone" },
] as const;

export type AdvancedSectionId = (typeof ADVANCED_SECTIONS)[number]["id"];

/** How a sub-section's cards save, said before anything on it is touched. */
export function SaveScope({
  section,
}: {
  section: Exclude<AdvancedSectionId, "danger">;
}) {
  return <MetaStrip>{SCOPE[section]}</MetaStrip>;
}

const SCOPE: Record<Exclude<AdvancedSectionId, "danger">, React.ReactNode> = {
  resources: (
    <>
      <strong>Each card saves on its own</strong>, with its own Save changes.
      None of it reaches the running container until the{" "}
      <strong>next Deployment</strong>.
    </>
  ),
  runtime: (
    <>
      The run command and the build server each save with their own Save
      changes, and a volume or mount saves as its row does. All of it is read
      when the Application is <strong>deployed</strong>, so a change takes
      effect on the next Deployment.
    </>
  ),
  routing: (
    <>
      Each row saves on its own. A published port waits for the{" "}
      <strong>next Deployment</strong>. Redirects and basic authentication do
      not: Traefik&rsquo;s configuration is rewritten as soon as one is saved,
      and it reloads <strong>within a second</strong>.
    </>
  ),
  swarm: (
    <>
      <strong>One form, one Save</strong>: every card below is saved together
      by <strong>Save Swarm settings</strong> at the bottom, and the console
      asks before you leave with edits not saved. They reach the service on the
      next Deployment.
    </>
  ),
};
