"use client";

import { Card } from "@/components/console/card";
import { MetaStrip } from "@/components/console/meta-strip";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { ConvertedFileCard } from "../converted/converted-file-card";
import { convertedPlan } from "../converted/converted-plan";
import { PlanRow } from "../converted/plan-row";
import { useComposeDomains } from "../domains/use-compose-domains";

/**
 * What the platform changes in the file on its way past, and the file it ends up
 * applying.
 *
 * **The phase brief calls this "the tab that earns trust", and once
 * earning it meant not drawing a diff.** Cloudgate really does rewrite the file
 * before applying it (`writeDomainsToCompose`, called from
 * `getBuildComposeCommand`), and the one thing this tab refused to do was
 * generate that YAML in the browser: a second implementation of a 180-line
 * Traefik-label generator, diffed against the original and presented as what
 * the platform does, would be confidently wrong the first time the backend
 * changed an entrypoint name — on the screen whose entire value is being right.
 *
 * `GET /compose/:id/converted` is the platform's own answer, from the same
 * function the deploy calls, so the diff is the real one. Two cards, and they
 * answer different questions:
 *
 * 1. **What deploying will change**, derived from the domains and the isolation
 *    flag. Still worth its place: it explains the rewrite in words, and it names
 *    the three refusals the deploy makes *before* it writes anything — including
 *    the silent one, a service whose `labels` are a map, where the deploy succeeds
 *    and the domain never routes.
 * 2. **The file itself** (`converted/converted-file-card.tsx`), shown whole and as
 *    a diff against the stored file for a `raw` source — the one case where the
 *    console holds both sides.
 *
 * **A 400 here is the answer, not a failure.** An empty file and a domain naming
 * a service the file does not declare are both refusals the deploy would make, so
 * this route is the cheapest place to discover them — and the message is rendered
 * as the finding it is.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      aside={(row) => <ComposeFactsCard compose={row} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`What Cloudgate rewrites in ${row.name}'s compose file before applying it, and what it leaves alone.`}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const domains = useComposeDomains(compose.composeId);

  if (domains.isPending) {
    return (
      <Card>
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      </Card>
    );
  }

  if (domains.error) {
    return (
      <Card>
        <Card.Header title="What deploying will change" headingLevel={2} />
        <Card.Body>
          <p className="text-body text-tx-2">
            {errorMessage(domains.error)}{" "}
            The rewrite is driven by this stack&rsquo;s domains, so there is
            nothing to describe until that list can be read.
          </p>
        </Card.Body>
      </Card>
    );
  }

  const plan = convertedPlan(compose, domains.data ?? []);

  return (
    <>
      <Card>
        <Card.Header
          title="What deploying will change"
          sub="Derived from this stack's domains and its network setting — the same two inputs the deploy uses."
          headingLevel={2}
        />
        {/* There is no "nothing changes" branch here any more, and its absence
            is the fix rather than a simplification: an isolated
            stack with no domains used to be handed to the deploy target byte for
            byte, and this card said so. It now gets the same two platform
            defaults every other stack gets, so a card claiming "Nothing." would
            be describing the exact case those defaults were added for. */}
        {plan.fileChecked ? null : (
          <MetaStrip>
            This stack&rsquo;s file is in its repository, so the checks that need
            to read it — whether the services a domain names exist, and how they
            write their labels — are <strong>not</strong> included below.
          </MetaStrip>
        )}
        <Card.Body className="flex flex-col gap-2.5">
          {plan.items.map((item, index) => (
            <PlanRow key={`${item.title}-${index}`} item={item} />
          ))}
        </Card.Body>
      </Card>

      <ConvertedFileCard compose={compose} />
    </>
  );
}
