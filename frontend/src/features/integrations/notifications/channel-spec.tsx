import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import type { Column } from "@/components/console/data-table";
import type {
  ResourceSpec,
  TestSecret,
} from "@/components/console/resource-spec";
import { Icon } from "@/lib/design/icons";
import {
  channelConnection,
  notificationsApi,
  EVENT_FLAGS,
  type EventFlag,
  type NotificationChannel,
} from "@/lib/api/endpoints/notifications";

import { channelOf, CHANNELS, EVENT_FIELDS, type ChannelValues } from "./channels";
import { example } from "@/components/console/form-spec";

/**
 * **One `ResourceSpec`, built from a descriptor.**
 *
 * This is the file the phase brief is about. Twelve channels, one form, one test
 * button, one delete confirmation — and the only thing that differs between them
 * is the `ChannelDescriptor` this is handed. There is no `switch` on a channel
 * name here or anywhere below `channels.ts`.
 *
 * The three shared pieces it adds around the descriptor's fields:
 *
 * 1. **`name`**, which is on the base `notification` row and means the same
 *    thing on all twelve.
 * 2. **The eight event switches**, which are also on the base row and are part
 *    of the *create* body rather than a second call.
 * 3. **A test**, which every channel has twice over: `POST /<channel>/test`
 *    takes the connection fields, and `POST /:id/test` names a saved row and
 *    lets the server read its credential
 * One button,
 *    and the secret boxes decide which route runs — see `test` below.
 */

const baseSchema = {
  name: z.string().min(1, "A channel needs a name."),
  /**
   * Which saved channel this form is editing, or `""` on an add. Not a control —
   * no `FieldSpec` names it, so nothing renders it, and neither `create` nor
   * `update` puts it in a body. It is in the values because that is all
   * `test.blocked` and `test.run` are handed.
   */
  notificationId: z.string(),
  ...Object.fromEntries(EVENT_FLAGS.map((flag) => [flag, z.boolean()])),
};

export const channelColumns: Column<NotificationChannel>[] = [
  {
    id: "name",
    head: "Name",
    tone: "key",
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (row) => row.name,
  },
  {
    id: "type",
    head: "Channel",
    cell: (row) => {
      const descriptor = channelOf(row.notificationType);
      return (
        <span className="inline-flex items-center gap-1.75 whitespace-nowrap">
          <Icon name={descriptor.icon} size={14} className="text-tx-3" />
          {descriptor.label}
        </span>
      );
    },
    compare: (a, b) =>
      channelOf(a.notificationType).label.localeCompare(
        channelOf(b.notificationType).label,
      ),
  },
  {
    id: "target",
    head: "Where it goes",
    tone: "muted",
    cell: (row) => {
      const summary = channelOf(row.notificationType).summary(
        channelConnection(row),
      );
      // A channel whose only field is a credential has nothing to show, and
      // that is a statement rather than a gap: the URL is not something this
      // console holds after you save it.
      return summary || <Dash word="Not shown — it is a credential" />;
    },
  },
  {
    id: "events",
    head: "Events",
    cell: (row) => {
      const on = EVENT_FLAGS.filter((flag) => row[flag]).length;
      // "Nothing" rather than "0 of 8": a channel that is configured and silent
      // is the one state on this table worth reading twice.
      if (on === 0) return <Chip>Nothing</Chip>;
      return (
        <span className="whitespace-nowrap text-tx-2">
          {on} of {EVENT_FLAGS.length}
        </span>
      );
    },
    compare: (a, b) =>
      EVENT_FLAGS.filter((flag) => a[flag]).length -
      EVENT_FLAGS.filter((flag) => b[flag]).length,
  },
];

/**
 * The spec for one channel kind.
 *
 * `type` is the kind being added, or the kind of the row being edited — the two
 * cannot differ, because a saved channel's type is not editable: the connection
 * lives in its own table with its own foreign key, and there is no route that
 * moves one. Changing kind is remove and add, which is what the pick grid is.
 */
