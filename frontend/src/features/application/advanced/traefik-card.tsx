import { Card } from "@/components/console/card";
import { CodeWell } from "@/components/console/code-well";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";

import { useApplicationTraefikConfig } from "./use-advanced";

/**
 * The Traefik config this Application is served by — **read, not edited**, and
 * that is the finding rather than a shortcut.
 *
 * F10's brief asked for "an editor with the same well treatment as logs". This
 * screen cannot honestly offer one, and the endpoint audit is what found it:
 *
 * - **Which route reaches the file.** The generic pair on the settings
 *   controller — `GET|POST /settings/traefik/file?path=` — not
 *   `traefik/web-server-config` (Cloudgate's own router) and not
 *   `traefik/middlewares-config` (a shared file our backend does not use for an
 *   Application at all). So a write *is* available.
 * - **Why using it would be a trap.** `traefik/app-config.service.ts` says it in
 *   its own comment: it regenerates the whole file from scratch on every change,
 *   and the writer drops it when the last domain is gone. So a hand edit survives until the
 *   next time a domain, redirect or basic-auth rule changes, and then vanishes
 *   with no message. A Save button that silently discards its own work is worse
 *   than no Save button.
 *
 * What the screen does instead is name the three things that *do* write this
 * file, so someone who wants a different router knows where to go. The absence
 * of a config is meaningful too, and says so: the writer removes the file when
 * an Application has no domains, so "nothing here" means "nothing is routing to
 * this yet", not "something failed".
 */
export function TraefikCard({
  application,
}: {
  application: ApplicationDetail;
}) {
  const config = useApplicationTraefikConfig(
    application.appName,
    application.serverId,
  );

  return (
    <Card>
      <Card.Header
        title="Traefik configuration"
        sub="The routing this Application is served by, as Traefik reads it."
        headingLevel={2}
        actions={
          <Button size="sm" onClick={config.refetch}>
            <Icon name="refresh" size={14} />
            Reload
          </Button>
        }
      />

      <MetaStrip>
        This file is <strong>generated</strong>. It is rewritten from this
        Application&rsquo;s domains, redirects and basic-auth rules every time one
        of them changes, and removed when the last domain goes — so it is read
        here, and changed on those screens.
      </MetaStrip>

      <Card.Body>
        {config.error ? (
          <p className="text-body text-tx-2">{errorMessage(config.error)}</p>
        ) : config.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-32" />
          </div>
        ) : config.content ? (
          <>
            <CodeWell
              content={config.content}
              label={`Traefik configuration for ${application.name}`}
            />
            <p className="mt-2.5 font-mono text-meta wrap-anywhere text-tx-3">
              {config.path}
            </p>
          </>
        ) : (
          <EmptyState icon="net" title="Nothing routes here yet">
            Traefik&rsquo;s file provider has no configuration for this
            Application, because it has no domain. Add one on the Domains tab and
            deploy, and the router appears here.
          </EmptyState>
        )}
      </Card.Body>
    </Card>
  );
}
