import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { GutterMark } from "@/components/console/gutter-mark";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/error-message";
import type {
  ComposeDetail,
  UpdateComposeInput,
} from "@/lib/api/endpoints/compose";
import { usePermission } from "@/lib/auth/use-permission";

import { isolationPreview } from "../converted/converted-plan";
import { useComposeDomains } from "../domains/use-compose-domains";
import { COMPOSE_UPDATE_REFUSAL } from "../use-compose";

/**
 * The one rewrite toggle this backend has, and what it will change.
 *
 * **The phase brief asks for the toggle to state its effect before it is switched
 * on, and that is the right shape for this control specifically** — it is not a
 * preference, it is an edit to the file the platform is about to apply, and the two
 * things it changes are invisible from anywhere else in the console:
 *
 * With isolation **off** (the default), `addDomainsToComposeSpec` joins every
 * routed service to the shared `cloudgate-network`, declares that network
 * `external: true` at the file's root, and — for Docker Compose — adds a
 * `traefik.docker.network` label so Traefik knows which address to use (a Swarm
 * stack is routed by a Traefik config file instead). That shared network is also how a stack
 * reaches everything else Cloudgate runs — a managed database answers on it by its own `appName`.
 *
 * With isolation **on**, the same three edits happen against a network of this
 * stack's own rather than the shared one: the deploy creates an attachable
 * network named after the stack and connects the Traefik container to it, and
 * the rewrite joins the routed services to *that*, declares it external, and
 * labels them with it. So domains work while nothing else on the shared network
 * is reachable by name. And with no domains configured at all, none of those
 * three edits happens: nothing joins a network and the file's root is left
 * alone.
 *
 * **Both lists end by pointing at the two platform defaults, and that clause is
 * not padding**. Every deploy now
 * writes a `logging:` block, and a `docker-compose` one a `restart:` policy, into
 * the converted file for each service that does not declare its own — including
 * the isolated, domain-less case this card used to describe as "applied byte for
 * byte as it is written", which was the *only* shape those defaults used to miss
 * and is exactly the shape they were added to reach. A list that reads as a
 * complete account of the rewrite may not omit them; the Converted tab names
 * them in full, and this card only has to stop saying they are not there.
 *
 * **The list is derived, and it used to be two fixed arrays**
 * Neither looked
 * at the stack, so a stack *with* a domain, switched on, was told the file's own
 * networks were left alone and that with no domains configured nothing but the
 * defaults changed — while the deploy that followed joined the routed service to
 * the new network, declared it external at the root and labelled it. The rewrite
 * turns on the domains and the flag and on nothing else, so this card now asks
 * `isolationPreview` the same question the Converted tab asks, off the same two
 * inputs. That is why the domains are fetched here at all.
 *
 * So the trade is one sentence long and it is the sentence that matters: isolation
 * buys a stack that cannot collide with or reach the rest of the platform.
 *
 * It is a `Switch` with its own Save rather than an instant toggle, because the
 * change only means anything on the next Deployment and saving it silently on click
 * would imply otherwise.
 *
 * **Save is off, with the reason, for a role the save would be refused**
 * `PATCH /compose/:id` runs `findOwnedForUpdate`, which asks for
 * `service: ['update']`. The switch and its preview stay live — what the toggle
 * would change is worth reading whoever is allowed to make it.
 */
export function IsolationCard({
  compose,
  save,
}: {
  compose: ComposeDetail;
  save: (input: UpdateComposeInput) => Promise<unknown>;
}) {
  const [isolated, setIsolated] = useState(compose.isolatedDeployment);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const permission = usePermission({ service: ["update"] });
  const roleRefusalId = useId();

  const changed = isolated !== compose.isolatedDeployment;
  const swarm = compose.composeType === "stack";
  // `?? null` rather than `?? 0`: zero domains is the answer that changes every
  // line, so reading a pending query as zero would show the wrong list for as
  // long as the request takes.
  const domains = useComposeDomains(compose.composeId);
  const preview = isolationPreview({
    appName: compose.appName,
    swarm,
    isolated,
    wasIsolated: compose.isolatedDeployment,
    domainCount: domains.data?.length ?? null,
  });

  return (
    <Card>
      <Card.Header
        title="Network isolation"
        sub="Whether this stack shares Cloudgate's network with everything else."
        headingLevel={2}
      />
      <Card.Body className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-lede">
            <p className="text-body font-medium text-tx">
              Deploy onto its own network
            </p>
            <p className="mt-0.5 text-meta text-tx-2">
              An attachable{swarm ? " overlay" : ""} network named{" "}
              <span className="font-mono">{compose.appName}</span>, with the
              Traefik container connected to it so domains still work.
            </p>
          </div>
          <Switch
            checked={isolated}
            onCheckedChange={setIsolated}
            aria-label="Deploy onto its own network"
          />
        </div>

        <div className="rounded-lg border border-line bg-panel-2 px-3.5 py-3">
          <p className="text-meta font-medium text-tx-2">
            {changed ? "Switching this on the next Deployment will:" : "As it is now, deploying:"}
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {preview.map((line) => (
              <li key={line.text} className="flex gap-2">
                <span className="mt-0.5 flex-none">
                  <GutterMark change={line.change} />
                </span>
                <span className="min-w-0 text-meta text-tx-2 wrap-anywhere">
                  {line.text}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {isolated ? (
          <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-meta text-tx">
            <strong className="font-medium">
              An isolated stack cannot reach the rest of the platform by name.
            </strong>{" "}
            A managed database, or another stack, answers on{" "}
            <span className="font-mono">cloudgate-network</span> — off it, those
            hostnames do not resolve. Anything this stack depends on has to be
            inside its own file, or reachable over a published port.
          </p>
        ) : null}

        {refusal ? (
          <p className="text-meta text-bad">{refusal}</p>
        ) : null}
        {permission.allowed ? null : (
          <p id={roleRefusalId} className="text-meta text-tx-2">
            {COMPOSE_UPDATE_REFUSAL}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="pri"
            disabled={!permission.allowed || !changed || saving}
            title={permission.allowed ? undefined : COMPOSE_UPDATE_REFUSAL}
            aria-describedby={permission.allowed ? undefined : roleRefusalId}
            aria-busy={saving || undefined}
            onClick={async () => {
              if (!permission.allowed) return;
              setRefusal(null);
              setSaving(true);
              try {
                await save({ isolatedDeployment: isolated });
                toast.done(
                  isolated
                    ? "Isolation is on."
                    : "Isolation is off.",
                  {
                    description:
                      "The next Deployment applies it. Nothing changes on the running stack until then.",
                  },
                );
              } catch (error) {
                setRefusal(errorMessage(error));
                setIsolated(compose.isolatedDeployment);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
          {changed ? (
            <Button
              onClick={() => {
                setIsolated(compose.isolatedDeployment);
                setRefusal(null);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </Card.Body>
    </Card>
  );
}