export function channelSpec(
  type: NotificationChannel["notificationType"],
  onDone: () => Promise<unknown>,
): ResourceSpec<NotificationChannel, ChannelValues> {
  const descriptor = channelOf(type);

  const object = z.object({ ...baseSchema, ...descriptor.shape });
  const schema = (
    descriptor.check ? object.superRefine(descriptor.check as never) : object
  ) as unknown as ResourceSpec<
    NotificationChannel,
    ChannelValues
  >["schema"];

  return {
    noun: "channel",
    plural: "channels",
    title: "Notification channels",
    lede: `${descriptor.label}. ${descriptor.blurb}`,
    icon: descriptor.icon,
    addLabel: `Add ${descriptor.label}`,
    emptyTitle: "No channels yet",
    emptyBody:
      "Add one and Cloudgate can tell you a Deployment failed without you having to be looking at this screen.",
    tableLabel: "Notification channels",

    columns: channelColumns,
    getRowId: (row) => row.notificationId,
    rowName: (row) => row.name,
    defaultSort: { id: "name", dir: "asc" },

    schema,
    fields: [
      {
        name: "__connection",
        label: `How to reach ${descriptor.label}`,
        kind: "section",
        hint: descriptor.blurb,
      },
      {
        name: "name",
        label: "Name",
        kind: "text",
        placeholder: example("Ops on-call"),
        hint: "What this channel is called in Cloudgate. Only you see it.",
      },
      ...descriptor.fields,
      ...EVENT_FIELDS,
    ],

    toDefaults: (row) => {
      const flags = Object.fromEntries(
        EVENT_FLAGS.map((flag) => [flag, row ? Boolean(row[flag]) : false]),
      ) as Record<EventFlag, boolean>;
      return {
        name: row?.name ?? "",
        notificationId: row?.notificationId ?? "",
        ...flags,
        ...descriptor.toDefaults(row ? channelConnection(row) : null),
      } as ChannelValues;
    },

    /**
     * **One button, two routes.** Which one runs is decided by the secret boxes,
     * because that is the same thing the person is already deciding:
     *
     * - **All of them filled in** — the test sends through the values in the
     *   form. The create case, and the only one that can work before the row
     *   exists.
     * - **All of them empty, on an edit** — the test sends through the channel
     *   *as it is saved*. This is the operational question: is the alerting
     *   configured months ago still working?
     * - **Some filled in, on an edit** — refused, and it says which are missing.
     *   Neither answer would be the one being asked for: sending the typed ones
     *   would 400 on the blank one, and quietly testing the saved credential
     *   would report a pass for something that was not tried.
     *
     * On an **add** there is nothing saved to fall back on, so the only question
     * is whether the form holds a credential the channel cannot work without.
     * An **optional** one left empty is an answer rather than a gap
     * a public ntfy
     * topic takes no access token, and the test that proves it goes through with
     * no `accessToken` in the body at all.
     */
    test: {
      label: "Send a test",
      secrets: descriptor.secrets,
      blocked: (values, credentials) => {
        if (!savedId(values)) {
          if (credentials.needed.length === 0) return null;
          return `A test needs ${nameThem(credentials.needed)} filled in. Nothing is saved yet, so there is nothing else to send through.`;
        }
        if (credentials.blank.length === 0) return null;
        if (credentials.blank.length === descriptor.secrets.length) return null;
        return `Fill in ${nameThem(credentials.blank)} as well to test what is typed here, or clear ${credentials.blank.length === descriptor.secrets.length - 1 ? "the other" : "the others"} to test this channel as it is saved.`;
      },
      run: async (values, credentials) => {
        const saved = savedId(values);
        // Nothing saved to fall back on, or every box filled in: the probe goes
        // through what is on screen. An empty *optional* box is simply left out
        // of the body — which is exactly the request a public topic wants.
        if (!saved || credentials.blank.length === 0) {
          await notificationsApi.test(type, descriptor.toBody(values));
          return `${descriptor.label} accepted the message, sent with what is typed here. Go and look for it.`;
        }
        // The stored connection is what the probe went through, so anything
        // edited and not yet saved was not part of it. Said in the answer, which
        // is the moment it can be believed.
        await notificationsApi.testSaved(saved);
        return `${descriptor.label} accepted the message, sent with the credential Cloudgate already holds. Go and look for it — anything changed in this dialog was not part of the test.`;
      },
    },

    // What `/notifications` asks of each write — `ResourceList` turns the
    // control off for a role without it.
    permissions: {
      create: { notification: ["create"] },
      update: { notification: ["update"] },
      remove: { notification: ["delete"] },
    },
    create: async (values) => {
      await notificationsApi.create(type, {
        name: values.name,
        ...eventFlags(values),
        ...descriptor.toBody(values),
      });
      await onDone();
    },

    update: async (row, values) => {
      const body = descriptor.toBody(values);
      // An empty credential is *omitted*, which is what "leave it blank to keep
      // the saved one" has to mean — `toBody` already returns `undefined` for
      // one, and `JSON.stringify` drops it. Stated here because F10 paid for the
      // opposite mistake: `undefined` disappearing was a bug there and is the
      // mechanism here.
      await notificationsApi.update(type, row.notificationId, {
        name: values.name,
        ...eventFlags(values),
        ...body,
      });
      await onDone();
    },

    remove: async (row) => {
      await notificationsApi.remove(row.notificationId);
      await onDone();
    },

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.name}</strong> stops
        receiving anything, and the credentials Cloudgate holds for it are
        deleted. Nothing already delivered is affected, and{" "}
        {row.notificationType === "custom" ? "the endpoint" : "the webhook"} is
        untouched at the other end.
      </>
    ),
  };
}

/**
 * The saved row's id, or `""` on an add.
 *
 * `ChannelValues` is open (`Record<string, unknown>`) so the twelve descriptors
 * can each name their own fields, which means every read off it is `unknown`.
 */
function savedId(values: ChannelValues): string {
  return typeof values.notificationId === "string" ? values.notificationId : "";
}

/**
 * "the user key and the API token" — the credentials, as a sentence would say
 * them. Two is the most any of the twelve has, so `and` is the whole grammar.
 */
function nameThem(secrets: TestSecret[]): string {
  return secrets.map((secret) => secret.label).join(" and ");
}

/** The eight flags, off the form and onto the body. */
function eventFlags(values: ChannelValues): Record<string, boolean> {
  return Object.fromEntries(
    EVENT_FLAGS.map((flag) => [flag, Boolean(values[flag])]),
  );
}

/** Every kind, for the pick grid. Declaration order is display order. */
export const CHANNEL_CHOICES = CHANNELS;
