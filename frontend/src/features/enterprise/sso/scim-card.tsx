import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { EmptyState } from "@/components/console/empty-state";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { ScimProvider, ScimTokenIssued } from "@/lib/api/endpoints/scim";
import { timeExact } from "@/lib/format/time";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import type { Stopped } from "../business-plan";
import { ScimNameModal } from "./scim-name-modal";
import { ScimTokenModal } from "./scim-token-modal";
import {
  useCreateScimProvider,
  useRemoveScimProvider,
  useScimProviders,
} from "./use-sso";

/**
 * The identity providers allowed to create and deactivate members for you.
 *
 * ## The token exists once
 *
 * `POST /scim/providers` answers `{ scimToken, providerId }` and that is the
 * only readable copy there will ever be: the listing projects to
 * `{ id, providerId, organizationId }`, the column is encrypted at rest, and no
 * route regenerates one. Replacing a token means deleting the provider and
 * creating it again, which revokes the old one and stops whatever is
 * provisioning with it.
 *
 * So the create flow is **two states in one dialog**, the treatment F16 gave an
 * API key and an invitation link: name it, then hold the value with a copy
 * button and a sentence saying that closing loses it.
 *
 * ## The id is instance-wide, and the refusal says so
 *
 * `generateToken` scans **every** row before calling the plugin, not only this
 * Organization's — `providerId` is globally unique, it is packed into the bearer
 * token between colons, and it becomes the `account.providerId` a provisioned
 * user is linked by. Left to the plugin, a colliding id would *replace* the
 * existing row and silently revoke a token somebody else is using. So "already
 * exists" can be about an Organization you cannot see, and the dialog says the
 * id has to be unique across the instance rather than blaming your own list.
 *
 * ## Kept but stopped
 *
 * Below the paid features SCIM refuses every add and still removes people.
 * The providers are listed with "Removing only", Add is off, Remove
 * is on, and each row shows the last add it refused, when and for whom, so an
 * admin who added someone in the directory can see why they never arrived.
 */
export function ScimCard({ stopped = null }: { stopped?: Stopped | null }) {
  const providers = useScimProviders();
  const create = useCreateScimProvider();
  const remove = useRemoveScimProvider();

  const [naming, setNaming] = useState(false);
  const [issued, setIssued] = useState<ScimTokenIssued | null>(null);
  const [deleting, setDeleting] = useState<ScimProvider | null>(null);

  const arrival = useArrival(providers.isPending);
  if (providers.isPending) {
    return <SectionPending title="Directory provisioning (SCIM)" rows={2} />;
  }
  if (providers.error) {
    return (
      <SectionFailed
        title="Directory provisioning (SCIM)"
        error={providers.error}
      >
        Managing SCIM providers needs an owner or admin role in this
        Organization, and an enterprise license.
      </SectionFailed>
    );
  }

  const rows = providers.data ?? [];

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <Card>
        <Card.Header
          title="Directory provisioning (SCIM)"
          sub="Let an identity provider create, update and deactivate members here."
          headingLevel={2}
          actions={
            <Button
              type="button"
              size="sm"
              variant="pri"
              disabled={stopped !== null}
              title={stopped?.reason}
              onClick={() => setNaming(true)}
            >
              Add a provider
            </Button>
          }
        />
        <Card.Body className={rows.length === 0 ? undefined : "grid gap-1.5"}>
          {rows.length === 0 ? (
            <EmptyState icon="users" title="No SCIM providers yet">
              Add a provider and joiners and leavers in your directory become members
              here without anyone sending an invitation.
            </EmptyState>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2 py-2 pr-2 pl-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.75">
                    <span className="min-w-0 truncate font-mono text-ui text-tx">
                      {row.providerId}
                    </span>
                    {stopped ? <Chip variant="warn">Removing only</Chip> : null}
                  </span>
                  <span className="block text-meta text-tx-3">
                    Its token was shown once, when it was created.
                  </span>
                  <LastRefusedAdd row={row} />
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="dngr"
                  onClick={() => setDeleting(row)}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </Card.Body>
      </Card>

      {naming ? (
        <ScimNameModal
          pending={create.isPending}
          onClose={() => setNaming(false)}
          onSubmit={async (providerId) => {
            const result = await create.mutateAsync(providerId);
            setNaming(false);
            setIssued(result);
          }}
        />
      ) : null}

      {issued ? (
        <ScimTokenModal issued={issued} onClose={() => setIssued(null)} />
      ) : null}

      {deleting ? (
        <Modal open onOpenChange={(next) => !next && setDeleting(null)}>
          <Modal.Header
            title={`Remove ${deleting.providerId}?`}
            description="Its token stops working immediately."
          />
          <Modal.Body className="grid gap-3">
            <div className="rounded-lg border border-warn-line bg-warn-tint p-3 text-ui text-tx">
              Whatever is provisioning with this token stops being able to. Your
              identity provider will start reporting failures until it is
              reconnected with a new one.
            </div>
            <p className="text-body text-tx-2">
              Members it already created stay exactly as they are — removing the
              provider revokes the credential, it does not undo the
              provisioning.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="dngr"
              disabled={remove.isPending}
              aria-busy={remove.isPending || undefined}
              onClick={async () => {
                try {
                  await remove.mutateAsync(deleting.providerId);
                  toast.done(`${deleting.providerId} removed.`);
                  setDeleting(null);
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Remove the provider
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * The last create or reactivation this provider pushed that SCIM refused for
 * want of the paid features, stored on the provider row. Nothing when
 * there was none.
 */
function LastRefusedAdd({ row }: { row: ScimProvider }) {
  if (!row.lastRefusedAddAt) return null;
  return (
    <span className="block text-meta text-tx-2" aria-label="Last refused add">
      Last refused add:{" "}
      <time dateTime={row.lastRefusedAddAt} className="num">
        {timeExact(row.lastRefusedAddAt)}
      </time>
      {row.lastRefusedAddEmail ? (
        <>
          {", "}
          <span className="font-mono text-tx">{row.lastRefusedAddEmail}</span>
        </>
      ) : null}
    </span>
  );
}
