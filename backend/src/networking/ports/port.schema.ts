import { relations } from 'drizzle-orm';
import { integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { application } from '../../applications/application.schema';
import { nanoidPk } from '../../db/columns';

// An application's published ports.

export const protocolTypeEnum = pgEnum('protocol_type', ['tcp', 'udp']);

export type ProtocolType = (typeof protocolTypeEnum.enumValues)[number];

export const publishModeTypeEnum = pgEnum('publish_mode_type', [
  'ingress',
  'host',
]);

export type PublishModeType = (typeof publishModeTypeEnum.enumValues)[number];

export const port = pgTable('port', {
  portId: nanoidPk('port_id'),
  publishedPort: integer('published_port').notNull(),
  publishMode: publishModeTypeEnum('publish_mode').notNull().default('host'),
  targetPort: integer('target_port').notNull(),
  protocol: protocolTypeEnum('protocol').notNull(),
  applicationId: text('application_id')
    .notNull()
    .references(() => application.applicationId, { onDelete: 'cascade' }),
});

export const portRelations = relations(port, ({ one }) => ({
  application: one(application, {
    fields: [port.applicationId],
    references: [application.applicationId],
  }),
}));

export type Port = typeof port.$inferSelect;
