"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { DeleteResourceModal } from "@/components/console/delete-resource-modal";
import { EmptyState } from "@/components/console/empty-state";
import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { ResourceFormModal } from "@/components/console/resource-form-modal";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ChannelType, NotificationChannel } from "@/lib/api/endpoints/notifications";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";

import { useNotifications } from "../use-integrations";
import { channelColumns, channelSpec } from "./channel-spec";
import { CHANNELS } from "./channels";

/**
 * The channel list, and the one place a channel's *kind* is chosen.
 *
 * **Why this is not a plain `ResourceList`.** That component's add button opens
 * one form, because its four F10 lists each have one shape. Here the shape is
 * chosen first: twelve kinds, one grid, then the shared form for whichever was
 * picked. Everything after that grid *is* `ResourceList`'s machinery —
 * `ResourceFormModal` and `DeleteResourceModal`, unmodified — so the only thing
 * this file adds is the choice, and the list stays one table over all twelve.
 *
 * The kind is fixed once saved: a channel's connection lives in its own table
 * behind its own foreign key and no route moves one between them. So the edit
 * dialog has no kind picker, and changing kind is remove and add.
 */
export function NotificationsSection() {
  const invalidate = useInvalidate();
  const query = useNotifications();
  const arrival = useArrival(query.isPending);
  // The three statements `/notifications` asks of its writes. This
  // screen draws its own table rather than `ResourceList`'s — the add is a
  // picker first — so it reads them itself, as `ResourceList` would.
  const canCreate = usePermission({ notification: ["create"] });
  const canUpdate = usePermission({ notification: ["update"] });
  const canRemove = usePermission({ notification: ["delete"] });

  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<ChannelType | null>(null);
  const [opening, setOpening] = useState(0);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const [removing, setRemoving] = useState<NotificationChannel | null>(null);

  const rows = query.data ?? [];

  function add(type: ChannelType) {
    setPicking(false);
    setOpening((n) => n + 1);
    setAdding(type);
  }

  const columns = [
    ...channelColumns,
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-0",
      cell: (row: NotificationChannel) => (
        <span className="inline-flex justify-end gap-1.5 whitespace-nowrap">
          <Button
            size="xs"
            disabled={!canUpdate.allowed}
            title={canUpdate.allowed ? undefined : EDIT_REFUSAL}
            onClick={() => canUpdate.allowed && setEditing(row)}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="dngr"
            disabled={!canRemove.allowed}
            title={canRemove.allowed ? undefined : REMOVE_REFUSAL}
            onClick={() => canRemove.allowed && setRemoving(row)}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <Card>
        <Card.Header
          title="Notification channels"
          sub="Where Cloudgate tells you something happened. A channel subscribes to the events it wants; nothing is sent to a channel with none ticked."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              variant="pri"
              disabled={!canCreate.allowed}
              title={canCreate.allowed ? undefined : ADD_REFUSAL}
              onClick={() => canCreate.allowed && setPicking(true)}
            >
              <Icon name="plus" size={14} />
              Add a channel
            </Button>
          }
        />

        {/* A refusal is answered before an empty list is even considered — a 403
            rendered as "no channels" is a confident claim about this
            Organization's setup made because a request failed (F09's first
            defect, three times over). */}
        {query.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">{errorMessage(query.error)}</p>
          </Card.Body>
        ) : query.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <Card.Body flush className={arrival}>
            <DataTable
              label="Notification channels"
              rows={rows}
              columns={columns}
              getRowId={(row) => row.notificationId}
              defaultSort={{ id: "name", dir: "asc" }}
              empty={
                <EmptyState
                  icon="mail"
                  title="No channels yet"
                  action={
                    <Button
                      size="sm"
                      variant="pri"
                      disabled={!canCreate.allowed}
                      title={canCreate.allowed ? undefined : ADD_REFUSAL}
                      onClick={() => canCreate.allowed && setPicking(true)}
                    >
                      Add a channel
                    </Button>
                  }
                >
                  Add one and Cloudgate can tell you a Deployment failed without
                  you having to be looking at this screen.
                </EmptyState>
              }
            />
          </Card.Body>
        )}
      </Card>

      <Modal open={picking} onOpenChange={setPicking} wide>
        <Modal.Header
          title="Add a channel"
          description="Pick where the messages should go. Each one asks for its own credentials next; the events it subscribes to are the same set whichever you choose."
        />
        <Modal.Body>
          <PickGrid label="Notification channels">
            {CHANNELS.map((channel) => (
              <PickCard
                key={channel.type}
                icon={channel.icon}
                title={channel.label}
                description={channel.blurb}
                onClick={() => add(channel.type)}
              />
            ))}
          </PickGrid>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
        </Modal.Footer>
      </Modal>

      {/* Keyed on every opening, so `useApiForm`'s one read of `defaultValues`
          happens against a fresh mount — F09's add-a-domain defect. The key
          carries the *kind* too, since picking Slack and then Telegram is two
          different sets of fields. */}
      {adding ? (
        <ResourceFormModal
          key={`add-${adding}-${opening}`}
          spec={channelSpec(adding, invalidate.notifications)}
          row={null}
          open
          onOpenChange={(next) => {
            if (!next) setAdding(null);
          }}
        />
      ) : null}

      {editing ? (
        <ResourceFormModal
          key={editing.notificationId}
          spec={channelSpec(editing.notificationType, invalidate.notifications)}
          row={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
        />
      ) : null}

      <DeleteResourceModal
        spec={channelSpec(
          removing?.notificationType ?? "slack",
          invalidate.notifications,
        )}
        row={removing}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      />
    </>
  );
}

const ADD_REFUSAL = roleRefusal("add a notification channel");
const EDIT_REFUSAL = roleRefusal("change this notification channel");
const REMOVE_REFUSAL = roleRefusal("remove this notification channel");
