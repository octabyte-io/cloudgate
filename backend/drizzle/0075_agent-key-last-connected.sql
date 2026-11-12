-- What an Agent key's MCP client last said about itself: when it last
-- connected, its self-reported client name and version, and the revision it
-- was served at. Self-reported and never read by any decision; columns of
-- their own because `metadata` is writable by the key's holder.
ALTER TABLE "apikey" ADD COLUMN "last_connected_at" timestamp;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "last_client_name" text;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "last_client_version" text;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "last_protocol_revision" text;